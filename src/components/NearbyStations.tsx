import { useEffect, useState } from 'react';
import { Check, Radio, RefreshCw } from 'lucide-react';
import { DeviceTag } from './DeviceTag';
import type { DiscoverySnapshot, DiscoveredStation } from '../discoveryTypes';

export function NearbyStations({
  selectedBase,
  busy,
  onSelect,
}: {
  selectedBase: string;
  busy: boolean;
  onSelect: (station: DiscoveredStation) => void;
}) {
  const [snapshot, setSnapshot] = useState<DiscoverySnapshot>({ stations: [] });
  const [waiting, setWaiting] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const settle = setTimeout(() => setWaiting(false), 6000);
    async function poll(first = false) {
      try {
        const next = first
          ? await window.relay3!.startDiscovery()
          : await window.relay3!.discoverySnapshot();
        if (active) setSnapshot(next);
      } catch {
        if (active) setSnapshot({ stations: [], error: '无法发现中转站，请手动输入地址。' });
      }
      if (active) timer = setTimeout(() => void poll(), 1000);
    }
    void poll(true);
    return () => {
      active = false;
      clearTimeout(timer);
      clearTimeout(settle);
      void window.relay3!.stopDiscovery().catch(() => {});
    };
  }, []);

  async function refresh() {
    setRefreshing(true);
    try {
      setSnapshot(await window.relay3!.refreshDiscovery());
    } catch {
      setSnapshot({ stations: [], error: '无法发现中转站，请手动输入地址。' });
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <section className="nearby-stations" aria-label="附近的中转站">
      <div className="section-head">
        <h3>
          <Radio size={16} />
          附近的中转站
        </h3>
        <button
          type="button"
          className="station-probe-refresh"
          aria-label="刷新附近中转站"
          disabled={refreshing}
          onClick={() => void refresh()}
        >
          <RefreshCw size={16} />
        </button>
      </div>
      <div className="nearby-station-list">
        {snapshot.stations.map((station) => (
          <button
            key={station.stationId}
            type="button"
            className={`nearby-station ${selectedBase === station.base ? 'selected' : ''}`}
            disabled={busy || station.state !== 'ready'}
            aria-pressed={selectedBase === station.base}
            onClick={() => onSelect(station)}
          >
            <span className="nearby-station-info">
              <strong>
                {station.name}
                <DeviceTag platform={station.platform} />
              </strong>
              <small>{station.base}</small>
            </span>
            <span className="nearby-station-state">
              {selectedBase === station.base && station.state === 'ready' && <Check size={15} />}
              {station.state === 'ready'
                ? `${station.onlineDevices} 台在线`
                : station.state === 'checking'
                  ? '验证中…'
                  : '不可达'}
            </span>
          </button>
        ))}
        {!snapshot.stations.length && (
          <p className="nearby-station-empty" role="status">
            {snapshot.error ??
              (waiting ? '正在发现局域网中转站…' : '未发现中转站，请确认已开启并连接同一局域网。')}
          </p>
        )}
      </div>
      {(snapshot.stations.some((s) => s.state === 'unreachable') ||
        (snapshot.error && snapshot.stations.length > 0)) && (
        <small className="subtle">
          {snapshot.error ?? '发现了广播但无法访问，请检查防火墙及代理的局域网直连规则。'}
        </small>
      )}
    </section>
  );
}
