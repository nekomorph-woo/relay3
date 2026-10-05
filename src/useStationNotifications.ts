import { useEffect, useRef } from 'react';
import type { ClientConnection } from './useConnections';
import { stored, save } from './api';
export function useStationNotifications(
  connections: Record<string, ClientConnection>,
  activeId: string,
  page: string,
) {
  const previous = useRef(new Map<string, { latest: number; ids: Set<string> }>());
  useEffect(() => {
    for (const c of Object.values(connections)) {
      if (!c.hub || c.status !== 'connected') continue;
      const { stationId, id } = c.session,
        key = `relay3-notified:${stationId}:${id}`,
        muted = stored<string[]>('relay3-muted-stations', []).includes(stationId);
      const files = c.hub.transfers.filter(
        (t) =>
          t.recipientId === id &&
          ['pending', 'ready', 'awaiting-confirm'].includes(t.status) &&
          !t.cleanedAt,
      );
      const ids = new Set(files.map((t) => t.packageId ?? t.id)),
        old = previous.current.get(stationId),
        latest = c.hub.chatLatestId ?? 0;
      previous.current.set(stationId, { latest, ids });
      if (!old) continue; // 初次连接历史只进入待办，不逐条弹通知。
      const notified = stored<string[]>(key, []),
        seen = new Set(notified);
      let newFiles = 0;
      for (const f of ids)
        if (!old.ids.has(f) && !seen.has('file:' + f)) {
          seen.add('file:' + f);
          newFiles++;
        }
      const newChat =
        latest > old.latest && (c.hub.chatUnread ?? 0) > 0 && !seen.has('chat:' + latest);
      if (newChat) seen.add('chat:' + latest);
      save(key, [...seen].slice(-500));
      if (muted || !window.relay3) continue;
      if (newFiles && !(stationId === activeId && page === 'transfer'))
        void window.relay3.notifyStation({
          stationId,
          page: 'transfer',
          body: `收到 ${newFiles} 次文件发送，请确认接收`,
        });
      else if (newChat && !(stationId === activeId && page === 'chat'))
        void window.relay3.notifyStation({ stationId, page: 'chat', body: '群聊有新消息' });
    }
  }, [connections, activeId, page]);
}
