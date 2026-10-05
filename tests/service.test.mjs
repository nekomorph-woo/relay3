import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
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

test('本机管理权限恢复旧身份，重连凭证跨重启保存且不能从局域网抢占身份', async () => {
  const f = await fixture();
  let restarted;
  try {
    const id = f.service.store.settings.deviceId;
    const original = await f.call('/api/join', '', {
      id,
      name: '本机',
      pairingToken: f.service.pairingToken,
    });
    assert.equal(original.status, 200);
    const firstSeen = f.service.store.device(id).firstSeen;
    const local = () =>
      f.call('/admin/client/join-local', f.service.adminToken, {}, 'POST', f.service.controlUrl);
    assert.equal(
      (await f.call('/admin/client/join-local', '', {}, 'POST', f.service.controlUrl)).status,
      401,
    );
    const recovery = await local();
    assert.equal(recovery.status, 200);
    assert.equal(recovery.data.self.id, id);
    assert.equal(f.service.store.device(id).firstSeen, firstSeen);
    assert.equal((await local()).data.token, recovery.data.token);
    assert.equal(
      (
        await f.call('/api/join', '', {
          id,
          name: '假冒本机',
          pairingToken: f.service.pairingToken,
        })
      ).status,
      409,
    );
    const remote = {
      base: 'http://192.168.5.10:42830',
      id,
      token: 'a'.repeat(64),
      stationId: randomUUID(),
      stationName: '远端',
    };
    assert.equal(
      (
        await f.call(
          '/admin/client/session',
          f.service.adminToken,
          remote,
          'POST',
          f.service.controlUrl,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await f.call(
          '/admin/client/session',
          f.service.adminToken,
          { ...remote, id: randomUUID() },
          'POST',
          f.service.controlUrl,
        )
      ).status,
      400,
    );
    await f.service.close();
    restarted = new RelayService(f.dir, path.resolve('dist'));
    restarted.store.settings.port = 0;
    await restarted.startControl();
    await restarted.startHub();
    const saved = restarted.store.clientSessions();
    assert.equal(saved[recovery.data.base].token, recovery.data.token);
    assert.deepEqual(saved[remote.base], remote);
    const recovered = await f.call(
      '/admin/client/join-local',
      restarted.adminToken,
      {},
      'POST',
      restarted.controlUrl,
    );
    assert.equal(recovered.status, 200);
    assert.equal(recovered.data.self.id, id);
    await f.call('/admin/identity/reset', restarted.adminToken, {}, 'POST', restarted.controlUrl);
    assert.deepEqual(restarted.store.clientSessions(), {});
  } finally {
    await restarted?.close();
    await f.close();
  }
});

test('中转站独立名称持久保存、旧版迁移与无凭证探测在线信息', async () => {
  const f = await fixture();
  let restarted;
  try {
    const originalDevice = f.service.store.settings.deviceName;
    const originalStationId = f.service.store.settings.stationId;
    const update = (body) =>
      f.call('/admin/settings', f.service.adminToken, body, 'POST', f.service.controlUrl);
    assert.equal((await update({ stationName: '客厅中转站' })).status, 200);
    assert.equal(f.service.store.settings.deviceName, originalDevice);
    const joined = await f.join('手机在线');
    assert.equal(joined.stationName, '客厅中转站');
    assert.equal((await f.call('/api/chat/info', joined.token)).data.stationName, '客厅中转站');
    const info = (await f.call('/api/info')).data;
    assert.equal(info.name, '客厅中转站');
    assert.equal(info.stationId, originalStationId);
    assert.equal(info.running, true);
    assert.equal(info.onlineDevices, 1);
    assert.deepEqual(
      Object.keys(info).sort(),
      ['app', 'capacityPreflight', 'name', 'onlineDevices', 'running', 'stationId'].sort(),
    );
    for (const stationName of ['', '   ', 'x'.repeat(81), 123])
      assert.equal((await update({ stationName })).status, 400);
    await f.service.close();
    restarted = new RelayService(f.dir, path.resolve('dist'));
    assert.equal(restarted.store.settings.stationName, '客厅中转站');
    assert.equal(restarted.store.settings.deviceName, originalDevice);
    const legacy = { ...restarted.store.settings, deviceName: '旧版设备' };
    delete legacy.stationName;
    restarted.store.db
      .prepare('UPDATE settings SET value=? WHERE key=?')
      .run(JSON.stringify(legacy), 'main');
    await restarted.close();
    restarted = new RelayService(f.dir, path.resolve('dist'));
    assert.equal(restarted.store.settings.stationName, '旧版设备');
    assert.equal(restarted.store.settings.stationId, originalStationId);
  } finally {
    await restarted?.close();
    await f.close();
  }
});

test('平台历史快照、旧表迁移与设备清理后消息标记保留', async () => {
  const f = await fixture();
  let reopened;
  try {
    const sender = await f.join('电脑');
    const receiver = (
      await f.call('/api/join', '', {
        id: randomUUID(),
        name: '安卓',
        platform: 'Android',
        pairingToken: f.service.pairingToken,
      })
    ).data;
    await f.service.hub.injectWS('/api/ws?token=' + receiver.token, {
      socket: { remoteAddress: '127.0.0.1' },
    });
    await wait(20);
    const message = (
      await f.call('/api/chat/messages', sender.token, {
        clientId: randomUUID(),
        mode: 'plain',
        content: '保留平台',
        senderPlatform: 'iOS',
      })
    ).data;
    assert.equal(message.senderPlatform, 'PC');
    const transfer = (
      await f.call('/api/transfers', sender.token, {
        recipientId: receiver.self.id,
        name: '平台.txt',
        size: 0,
      })
    ).data;
    assert.equal(transfer.senderPlatform, 'PC');
    assert.equal(transfer.recipientPlatform, 'Android');
    assert.equal(
      f.service.store.connections().find((c) => c.deviceId === sender.self.id).platform,
      'PC',
    );
    f.service.store.db.exec(
      'ALTER TABLE connections DROP COLUMN platform; ALTER TABLE chat_messages DROP COLUMN senderPlatform;',
    );
    delete transfer.senderPlatform;
    delete transfer.recipientPlatform;
    f.service.store.saveTransfer(transfer);
    await f.service.close();
    reopened = new RelayService(f.dir, path.resolve('dist'));
    assert.equal(
      reopened.store.connections().find((c) => c.deviceId === sender.self.id).platform,
      'PC',
    );
    assert.equal(
      reopened.chat.read(
        reopened.chat.db.prepare('SELECT * FROM chat_messages WHERE id=?').get(message.id),
      ).senderPlatform,
      'PC',
    );
    assert.equal(reopened.store.transfer(transfer.id).recipientPlatform, 'Android');
    await reopened.startControl();
    const removed = await f.call(
      '/admin/device/delete',
      reopened.adminToken,
      { id: sender.self.id },
      'POST',
      reopened.controlUrl,
    );
    assert.equal(removed.status, 200);
    assert.equal(
      reopened.chat.read(
        reopened.chat.db.prepare('SELECT * FROM chat_messages WHERE id=?').get(message.id),
      ).senderPlatform,
      'PC',
    );
    assert.equal(reopened.store.transfer(transfer.id).senderPlatform, 'PC');
  } finally {
    await reopened?.close();
    await f.close();
  }
});

test('平台 UA 回退、识别来源持久化及重连更新', async () => {
  const f = await fixture();
  try {
    const id = randomUUID();
    const response = await f.service.hub.inject({
      method: 'POST',
      url: '/api/join',
      headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 15)' },
      payload: { id, name: '手机', pairingToken: f.service.pairingToken },
    });
    assert.equal(response.statusCode, 200);
    const joined = response.json();
    assert.equal(joined.self.platform, 'Android');
    assert.equal(joined.self.platformSource, 'user-agent');
    const firstSeen = joined.self.firstSeen;
    const updated = await f.call('/api/join', joined.token, {
      id,
      name: 'iPad',
      platform: 'iOS',
      platformSource: 'browser-platform',
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.data.self.firstSeen, firstSeen);
    const persisted = JSON.parse(
      f.service.store.db.prepare('SELECT data FROM devices WHERE id=?').get(id).data,
    );
    assert.equal(persisted.platform, 'iOS');
    assert.equal(persisted.platformSource, 'browser-platform');
    const fallback = await f.call('/api/join', joined.token, {
      id,
      name: 'iPad',
      platform: 'Unknown',
    });
    assert.equal(fallback.data.self.platform, 'iOS');
  } finally {
    await f.close();
  }
});

test('客户端诊断接口要求认证、限制正文及记录频率', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call('/api/diagnostics', '', { event: 'test' })).status, 401);
    const device = await f.join('手机诊断');
    assert.equal(
      (await f.call('/api/diagnostics', device.token, { event: 'test', stack: 'x'.repeat(8001) }))
        .status,
      400,
    );
    for (let i = 0; i < 20; i++) {
      const response = await f.service.hub.inject({
        method: 'POST',
        url: '/api/diagnostics',
        headers: { authorization: 'Bearer ' + device.token },
        payload: { event: 'test', message: 'test' },
      });
      assert.equal(response.statusCode, 204);
    }
    assert.equal((await f.call('/api/diagnostics', device.token, { event: 'test' })).status, 429);
  } finally {
    await f.close();
  }
});

