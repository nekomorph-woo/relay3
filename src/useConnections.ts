import { useCallback, useEffect, useRef, useState } from 'react';
import { reportException } from './diagnostics';
import type { HubState, Session } from './api';

import { connectStation, type ConnectionStatus } from './connection';
export type { ConnectionStatus } from './connection';
export interface ClientConnection {
  session: Session;
  hub: HubState | null;
  status: ConnectionStatus;
}
export function useConnections(desktop: boolean, inform: (text: string, error?: boolean) => void) {
  const [connections, setConnections] = useState<Record<string, ClientConnection>>({});
  const [activeId, setActiveId] = useState('');
  const [retry, setRetry] = useState(0);
  const current = useRef(connections);
  const selected = useRef(activeId);
  const notify = useRef(inform);
  notify.current = inform;
  const sockets = useRef(
    new Map<
      string,
      {
        signature: string;
        stop: () => void;
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
        resource.stop();
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
      if (current.current[session.stationId]?.status === 'expired') {
        const resource = sockets.current.get(session.stationId);
        if (resource) {
          resource.stop();
          sockets.current.delete(session.stationId);
        }
        setRetry((old) => old + 1);
      }
      if (!desktop)
        for (const id of Object.keys(current.current)) if (id !== session.stationId) remove(id);
      update((old) => ({
        ...old,
        [session.stationId]: {
          session,
          hub: hub ?? old[session.stationId]?.hub ?? null,
          status:
            old[session.stationId]?.status !== 'expired' &&
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
        resource.stop();
        sockets.current.delete(id);
      }
    }
    for (const [id, connection] of Object.entries(current.current)) {
      if (sockets.current.has(id)) continue;
      const session = connection.session;
      const stop = connectStation(session, {
        reminder: (packageId, senderName) =>
          window.dispatchEvent(
            new CustomEvent('relay3-package-reminder', {
              detail: { stationId: session.stationId, packageId, senderName },
            }),
          ),
        state: (hub) => updateHub(id, hub),
        status: (status) =>
          update((old) => (old[id] ? { ...old, [id]: { ...old[id], status } } : old)),
        expired: (code) =>
          notify.current(
            `${session.stationName}：${code === 4001 ? '连接凭证失效，请重新配对' : code === 4002 ? '此设备已在另一窗口连接' : '管理员已断开此设备'}`,
            true,
          ),
        error: (error) =>
          reportException('connection.socket-error ' + session.stationName, error, {
            stationId: id,
            base: session.base,
          }),
      });
      sockets.current.set(id, { signature: session.base + ':' + session.token, stop });
    }
  }, [signature, retry, update, updateHub]);
  useEffect(
    () => () => {
      for (const resource of sockets.current.values()) {
        resource.stop();
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
