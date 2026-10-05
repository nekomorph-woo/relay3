import { ScrollArea } from './ScrollArea';
import { ScanEye, Radio, Unplug, Trash2, ArrowUpRight } from 'lucide-react';
import type { ClientConnection } from '../useConnections';
import type { Session } from '../api';
export const connectionLabels = {
  connecting: '连接中',
  connected: '已连接',
  reconnecting: '重连中',
  expired: '需重新配对',
};
export function ConnectedStations({
  connections,
  saved,
  activeId,
  busy,
  onSelect,
  onJoin,
  onDisconnect,
  onForget,
  onCheck,
}: {
  connections: Record<string, ClientConnection>;
  saved: Session[];
  activeId: string;
  busy: boolean;
  onSelect: (id: string) => void;
  onJoin: (base: string) => void;
  onDisconnect: (id: string) => void;
  onCheck?: (session: Session) => void;
  onForget: (id: string) => void;
}) {
  const stations = [...new Map(saved.map((s) => [s.stationId, s])).values()];
  return (
    <ScrollArea
      as="section"
      memoryKey="connected-stations"
      className="panel connected-stations"
      tabIndex={0}
      aria-label="中转站列表"
    >
      {!stations.length && <p className="subtle">还没有配对的中转站，连接后会保存在这里。</p>}
      {stations.map((saved) => {
        const connection = connections[saved.stationId];
        const session = connection?.session ?? saved;
        const transfers =
          connection?.hub?.transfers.filter((t) =>
            [
              'pending',
              'accepted',
              'uploading',
              'ready',
              'downloading',
              'awaiting-confirm',
            ].includes(t.status),
          ).length ?? 0;
        return (
          <article
            className="connected-station"
            key={session.stationId}
            data-scroll-id={session.stationId}
          >
            <Radio size={21} />
            <div className="connected-station-description">
              <strong>
                {session.stationName || '其他'}
                {activeId === session.stationId && <span className="badge">当前查看</span>}
              </strong>
              <div className="connection-metadata">
                <span className={`badge ${connection?.status === 'connected' ? 'positive' : ''}`}>
                  {connection ? connectionLabels[connection.status] : '已断开'}
                </span>
                <small>{session.base}</small>
              </div>
              {connection && (
                <small>
                  {transfers} 项传输 · {connection.hub?.chatUnread ?? 0} 条未读
                </small>
              )}
            </div>
            <div className="actions">
              {onCheck && (
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() => onCheck(session)}
                >
                  <ScanEye size={16} />
                  检查连接
                </button>
              )}
              {connection ? (
                <>
                  <button
                    type="button"
                    className="button"
                    aria-label={`查看${session.stationName}`}
                    onClick={() => onSelect(session.stationId)}
                  >
                    <ArrowUpRight size={16} />
                    查看
                  </button>
                  <button
                    type="button"
                    className="button"
                    aria-label={`断开${session.stationName}`}
                    disabled={busy}
                    onClick={() => onDisconnect(session.stationId)}
                  >
                    <Unplug size={16} />
                    断开
                  </button>
                  {connection.status === 'expired' && (
                    <button type="button" className="button" onClick={() => onJoin(session.base)}>
                      重新配对
                    </button>
                  )}
                </>
              ) : (
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() => onJoin(session.base)}
                >
                  连接
                </button>
              )}
              <button
                type="button"
                className="button"
                aria-label={`忘记配对${session.stationName}`}
                disabled={busy}
                onClick={() => onForget(session.stationId)}
              >
                <Trash2 size={16} />
              </button>
            </div>
          </article>
        );
      })}
    </ScrollArea>
  );
}
