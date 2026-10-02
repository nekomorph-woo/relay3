import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { Session } from '../api';

type Probe = {
  state: 'checking' | 'ready' | 'unreachable' | 'changed';
  name?: string;
  online?: number;
};
export function SavedStations({
  stations,
  onJoin,
  busy,
}: {
  stations: Session[];
  onJoin: (base: string) => void;
  busy: boolean;
}) {
  const [results, setResults] = useState<Record<string, Probe>>({});
  const [revision, setRevision] = useState(0);
  const signature = JSON.stringify(stations.map(({ base, stationId }) => ({ base, stationId })));
  useEffect(() => {
    const targets: { base: string; stationId: string }[] = JSON.parse(signature);
    const controller = new AbortController();
    setResults(Object.fromEntries(targets.map((s) => [s.base, { state: 'checking' }])));
    let index = 0;
    async function worker() {
      while (index < targets.length && !controller.signal.aborted) {
        const station = targets[index++];
        let result: Probe = { state: 'unreachable' };
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(), 3500);
        try {
          const url = new URL(station.base);
          if (url.protocol !== 'http:' || url.username || url.password) throw new Error();
          // 探测不发送配对凭证，不加入中转站，也不改变原连接。
          const response = await fetch(url.origin + '/api/info', {
            signal: AbortSignal.any([controller.signal, timeout.signal]),
            credentials: 'omit',
            cache: 'no-store',
            redirect: 'error',
          });
          if (!response.ok) throw new Error();
          const info = await response.json();
          if (
            typeof info.name !== 'string' ||
            !info.name.trim() ||
            info.name.length > 240 ||
            typeof info.stationId !== 'string' ||
            !info.stationId ||
            info.running === false
          )
            throw new Error();
          result = {
            state: info.stationId === station.stationId ? 'ready' : 'changed',
            name: info.name,
            ...(Number.isInteger(info.onlineDevices) && info.onlineDevices >= 0
              ? { online: info.onlineDevices }
              : {}),
          };
        } catch {
          /* 超时、网络错误或非中转站响应显示未响应。 */
        } finally {
          clearTimeout(timer);
        }
        if (!controller.signal.aborted) setResults((old) => ({ ...old, [station.base]: result }));
      }
    }
    for (let n = 0; n < Math.min(4, targets.length); n++) void worker();
    return () => controller.abort();
  }, [signature, revision]);
  return (
    <div className="remembered">
      <div className="section-head">
        <h3>连接过的中转站</h3>
        <button
          type="button"
          className="station-probe-refresh"
          title="重新探测中转站"
          aria-label="重新探测中转站"
          onClick={() => setRevision((n) => n + 1)}
        >
          <RefreshCw size={16} />
        </button>
      </div>
      {stations.map((s) => {
        const result = results[s.base] ?? { state: 'checking' };
        return (
          <button
            type="button"
            className="button remembered-station"
            key={s.base}
            disabled={busy || result.state === 'changed'}
            onClick={() => onJoin(s.base)}
          >
            <span className="remembered-station-info">
              <strong>{result.name ?? s.stationName}</strong>
              <small>{s.base}</small>
            </span>
            <span className={`station-probe ${result.state}`} role="status">
              {result.state === 'checking'
                ? '探测中…'
                : result.state === 'ready'
                  ? `可连接${result.online !== undefined ? ` · ${result.online} 台在线` : ' · 旧版未提供在线数'}`
                  : result.state === 'changed'
                    ? '地址已更换中转站，请重新配对'
                    : '未响应'}
            </span>
          </button>
        );
      })}
      <small className="subtle">未响应可能是中转站未开启、地址已变化或网络不可达。</small>
    </div>
  );
}
