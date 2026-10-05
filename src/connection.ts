import type { HubState, Session } from './api';
export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'expired';

// 与服务端的传输层 ping 分开，浏览器也能检测没有 close 事件的网络黑洞。
export function connectStation(
  session: Session,
  callbacks: {
    state: (hub: HubState) => void;
    status: (status: ConnectionStatus) => void;
    expired: (code: number) => void;
    error: (error: unknown) => void;
    reminder?: (packageId: string, senderName: string) => void;
  },
  createSocket = (url: string): WebSocket => new WebSocket(url),
) {
  let stopped = false,
    attempts = 0,
    socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let health: ReturnType<typeof setInterval> | undefined;
  let probe: AbortController | undefined;
  function release() {
    clearInterval(health);
    probe?.abort();
    probe = undefined;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      socket.close();
      socket = undefined;
    }
  }
  function reconnect() {
    if (stopped) return;
    release();
    callbacks.status('reconnecting');
    retry = setTimeout(connect, Math.min(30000, 1000 * 2 ** attempts++));
  }
  function connect() {
    if (stopped) return;
    let lastReply = Date.now(),
      supportsHeartbeat = false;
    const current = createSocket(
      session.base.replace(/^http/, 'ws') + '/api/ws?token=' + encodeURIComponent(session.token),
    );
    socket = current;
    const active = () => !stopped && socket === current;
    current.onopen = () => {
      if (active()) callbacks.status('connected');
    };
    current.onmessage = (event) => {
      if (!active()) return;
      try {
        const hub = JSON.parse(event.data);
        if (
          hub.type === 'package-reminder' &&
          hub.stationId === session.stationId &&
          typeof hub.packageId === 'string' &&
          typeof hub.senderName === 'string'
        ) {
          lastReply = Date.now();
          callbacks.reminder?.(hub.packageId, hub.senderName);
          return;
        }
        if (supportsHeartbeat && hub.type === 'pong') {
          lastReply = Date.now();
          return;
        }
        if (
          hub.stationId !== session.stationId ||
          hub.self?.id !== session.id ||
          !Array.isArray(hub.transfers) ||
          !Array.isArray(hub.devices)
        )
          throw new Error('中转站身份或状态不匹配');
        supportsHeartbeat = hub.connectionHeartbeat === true;
        lastReply = Date.now();
        attempts = 0;
        callbacks.state(hub);
      } catch (error) {
        callbacks.error(error);
      }
    };
    current.onclose = (event) => {
      if (!active()) return;
      if ([4001, 4002, 4003].includes(event.code)) {
        release();
        callbacks.status('expired');
        callbacks.expired(event.code);
      } else reconnect();
    };
    current.onerror = () => {
      if (active()) callbacks.error(new Error('中转站实时连接失败'));
    };
    health = setInterval(() => {
      if (!active()) return;
      if (Date.now() - lastReply >= 45000) {
        reconnect();
        return;
      }
      if (current.readyState !== 1) return;
      if (supportsHeartbeat) {
        current.send('{"type":"ping"}');
      } else if (!probe) {
        // 旧中转站不支持应用层心跳，使用原有接口兼容检测。
        const controller = new AbortController();
        probe = controller;
        const timeout = setTimeout(() => controller.abort(), 8000);
        void fetch(session.base + '/api/info', { signal: controller.signal, cache: 'no-store' })
          .then(async (r) => {
            if (!r.ok) throw new Error('中转站无响应');
            const info = await r.json();
            if (info.stationId !== session.stationId || !info.running)
              throw new Error('中转站已关闭或身份变化');
            if (active()) lastReply = Date.now();
          })
          .catch(() => {
            if (active()) reconnect();
          })
          .finally(() => {
            clearTimeout(timeout);
            if (probe === controller) probe = undefined;
          });
      }
    }, 15000);
  }
  connect();
  return () => {
    stopped = true;
    clearTimeout(retry);
    release();
  };
}
