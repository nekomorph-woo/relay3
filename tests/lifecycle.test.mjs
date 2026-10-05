import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { RelayService } from '../dist-electron/index.js';
test('退出关闭监听和所有客户端，流与客户端下载收尾后才关闭数据库，清理可重复调用', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'relay3-close-'));
  const s = new RelayService(dir, path.resolve('dist'));
  let releaseClient;
  try {
    s.store.settings.port = 0;
    await s.startControl();
    await s.startHub();
    const hub = s.hub;
    const join = (
      await hub.inject({
        method: 'POST',
        url: '/api/join',
        payload: {
          id: randomUUID(),
          name: '测试设备',
          platform: 'PC',
          pairingToken: s.pairingToken,
        },
      })
    ).json();
    const ws = await hub.injectWS('/api/ws?token=' + join.token, {
      socket: { remoteAddress: '127.0.0.1' },
    });
    const pong = new Promise((resolve) => ws.once('message', resolve));
    ws.send('{"type":"ping"}');
    assert.equal((await pong).toString(), '{"type":"pong"}');
    const controller = new AbortController();
    s.streams.set('active-upload', controller);
    let streamSettled = false;
    controller.signal.addEventListener('abort', () => {
      setTimeout(() => {
        s.store.saveSettings(s.store.settings);
        streamSettled = true;
        s.streams.delete('active-upload');
      }, 25);
    });
    const clients = new Promise((resolve) => {
      releaseClient = resolve;
    });
    const closing = s.close(clients);
    assert.equal(s.close(), closing);
    assert.equal(s.closing, true);
    assert.equal(controller.signal.aborted, true);
    const deadline = Date.now() + 2000;
    while ((hub.server.listening || s.control.server.listening) && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(streamSettled, true);
    assert.equal(hub.server.listening, false);
    assert.equal(s.control.server.listening, false);
    assert.equal(s.closed, false);
    assert.equal(s.clients.size, 0);
    assert.notEqual(s.store.device(join.self.id).disconnectedAt, null);
    assert.ok(s.store.connections().every((c) => c.disconnectedAt !== null));
    await assert.rejects(() => s.startHub(), /正在退出/);
    releaseClient();
    await closing;
    assert.equal(s.closed, true);
    await s.close();
  } finally {
    releaseClient?.();
    await s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
