import test from 'node:test';
import assert from 'node:assert/strict';
import { connectStation } from '../dist-electron/connection.js';
const session = {
  base: 'http://127.0.0.1:42830',
  stationId: 'station',
  id: 'device',
  token: 'test',
};
const state = {
  stationId: 'station',
  self: { id: 'device' },
  transfers: [],
  devices: [],
  connectionHeartbeat: true,
};
function fixture(t) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1000 });
  const sockets = [],
    statuses = [],
    errors = [],
    expired = [];
  const stop = connectStation(
    session,
    {
      state() {},
      status: (s) => statuses.push(s),
      error: (e) => errors.push(e),
      expired: (code) => expired.push(code),
    },
    () => {
      const socket = {
        readyState: 0,
        closed: false,
        sent: [],
        send(s) {
          this.sent.push(s);
        },
        close() {
          this.closed = true;
        },
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
      };
      sockets.push(socket);
      return socket;
    },
  );
  t.after(stop);
  function open(heartbeat = true) {
    const socket = sockets.at(-1);
    socket.readyState = 1;
    socket.onopen();
    socket.onmessage({ data: JSON.stringify({ ...state, connectionHeartbeat: heartbeat }) });
    return socket;
  }
  return { sockets, statuses, errors, expired, stop, open };
}
test('无关闭事件的失联连接在45秒后重连，忽略旧连接事件', (t) => {
  const f = fixture(t),
    first = f.open(),
    late = first.onmessage;
  t.mock.timers.tick(45000);
  assert.equal(first.closed, true);
  assert.equal(f.statuses.at(-1), 'reconnecting');
  t.mock.timers.tick(1000);
  assert.equal(f.sockets.length, 2);
  late({ data: JSON.stringify({ wrong: true }) });
  assert.equal(f.errors.length, 0);
  f.open();
  assert.equal(f.statuses.at(-1), 'connected');
});
test('心跳应答维持连接，停止后不再发送或重连', (t) => {
  const f = fixture(t),
    socket = f.open();
  for (let i = 0; i < 6; i++) {
    t.mock.timers.tick(15000);
    socket.onmessage({ data: '{"type":"pong"}' });
  }
  assert.equal(socket.sent.length, 6);
  assert.equal(socket.closed, false);
  f.stop();
  t.mock.timers.tick(90000);
  assert.equal(socket.sent.length, 6);
  assert.equal(f.sockets.length, 1);
});
test('凭证撤销停止重连；握手无响应也会重试', (t) => {
  const f = fixture(t),
    socket = f.open();
  socket.onclose({ code: 4003 });
  t.mock.timers.tick(90000);
  assert.deepEqual(f.expired, [4003]);
  assert.equal(f.sockets.length, 1);
  assert.equal(f.statuses.at(-1), 'expired');
});
test('连接握手卡住且无错误事件时会重试', (t) => {
  const f = fixture(t);
  t.mock.timers.tick(45000);
  assert.equal(f.sockets[0].closed, true);
  t.mock.timers.tick(1000);
  assert.equal(f.sockets.length, 2);
});
test('旧中转站通过信息接口检测，停止时撤销探测', async (t) => {
  const f = fixture(t),
    socket = f.open(false);
  let signal;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    signal = options.signal;
    return { ok: true, json: async () => ({ stationId: 'station', running: true }) };
  });
  t.mock.timers.tick(15000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socket.sent.length, 0);
  assert.equal(socket.closed, false);
  t.mock.method(globalThis, 'fetch', (_url, options) => {
    signal = options.signal;
    return new Promise(() => {});
  });
  t.mock.timers.tick(15000);
  f.stop();
  assert.equal(signal.aborted, true);
});
