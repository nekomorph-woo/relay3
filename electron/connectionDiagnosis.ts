import { createConnection } from 'node:net';
import { networkInterfaces } from 'node:os';
import { diagnoseHttp, stationAddress, type ConnectionDiagnosis } from '../src/connectionDiagnosis';
export async function diagnoseConnection(
  raw: string,
  expected?: string,
  fetcher = fetch,
): Promise<ConnectionDiagnosis> {
  const base = stationAddress(raw),
    url = new URL(base);
  const tcp = await new Promise<{ ok: boolean; detail: string }>((resolve) => {
    const socket = createConnection({ host: url.hostname, port: Number(url.port || 80) });
    const finish = (ok: boolean, detail: string) => {
      socket.destroy();
      resolve({ ok, detail });
    };
    socket.setTimeout(3000);
    socket.once('connect', () => finish(true, `端口 ${url.port || 80} 可达`));
    socket.once('timeout', () => finish(false, 'TCP 连接超时，原因尚不能确定'));
    socket.once('error', (e: NodeJS.ErrnoException) =>
      finish(
        false,
        e.code === 'ECONNREFUSED'
          ? '目标拒绝连接，请确认中转站已开启及端口正确'
          : `TCP 未连通（${e.code ?? '网络错误'}）`,
      ),
    );
  });
  const report = await diagnoseHttp(base, expected, undefined, fetcher);
  report.steps.splice(1, 0, {
    name: 'TCP 端口',
    state: tcp.ok ? 'ok' : 'failed',
    detail: tcp.detail,
  });
  const interfaces = Object.values(networkInterfaces())
    .flat()
    .filter((n) => n?.family === 'IPv4' && !n.internal)
    .map((n) => `${n!.address}/${n!.netmask}`);
  report.steps.splice(1, 0, {
    name: '本机网卡',
    state: interfaces.length ? 'ok' : 'failed',
    detail: interfaces.join('、') || '没有活动的 IPv4 网卡',
  });
  if (report.steps.some((s) => s.state === 'failed'))
    report.advice.push(
      'Electron 已使用直接连接；系统层代理仍可能截获访问。IP 地址访问不涉及域名解析。',
    );
  return report;
}
