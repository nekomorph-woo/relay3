export interface DiagnosisStep {
  name: string;
  state: 'ok' | 'failed' | 'skipped';
  detail: string;
}
export interface ConnectionDiagnosis {
  base: string;
  checkedAt: number;
  steps: DiagnosisStep[];
  advice: string[];
}
export function stationAddress(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('请输入完整地址，例如 http://192.168.1.8:42830');
  }
  if (url.protocol !== 'http:' || url.username || url.password)
    throw new Error('请输入不包含账号密码的局域网 HTTP 地址');
  const host = url.hostname;
  const bytes = host.split('.').map(Number);
  if (!(
    host === 'localhost' ||
    (bytes.length === 4 &&
      bytes.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) &&
      (bytes[0] === 127 ||
        bytes[0] === 10 ||
        (bytes[0] === 192 && bytes[1] === 168) ||
        (bytes[0] === 172 && bytes[1] >= 16 && bytes[1] <= 31)))
  ))
    throw new Error('请使用局域网 IPv4 地址');
  return url.origin;
}
export function pairingFailure(error: { status?: number; message?: string }) {
  if (error.status === 401)
    return '连接凭证或配对码无效。请在中转站查看新配对码；保留现有设备身份。';
  if (error.status === 409) return '设备或连接状态冲突。请使用原连接凭证，检查是否有另一窗口连接。';
  if (error.status === 429) return '配对尝试过于频繁，请稍后重试。';
  if (error.status) return `中转站拒绝配对（HTTP ${error.status}）：${error.message ?? '请求失败'}`;
  return '配对请求未完成。代理、防火墙或网络中断都有可能，请先运行连接检查。';
}
export async function diagnoseHttp(
  raw: string,
  expectedStationId?: string,
  signal?: AbortSignal,
  fetcher = fetch,
): Promise<ConnectionDiagnosis> {
  const report: ConnectionDiagnosis = { base: '', checkedAt: Date.now(), steps: [], advice: [] };
  try {
    report.base = stationAddress(raw);
    report.steps.push({ name: '地址', state: 'ok', detail: report.base });
  } catch (e: any) {
    report.steps.push({ name: '地址', state: 'failed', detail: e.message });
    return report;
  }
  try {
    const r = await fetcher(report.base + '/api/info', {
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])]),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    if (!r.body) throw new Error('中转站响应为空');
    const reader = r.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const c = await reader.read();
        if (c.done) break;
        size += c.value.length;
        if (size > 16384) throw new Error('中转站响应过大');
        chunks.push(c.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const info = JSON.parse(new TextDecoder().decode(bytes));
    if (info.app !== 'Relay3' || !info.running || typeof info.stationId !== 'string')
      throw new Error('目标未返回运行中的 Relay3 中转站身份');
    if (expectedStationId && info.stationId !== expectedStationId)
      throw new Error('地址对应的中转站身份已变化，请重新发现并确认后配对');
    report.steps.push({
      name: '中转站身份',
      state: 'ok',
      detail: `${info.name || 'Relay3'} · 服务正在运行`,
    });
    report.steps.push({
      name: '配对',
      state: 'skipped',
      detail: '检查不消耗配对码；点击连接才进行实际配对',
    });
  } catch (e: any) {
    if (signal?.aborted) throw e;
    report.steps.push({
      name: '中转站身份',
      state: 'failed',
      detail: e.message === 'Failed to fetch' ? '未获得 HTTP 响应' : e.message,
    });
    report.advice.push(
      '在中转站本机浏览器打开该地址的 /api/info，确认服务和地址。',
      '检查系统代理、Proxifier/Clash 的局域网直连规则，以及防火墙私有网络入站规则。',
    );
    report.advice.push('超时本身不能确定是防火墙；请同时检查网络隔离、路由与服务端口。');
  }
  return report;
}
export function diagnosisText(report: ConnectionDiagnosis) {
  return [
    'Relay3 连接检查',
    new Date(report.checkedAt).toLocaleString('zh-CN'),
    report.base,
    ...report.steps.map(
      (s) =>
        `${s.name}：${s.state === 'ok' ? '通过' : s.state === 'failed' ? '失败' : '未检查'} · ${s.detail}`,
    ),
    ...report.advice,
  ].join('\n');
}
