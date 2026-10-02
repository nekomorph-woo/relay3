import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { localFetch as fetch } from './http.mjs';
import { RelayService } from '../dist-electron/index.js';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'relay3-test-'));
  const service = new RelayService(dir, path.resolve('dist'));
  service.store.settings.port = 0;
  await service.startControl();
  await service.startHub();
  const base = `http://127.0.0.1:${service.hub.server.address().port}`;
  const clients = [];
  async function call(
    url,
    secret,
    body,
    method = body === undefined ? 'GET' : 'POST',
    origin = base,
  ) {
    const res = await fetch(origin + url, {
      method,
      headers: {
        ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, data: await res.json() };
  }
  async function join(name) {
    const result = await call('/api/join', '', {
      id: randomUUID(),
      name,
      platform: 'PC',
      pairingToken: service.pairingToken,
    });
    assert.equal(result.status, 200);
    const ws = await service.hub.injectWS('/api/ws?token=' + result.data.token, {
      socket: { remoteAddress: '127.0.0.1' },
    });
    await wait(20);
    clients.push(ws);
    return result.data;
  }
  async function transfer(sender, receiver, content = Buffer.from('relay3 文件测试')) {
    const result = await call('/api/transfers', sender.token, {
      name: '测试.txt',
      size: content.length,
      recipientId: receiver.self.id,
    });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    const t = result.data;
    await call(`/api/transfers/${t.id}/accept`, receiver.token, {});
    const up = await fetch(base + `/api/transfers/${t.id}/upload`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${sender.token}`,
        'Content-Type': 'application/octet-stream',
      },
      body: content,
    });
    assert.equal(up.status, 200, await up.text());
    return { t, content };
  }
  async function close() {
    for (const ws of clients) ws.terminate();
    await wait(20);
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
  return { dir, service, base, call, join, transfer, close };
}
test('身份校验、接收确认、流式传输、完整性校验和完成后清理', async () => {
  const f = await fixture();
  try {
    const sender = await f.join('Mac'),
      receiver = await f.join('手机'),
      other = await f.join('PC');
    assert.equal((await f.call('/api/state', 'wrong')).status, 401);
    assert.equal(
      (await f.call('/api/join', '', { id: randomUUID(), name: '陌生设备', pairingToken: 'wrong' }))
        .status,
      401,
    );
    assert.equal(
      (await f.call('/admin/status', '', undefined, 'GET', f.service.controlUrl)).status,
      401,
    );
    assert.equal(
      (await f.call('/admin/status', f.service.adminToken, undefined, 'GET', f.base)).status,
      404,
    );
    const preflight = await fetch(f.base + '/api/transfers/example/upload', {
      method: 'OPTIONS',
      headers: {
        Origin: f.service.controlUrl,
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
    });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get('access-control-allow-methods'), /PUT/);
    const content = Buffer.alloc(3 * 1024 * 1024, 7);
    const { t } = await f.transfer(sender, receiver, content);
    assert.equal(
      f.service.getTransfer(t.id).sha256,
      createHash('sha256').update(content).digest('hex'),
    );
    assert.equal((await f.call(`/api/transfers/${t.id}/complete`, other.token, {})).status, 403);
    f.service.cleanup(Date.now() + 86400000);
    assert.ok(existsSync(f.service.file(t)), '待接收文件不能按完成规则清理');
    const wrong = await fetch(f.base + `/api/transfers/${t.id}/download`, {
      headers: { Authorization: `Bearer ${sender.token}` },
    });
    assert.equal(wrong.status, 403);
    const res = await fetch(f.base + `/api/transfers/${t.id}/download`, {
      headers: { Authorization: `Bearer ${receiver.token}` },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), content);
    await wait(30);
    assert.equal(f.service.getTransfer(t.id).status, 'awaiting-confirm');
    const finished = await f.call(`/api/transfers/${t.id}/complete`, receiver.token, {});
    assert.equal(finished.status, 200);
    assert.ok(finished.data.duration >= 0);
    assert.equal(finished.data.expiresAt - finished.data.completedAt, 3600000);
    f.service.cleanup(finished.data.expiresAt - 1);
    assert.ok(existsSync(f.service.file(t)));
    f.service.cleanup(finished.data.expiresAt + 1);
    assert.ok(!existsSync(f.service.file(t)));
    assert.equal(f.service.getTransfer(t.id).status, 'completed');
    assert.ok(f.service.getTransfer(t.id).cleanedAt);
    assert.equal((await f.call('/api/history', receiver.token)).data.total, 1);
  } finally {
    await f.close();
  }
});
test('拒绝、取消、上传大小不匹配、禁止重复下载及手动清理', async () => {
  const f = await fixture();
  try {
    const a = await f.join('发送端'),
      b = await f.join('接收端');
    const pending = (
      await f.call('/api/transfers', a.token, {
        name: '待确认.bin',
        size: 1,
        recipientId: b.self.id,
      })
    ).data;
    const premature = await fetch(f.base + `/api/transfers/${pending.id}/upload`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${a.token}`, 'Content-Type': 'application/octet-stream' },
      body: Buffer.from('a'),
    });
    assert.equal(premature.status, 409);
    assert.equal(
      (await f.call(`/api/transfers/${pending.id}/reject`, b.token, {})).data.status,
      'rejected',
    );
    const mismatch = (
      await f.call('/api/transfers', a.token, {
        name: '坏文件.bin',
        size: 5,
        recipientId: b.self.id,
      })
    ).data;
    await f.call(`/api/transfers/${mismatch.id}/accept`, b.token, {});
    const result = await fetch(f.base + `/api/transfers/${mismatch.id}/upload`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${a.token}`, 'Content-Type': 'application/octet-stream' },
      body: Buffer.from('xx'),
    });
    assert.equal(result.status, 409);
    assert.equal(f.service.getTransfer(mismatch.id).status, 'failed');
    const { t } = await f.transfer(a, b);
    f.service.removeCache(t.id);
    assert.equal(f.service.getTransfer(t.id).status, 'failed');
    assert.ok(f.service.getTransfer(t.id).cleanedAt);
    assert.ok(!existsSync(f.service.file(t)));
    const empty = await f.transfer(a, b, Buffer.alloc(0));
    assert.equal(f.service.getTransfer(empty.t.id).status, 'ready');
    const cancelled = await f.call(`/api/transfers/${empty.t.id}/cancel`, a.token, {});
    assert.equal(cancelled.data.status, 'cancelled');
    assert.throws(() => f.service.removeCache('../relay3.sqlite'));
  } finally {
    await f.close();
  }
});
test('设备连接与断开记录持久保存，缓存迁移保留文件，数据库整理保留历史', async () => {
  const f = await fixture();
  try {
    const a = await f.join('Mac'),
      b = await f.join('手机');
    const { t, content } = await f.transfer(a, b);
    const old = f.service.file(t),
      target = path.join(f.dir, 'new-cache');
    assert.equal(
      (
        await f.call(
          '/admin/settings',
          f.service.adminToken,
          { cacheDir: target },
          'POST',
          f.service.controlUrl,
        )
      ).status,
      409,
    );
    await f.service.stopHub(true);
    await wait(30);
    assert.equal(f.service.store.devices().filter((d) => d.disconnectedAt !== null).length, 2);
    assert.equal(f.service.store.connections().length, 2);
    const migrated = await f.call(
      '/admin/settings',
      f.service.adminToken,
      { cacheDir: target },
      'POST',
      f.service.controlUrl,
    );
    assert.equal(migrated.status, 200);
    assert.ok(!existsSync(old));
    assert.deepEqual(readFileSync(f.service.file(t)), content);
    assert.equal(
      (
        await f.call(
          '/admin/database/compact',
          f.service.adminToken,
          {},
          'POST',
          f.service.controlUrl,
        )
      ).status,
      200,
    );
    assert.equal(f.service.store.transfers().length, 1);
    const sqlite = f.service.store.dbPath;
    assert.ok(existsSync(sqlite));
  } finally {
    await f.close();
  }
});
test('重启后保留记录与设备凭证，未完成下载恢复为可接收状态', async () => {
  const f = await fixture();
  let reopened;
  try {
    const a = await f.join('PC'),
      b = await f.join('手机');
    const { t } = await f.transfer(a, b);
    f.service.update(t, { status: 'downloading' });
    await f.service.close();
    reopened = new RelayService(f.dir, path.resolve('dist'));
    assert.equal(
      reopened.store.auth(createHash('sha256').update(a.token).digest('hex')).name,
      'PC',
    );
    assert.equal(reopened.getTransfer(t.id).status, 'ready');
    assert.equal(reopened.store.connections().length, 2);
    assert.ok(existsSync(reopened.file(t)));
  } finally {
    for (const c of f.service.clients.values()) c.socket.terminate();
    await reopened?.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('六位配对码一次性消费、过期、刷新和错误尝试限速', async () => {
  const f = await fixture();
  const joinCode = (code) =>
    f.call('/api/join', '', { id: randomUUID(), name: '数字配对', pairingCode: code });
  try {
    const code = f.service.pairingCode;
    assert.match(code, /^\d{6}$/);
    assert.equal((await joinCode('wrong')).status, 401);
    const results = await Promise.all([joinCode(code), joinCode(code)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 401]);
    assert.notEqual(f.service.pairingCode, code);
    f.service.pairingCodeExpiresAt = Date.now() - 1;
    assert.equal((await joinCode(f.service.pairingCode)).status, 401);
    const refreshed = await f.call(
      '/admin/pairing/code',
      f.service.adminToken,
      {},
      'POST',
      f.service.controlUrl,
    );
    assert.equal(refreshed.status, 200);
    assert.ok(refreshed.data.pairingCodeExpiresAt > Date.now());
    assert.equal((await joinCode(refreshed.data.pairingCode)).status, 200);
    for (let i = 0; i < 10; i++) await joinCode('000000');
    assert.equal((await joinCode(f.service.pairingCode)).status, 429);
  } finally {
    await f.close();
  }
});

test('按最近连接时间清理离线设备，在线设备可单独清除且撤销凭证', async () => {
  const f = await fixture();
  try {
    const sender = await f.join('Mac'),
      receiver = await f.join('手机');
    const pending = await f.call('/api/transfers', sender.token, {
      name: '未完成.txt',
      size: 10,
      recipientId: receiver.self.id,
    });
    const admin = (route, body) =>
      f.call(route, f.service.adminToken, body, 'POST', f.service.controlUrl);
    assert.equal((await admin('/admin/devices/clear', { hours: 2 })).status, 400);
    assert.equal((await admin('/admin/devices/clear', { hours: 1 })).data.deleted, 0);
    await admin('/admin/device/disconnect', { id: receiver.self.id });
    await wait(40);
    f.service.store.db
      .prepare('UPDATE connections SET connectedAt=? WHERE deviceId=?')
      .run(Date.now() - 2 * 3600_000, receiver.self.id);
    assert.equal((await admin('/admin/devices/clear', { hours: 24 })).data.deleted, 0);
    assert.equal((await admin('/admin/devices/clear', { hours: 1 })).data.deleted, 1);
    assert.equal(f.service.store.transfer(pending.data.id).status, 'cancelled');
    assert.equal((await f.call('/api/state', receiver.token)).status, 401);
    assert.ok(f.service.store.device(sender.self.id));
    assert.equal((await admin('/admin/device/delete', { id: sender.self.id })).status, 200);
    await wait(40);
    assert.equal(f.service.clients.size, 0);
    assert.equal(f.service.store.devices().length, 0);
    assert.equal(f.service.store.connections().length, 0);
    assert.equal(f.service.store.records().length, 1);
    assert.equal((await f.call('/api/state', sender.token)).status, 401);
  } finally {
    await f.close();
  }
});

test('终端更换身份撤销旧凭证，桌面身份持久化且保留连接历史', async () => {
  const f = await fixture();
  try {
    const mobile = await f.join('手机');
    assert.equal((await f.call('/api/identity/reset', mobile.token, {})).status, 200);
    await wait(40);
    assert.equal((await f.call('/api/state', mobile.token)).status, 401);
    assert.ok(f.service.store.device(mobile.self.id));
    assert.equal(f.service.clients.size, 0);
    const old = f.service.store.settings.deviceId;
    const reset = await f.call(
      '/admin/identity/reset',
      f.service.adminToken,
      {},
      'POST',
      f.service.controlUrl,
    );
    assert.equal(reset.status, 200);
    assert.notEqual(reset.data.settings.deviceId, old);
    assert.equal(f.service.store.connections().length, 1);
    const persisted = JSON.parse(
      f.service.store.db.prepare("SELECT value FROM settings WHERE key='main'").get().value,
    );
    assert.equal(persisted.deviceId, reset.data.settings.deviceId);
  } finally {
    await f.close();
  }
});