test('异步缓存迁移兼容中文路径，设置保存失败时回滚且保留原文件', async () => {
  const f = await fixture();
  const originalSave = f.service.store.saveSettings.bind(f.service.store);
  try {
    await f.service.stopHub(true);
    const source = f.service.store.settings.cacheDir;
    const file = path.join(source, 'ready', '中文缓存.txt');
    writeFileSync(file, '缓存内容');
    const target = path.join(f.dir, '新的缓存目录');
    f.service.store.saveSettings = (settings) => {
      if (settings.cacheDir === target)
        throw Object.assign(new Error('模拟数据库写入失败'), { code: 'SQLITE_FULL' });
      originalSave(settings);
    };
    const failed = await f.call(
      '/admin/settings',
      f.service.adminToken,
      { cacheDir: target },
      'POST',
      f.service.controlUrl,
    );
    assert.equal(failed.status, 500);
    assert.equal(f.service.store.settings.cacheDir, source);
    assert.equal(readFileSync(file, 'utf8'), '缓存内容');
    assert.deepEqual(readdirSync(target), []);
    assert.equal(f.service.cacheMigration, null);
    f.service.store.saveSettings = originalSave;
    const success = await f.call(
      '/admin/settings',
      f.service.adminToken,
      { cacheDir: target },
      'POST',
      f.service.controlUrl,
    );
    assert.equal(success.status, 200);
    assert.equal(readFileSync(path.join(target, 'ready', '中文缓存.txt'), 'utf8'), '缓存内容');
    assert.equal(existsSync(source), false);
  } finally {
    f.service.store.saveSettings = originalSave;
    await f.close();
  }
});

