import type { ClientConnection } from './useConnections';
export interface StationTodo {
  stationId: string;
  name: string;
  connected: boolean;
  unread: number;
  files: {
    id: string;
    packageId?: string;
    senderName: string;
    count: number;
    deadline: number | null;
    confirmation: boolean;
  }[];
}
export function stationTodos(
  connections: Record<string, ClientConnection>,
  now = Date.now(),
): StationTodo[] {
  return Object.values(connections)
    .map((c) => {
      const groups = new Map<string, StationTodo['files'][number]>();
      for (const t of c.hub?.transfers ?? []) {
        if (
          t.recipientId !== c.session.id ||
          t.cleanedAt ||
          !['pending', 'ready', 'awaiting-confirm'].includes(t.status) ||
          now >= (t.receiveDeadline ?? Infinity)
        )
          continue;
        const key = t.packageId ?? t.id,
          group = groups.get(key);
        if (group) {
          group.count++;
          group.confirmation ||= t.status === 'awaiting-confirm';
        } else
          groups.set(key, {
            id: t.id,
            packageId: t.packageId,
            senderName: t.senderName,
            count: 1,
            deadline: t.receiveDeadline ?? null,
            confirmation: t.status === 'awaiting-confirm',
          });
      }
      return {
        stationId: c.session.stationId,
        name: c.session.stationName || '其他',
        connected: c.status === 'connected',
        unread: c.hub?.chatUnread ?? 0,
        files: [...groups.values()],
      };
    })
    .filter((s) => s.files.length || s.unread);
}
