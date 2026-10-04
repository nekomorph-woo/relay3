import { useCallback, useEffect, useRef, useState } from 'react';
import { reportException } from './diagnostics';
import type { HubState, Session } from './api';

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'expired';
export interface ClientConnection {
  session: Session;
  hub: HubState | null;
  status: ConnectionStatus;
}
export function useConnections(desktop: boolean, inform: (text: string, error?: boolean) => void) {
  const [connections, setConnections] = useState<Record<string, ClientConnection>>({});
  const [activeId, setActiveId] = useState('');
  const current = useRef(connections);
  const selected = useRef(activeId);
  const notify = useRef(inform);
  notify.current = inform;
  const sockets = useRef(
    new Map<
      string,
      {
        signature: string;
        socket?: WebSocket;
        timer?: ReturnType<typeof setTimeout>;
        stopped: boolean;
      }
    >(),
  );

  const update = useCallback(
    (change: (old: Record<string, ClientConnection>) => Record<string, ClientConnection>) => {
      const next = change(current.current);
      current.current = next;
      setConnections(next);
    },
    [],
  );
  const select = useCallback((id: string) => {
    selected.current = id;
    setActiveId(id);
  }, []);
  const remove = useCallback(
    (id: string) => {
      const resource = sockets.current.get(id);
      if (resource) {
        resource.stopped = true;
        clearTimeout(resource.timer);
        resource.socket?.close();
        sockets.current.delete(id);
      }
      update((old) => {
        const next = { ...old };
        delete next[id];
        return next;
      });
      if (selected.current === id) select(Object.keys(current.current)[0] ?? '');
    },
    [update, select],
  );
  const add = useCallback(
    (session: Session, hub: HubState | null = null, activate = true) => {
      if (!desktop)
        for (const id of Object.keys(current.current)) if (id !== session.stationId) remove(id);
      update((old) => ({
        ...old,
        [session.stationId]: {
          session,
          hub: hub ?? old[session.stationId]?.hub ?? null,
          status:
            old[session.stationId]?.session.base === session.base &&
            old[session.stationId]?.session.token === session.token
              ? old[session.stationId].status
              : 'connecting',
        },
      }));
      if (activate || !selected.current) select(session.stationId);
    },
    [desktop, remove, update, select],
  );
  const updateHub = useCallback(
    (id: string, hub: HubState) => {
      update((old) =>
        old[id]
          ? {
              ...old,
              [id]: {
                ...old[id],
                hub,
                session: { ...old[id].session, stationName: hub.stationName },
              },
            }
          : old,
      );
    },
    [update],
  );

  const signature = JSON.stringify(
    Object.values(connections).map((c) => [c.session.stationId, c.session.base, c.session.token]),
  );
  useEffect(() => {
    for (const [id, resource] of sockets.current) {
      const connection = current.current[id];
      if (
        !connection ||
        resource.signature !== connection.session.base + ':' + connection.session.token
      ) {
        resource.stopped = true;
        clearTimeout(resource.timer);
        resource.socket?.close();
        sockets.current.delete(id);
      }
    }
    for (const [id, connection] of Object.entries(current.current)) {
      if (sockets.current.has(id)) continue;
      const session = connection.session;
      const resource: {
        signature: string;
        socket?: WebSocket;
        timer?: ReturnType<typeof setTimeout>;
        stopped: boolean;
      } = { signature: session.base + ':' + session.token, stopped: false };
      sockets.current.set(id, resource);
      let attempts = 0;
      const status = (status: ConnectionStatus) => {
        if (resource.stopped) return;
        update((old) => (old[id] ? { ...old, [id]: { ...old[id], status } } : old));
      };
      function connect() {
        if (resource.stopped) return;
        const socket = new WebSocket(
          session.base.replace(/^http/, 'ws') +
            '/api/ws?token=' +
            encodeURIComponent(session.token),
        );
        resource.socket = socket;
        socket.onopen = () => {
          attempts = 0;
          status('connected');
        };
        socket.onmessage = (event) => {
          if (resource.stopped) return;
          try {
            const hub: HubState = JSON.parse(event.data);
            if (
              hub.stationId !== id ||
              hub.self?.id !== session.id ||
              !Array.isArray(hub.transfers) ||
              !Array.isArray(hub.devices)
            )
              throw new Error('中转站身份或状态不匹配');
            updateHub(id, hub);
          } catch (error) {
            reportException('connection.invalid-state ' + session.stationName, error, {
              stationId: id,
              base: session.base,
            });
          }
        };
        socket.onclose = (event) => {
          if (resource.stopped) return;
          if ([4001, 4002, 4003].includes(event.code)) {
            status('expired');
            notify.current(
              `${session.stationName}：${event.code === 4001 ? '连接凭证失效，请重新配对' : event.code === 4002 ? '此设备已在另一窗口连接' : '管理员已断开此设备'}`,
              true,
            );
            return;
          }
          status('reconnecting');
          resource.timer = setTimeout(connect, Math.min(30000, 1000 * 2 ** attempts++));
        };
        socket.onerror = () =>
          reportException(
            'connection.socket-error ' + session.stationName,
            new Error('中转站实时连接失败'),
            { stationId: id, base: session.base },
          );
      }
      connect();
    }
  }, [signature, update, updateHub]);
  useEffect(
    () => () => {
      for (const resource of sockets.current.values()) {
        resource.stopped = true;
        clearTimeout(resource.timer);
        resource.socket?.close();
      }
      sockets.current.clear();
    },
    [],
  );
  const selectedConnection = connections[activeId];
  return {
    connections,
    activeId,
    select,
    add,
    remove,
    updateHub,
    session: selectedConnection?.session ?? null,
    hub: selectedConnection?.hub ?? null,
    connected: selectedConnection?.status === 'connected',
    current,
  };
}