test('缓存迁移期间拒绝启动、清理和并发保存，关闭等待迁移结束', async () => {
  const f = await fixture();
  try {
    await f.service.stopHub(true);
    let resolve;
    f.service.cacheMigration = new Promise((done) => {
      resolve = done;
    });
    await assert.rejects(f.service.startHub(), /缓存迁移中/);
    assert.throws(() => f.service.removeCache('test-file'), /缓存迁移中/);
    const settings = await f.call(
      '/admin/settings',
      f.service.adminToken,
      { deviceName: '并发保存' },
      'POST',
      f.service.controlUrl,
    );
    assert.equal(settings.status, 409);
    let closed = false;
    const closing = f.service.close().then(() => {
      closed = true;
    });
    await wait(20);
    assert.equal(closed, false);
    resolve();
    await closing;
    f.service.cacheMigration = null;
  } finally {
    await f.close();
  }
});

test('多站配对独立保存、同站换地址去重、连接意图与页面持久化，忘记配对保留记录', async () => {
  const f = await fixture();
  try {
    const make = (base, stationId, name) => ({
      base,
      stationId,
      stationName: name,
      token: 'a'.repeat(64),
      id: f.service.store.settings.deviceId,
      autoConnect: true,
    });
    const a = make('http://192.168.5.10:42830', randomUUID(), '甲站');
    const b = make('http://192.168.5.11:42830', randomUUID(), '乙站');
    const admin = (url, body) =>
      f.call('/admin/client/' + url, f.service.adminToken, body, 'POST', f.service.controlUrl);
    assert.equal((await admin('session', a)).status, 200);
    assert.equal((await admin('session', b)).status, 200);
    assert.equal(Object.keys(f.service.store.clientSessions()).length, 2);
    const moved = { ...a, base: 'http://192.168.5.12:42830' };
    await admin('session', moved);
    assert.equal(Object.keys(f.service.store.clientSessions()).length, 2);
    assert.equal(f.service.store.clientSessions()[a.base], undefined);
    await admin('state', { stationId: a.stationId, autoConnect: false });
    assert.equal(f.service.store.clientSessions()[moved.base].autoConnect, false);
    assert.equal(f.service.store.clientSessions()[b.base].autoConnect, true);
    await admin('view', { stationId: b.stationId, page: 'chat' });
    assert.deepEqual(f.service.store.clientView(), { stationId: b.stationId, page: 'chat' });
    assert.equal((await admin('view', { stationId: b.stationId, page: 'invalid' })).status, 400);
    const file = {
      id: randomUUID(),
      name: '文件',
      path: '/tmp/file',
      size: 1,
      receivedAt: Date.now(),
      stationId: a.stationId,
      stationName: '甲站',
    };
    f.service.store.saveReceived(file);
    await admin('forget', { stationId: a.stationId });
    assert.equal(Object.keys(f.service.store.clientSessions()).length, 1);
    assert.deepEqual(f.service.store.received()[0], file);
    const second = new RelayService(f.dir, path.resolve('dist'));
    assert.equal(second.store.clientSessions()[b.base].autoConnect, true);
    assert.equal(second.store.clientView().page, 'chat');
    await second.close();
  } finally {
    await f.close();
  }
});

