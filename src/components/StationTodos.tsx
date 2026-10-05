import { BellOff, MessageSquare, FileDown } from 'lucide-react';
import { useState } from 'react';
import { stationTodos } from '../todos';
import { date, stored, save } from '../api';
import type { ClientConnection } from '../useConnections';
export function StationTodos({
  connections,
  onOpen,
}: {
  connections: Record<string, ClientConnection>;
  onOpen: (id: string, page: 'chat' | 'transfer', packageId?: string) => void;
}) {
  const [muted, setMuted] = useState(stored<string[]>('relay3-muted-stations', []));
  const todos = stationTodos(connections);
  return (
    <div className="station-todos">
      {todos.length ? (
        todos.map((s) => (
          <section key={s.stationId}>
            <header>
              <strong>{s.name}</strong>
              {!s.connected && <span className="badge">等待连接</span>}
              <button
                aria-label={`静音${s.name}`}
                aria-pressed={muted.includes(s.stationId)}
                onClick={() => {
                  const next = muted.includes(s.stationId)
                    ? muted.filter((id) => id !== s.stationId)
                    : [...muted, s.stationId];
                  setMuted(next);
                  save('relay3-muted-stations', next);
                }}
              >
                <BellOff size={15} />
                {muted.includes(s.stationId) ? '已静音' : '静音'}
              </button>
            </header>
            {s.unread > 0 && (
              <button
                className="todo-row"
                disabled={!s.connected}
                onClick={() => onOpen(s.stationId, 'chat')}
              >
                <MessageSquare size={17} />
                <span>{s.unread} 条未读消息</span>
              </button>
            )}
            {s.files.map((f) => (
              <button
                className="todo-row"
                key={f.packageId ?? f.id}
                disabled={!s.connected}
                onClick={() => onOpen(s.stationId, 'transfer', f.packageId)}
              >
                <FileDown size={17} />
                <span>
                  <strong>
                    {f.senderName} · {f.count} 个文件
                  </strong>
                  <small>
                    {f.confirmation ? '等待确认收到' : '等待接收'}
                    {f.deadline ? ` · 截止 ${date(f.deadline)}` : ''}
                  </small>
                </span>
              </button>
            ))}
          </section>
        ))
      ) : (
        <p className="subtle">当前没有待办</p>
      )}
    </div>
  );
}