test('新记录保留中转站名称快照，旧 JSON 不回填，其他来源可筛选且跨站相同传输 ID 不覆盖', async () => {
  const f = await fixture();
  try {
    const sender = await f.join('发送'),
      receiver = await f.join('接收');
    f.service.store.saveSettings({
      ...f.service.store.settings,
      stationName: '原名称',
      deviceId: sender.self.id,
    });
    const { t } = await f.transfer(sender, receiver);
    assert.equal(t.stationName, '原名称');
    f.service.store.saveSettings({ ...f.service.store.settings, stationName: '新名称' });
    assert.equal(f.service.getTransfer(t.id).stationName, '原名称');
    const remote = { ...t, stationId: randomUUID(), stationName: '远端名称' };
    f.service.store.remember([remote]);
    const legacy = { ...t, id: randomUUID(), stationId: randomUUID() };
    delete legacy.stationName;
    f.service.store.remember([legacy]);
    const rawBefore = f.service.store.db
      .prepare('SELECT data FROM remote_records WHERE id=?')
      .get(`${legacy.stationId}:${legacy.id}`).data;
    const legacyFile = {
      id: randomUUID(),
      name: '旧文件',
      path: '/tmp/old',
      size: 2,
      receivedAt: Date.now(),
    };
    f.service.store.saveReceived(legacyFile);
    const second = new RelayService(f.dir, path.resolve('dist'));
    assert.equal(
      second.store.db
        .prepare('SELECT data FROM remote_records WHERE id=?')
        .get(`${legacy.stationId}:${legacy.id}`).data,
      rawBefore,
    );
    assert.deepEqual(second.store.received()[0], legacyFile);
    assert.equal(second.store.records().filter((r) => r.id === t.id).length, 2);
    await second.close();
    const response = await f.call(
      '/admin/records?station=other',
      f.service.adminToken,
      undefined,
      'GET',
      f.service.controlUrl,
    );
    assert.equal(response.data.total, 1);
    assert.equal(response.data.items[0].id, legacy.id);
    assert.ok(response.data.stations.some((s) => s.id === 'other' && s.name === '其他'));
    const remoteOnly = await f.call(
      `/admin/records?station=${remote.stationId}`,
      f.service.adminToken,
      undefined,
      'GET',
      f.service.controlUrl,
    );
    assert.equal(remoteOnly.data.total, 1);
    assert.equal(remoteOnly.data.items[0].stationName, '远端名称');
  } finally {
    await f.close();
  }
});
