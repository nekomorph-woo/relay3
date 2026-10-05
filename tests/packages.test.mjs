import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { RelayService } from '../dist-electron/index.js';
import { generateIdentity, encryptMessage, decryptMessage } from '../dist-electron/chatCrypto.js';
const hash = (s) => createHash('sha256').update(s).digest('hex');
async function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'relay3-packages-'));
  const s = new RelayService(dir, path.resolve('dist'));
  s.store.settings.port = 0;
  await s.startHub();
  const sockets = [];
  async function call(url, token, body, method = body === undefined ? 'GET' : 'POST') {
    const r = await s.hub.inject({
      method,
      url,
      headers: {
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(Buffer.isBuffer(body) ? { 'Content-Type': 'application/octet-stream' } : {}),
      },
      ...(body === undefined ? {} : { payload: body }),
    });
    return { status: r.statusCode, data: r.json() };
  }
  async function join(name) {
    const { data } = await call('/api/join', '', {
      id: randomUUID(),
      name,
      platform: 'PC',
      pairingToken: s.pairingToken,
    });
    const socket = await s.hub.injectWS('/api/ws?token=' + data.token, {
      socket: { remoteAddress: '127.0.0.1' },
    });
    sockets.push(socket);
    const identity = generateIdentity();
    await call('/api/chat/key', data.token, { publicKey: identity.publicKey });
    return { id: data.self.id, token: data.token, identity, socket };
  }
  const a = await join('发送端'),
    b = await join('接收端'),
    c = await join('第三方');
  function manifest(contents = ['甲', '乙'], encrypted = false, recipients = [b]) {
    const id = randomUUID(),
      publicKeys = [a, ...recipients].map((d) => ({ id: d.id, publicKey: d.identity.publicKey }));
    const context = {
      stationId: s.store.settings.stationId,
      senderId: a.id,
      remark: '公开备注',
      remarkStyle: 'note',
    };
    return {
      id,
      recipientIds: recipients.map((d) => d.id),
      bufferMinutes: 10,
      remark: context.remark,
      remarkStyle: context.remarkStyle,
      ...(encrypted
        ? {
            chat: true,
            envelope: encryptMessage(
              '文件包',
              publicKeys,
              { ...context, purpose: 'file-package', fileId: id },
              id,
            ),
          }
        : {}),
      files: contents.map((content, i) => {
        const fileId = randomUUID();
        return {
          id: fileId,
          size: Buffer.byteLength(content),
          expectedSha256: hash(content),
          ...(encrypted
            ? {
                envelope: encryptMessage(
                  `私密${i}.txt`,
                  publicKeys,
                  { ...context, purpose: 'file-name', fileId, packageId: id },
                  fileId,
                ),
              }
            : { name: `文件${i}.txt` }),
        };
      }),
    };
  }
  const upload = (body, index, content) =>
    call(`/api/files/${body.files[index].id}/upload`, a.token, Buffer.from(content), 'PUT');
  const close = async () => {
    for (const ws of sockets) ws.close();
    await s.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { s, a, b, c, call, manifest, upload, close };
}
test('清单事务回滚；全部上传前不可接收，成包时间采用最后成功上传并写入相同D/T', async () => {
  const f = await fixture();
  try {
    const invalid = f.manifest();
    invalid.files[1].size = -1;
    assert.equal((await f.call('/api/packages', f.a.token, invalid)).status, 400);
    assert.equal(f.s.files.all().length, 0);
    const body = f.manifest();
    assert.equal((await f.call('/api/packages', f.a.token, body)).status, 200);
    assert.equal((await f.call('/api/packages', f.a.token, body)).status, 200);
    assert.equal(f.s.files.all().length, 2);
    assert.equal((await f.upload(body, 0, '甲')).status, 200);
    assert.equal(f.s.files.get(body.files[0].id).state, 'staged');
    assert.equal((await f.call('/api/state', f.b.token)).data.transfers.length, 0);
    assert.equal((await f.call(`/api/files/${body.files[0].id}`, f.b.token)).status, 403);
    assert.equal((await f.call(`/api/packages/${body.id}/publish`, f.a.token, {})).status, 409);
    assert.equal((await f.upload(body, 1, '乙')).status, 200);
    const last = f.s.files.get(body.files[1].id).uploadedAt;
    const published = (await f.call(`/api/packages/${body.id}/publish`, f.a.token, {})).data;
    assert.equal(published.readyAt, last);
    assert.equal(published.receiveDeadline, last + 600000);
    assert.equal(new Set(published.files.map((x) => x.receiveDeadline)).size, 1);
    assert.equal(
      new Set(published.files.flatMap((x) => x.transfers.map((t) => t.expiresAt))).size,
      1,
    );
    assert.equal(
      (await f.call(`/api/packages/${body.id}/publish`, f.a.token, {})).data.readyAt,
      last,
    );
    assert.equal(
      (await f.call(`/api/packages/${body.id}/drop`, f.a.token, { ids: [body.files[0].id] }))
        .status,
      409,
    );
    const t = published.files[0].transfers[0];
    assert.equal((await f.call(`/api/transfers/${t.id}/accept`, f.b.token, {})).status, 200);
    assert.equal(f.s.getTransfer(published.files[1].transfers[0].id).status, 'pending');
  } finally {
    await f.close();
  }
});
test('失败重传不重传成功成员；移除失败成员后按保留成员最后上传时间成包', async () => {
  const f = await fixture();
  try {
    const body = f.manifest();
    await f.call('/api/packages', f.a.token, body);
    await f.upload(body, 0, '甲');
    const first = f.s.files.get(body.files[0].id).uploadedAt;
    assert.equal((await f.upload(body, 1, '丙')).status, 409);
    assert.equal((await f.call(`/api/packages/${body.id}/publish`, f.a.token, {})).status, 409);
    assert.equal((await f.upload(body, 1, '乙')).status, 200);
    assert.equal(f.s.files.get(body.files[0].id).uploadedAt, first);
    assert.equal((await f.call(`/api/packages/${body.id}/publish`, f.a.token, {})).status, 200);
    const second = f.manifest();
    await f.call('/api/packages', f.a.token, second);
    await f.upload(second, 0, '甲');
    const retainedAt = f.s.files.get(second.files[0].id).uploadedAt;
    assert.equal(
      (await f.call(`/api/packages/${second.id}/drop`, f.a.token, { ids: [second.files[1].id] }))
        .status,
      200,
    );
    const published = (await f.call(`/api/packages/${second.id}/publish`, f.a.token, {})).data;
    assert.equal(published.files.length, 1);
    assert.equal(published.removedCount, 1);
    assert.equal(published.readyAt, retainedAt);
  } finally {
    await f.close();
  }
});
test('群聊只在成包后生成一条消息，未授权不泄漏包元数据，接收端不获取其他名单', async () => {
  const f = await fixture();
  try {
    const body = f.manifest(['甲', '乙'], true, [f.b, f.c]);
    await f.call('/api/packages', f.a.token, body);
    assert.equal((await f.call('/api/chat/messages', f.b.token)).data.items.length, 0);
    await f.upload(body, 0, '甲');
    await f.upload(body, 1, '乙');
    await f.call(`/api/packages/${body.id}/publish`, f.a.token, {});
    const messages = (await f.call('/api/chat/messages', f.b.token)).data.items;
    assert.equal(messages.length, 1);
    assert.equal(messages[0].kind, 'package');
    assert.deepEqual(
      messages[0].envelope.recipients.map((r) => r.id),
      [f.b.id],
    );
    const view = (await f.call(`/api/packages/${body.id}`, f.b.token)).data;
    assert.deepEqual(
      view.recipients.map((d) => d.id),
      [f.b.id],
    );
    assert.equal(view.files[0].transfers.length, 1);
    const original = view.files[0];
    const context = {
      stationId: f.s.store.settings.stationId,
      senderId: f.a.id,
      remark: body.remark,
      remarkStyle: body.remarkStyle,
      purpose: 'file-name',
      fileId: original.id,
      packageId: body.id,
    };
    assert.equal(decryptMessage(original.envelope, f.b.identity, f.b.id, context), '私密0.txt');
    assert.equal(
      decryptMessage(original.envelope, f.b.identity, f.b.id, { ...context, packageId: '篡改' }),
      null,
    );
    const outsider = await f.call('/api/join', '', {
      id: randomUUID(),
      name: '未授权',
      platform: 'PC',
      pairingToken: f.s.pairingToken,
    });
    const unknown = (await f.call('/api/chat/messages', outsider.data.token)).data.items[0];
    assert.equal(unknown.envelope, null);
    assert.equal(unknown.remark, '公开备注');
    assert.equal((await f.call(`/api/packages/${body.id}`, outsider.data.token)).status, 403);
    assert.equal((await f.call(`/api/files/${original.id}`, outsider.data.token)).status, 403);
    assert.ok(
      !f.s.store.db
        .prepare('SELECT data FROM shared_files')
        .all()
        .some((r) => r.data.includes('私密')),
    );
  } finally {
    await f.close();
  }
});
test('提醒有冷却且仅在线待处理者；包级清理跳过传输文件，整包取消保持历史', async () => {
  const f = await fixture();
  try {
    const body = f.manifest();
    await f.call('/api/packages', f.a.token, body);
    await f.upload(body, 0, '甲');
    await f.upload(body, 1, '乙');
    const view = (await f.call(`/api/packages/${body.id}/publish`, f.a.token, {})).data;
    const reminder = new Promise((resolve) =>
      f.b.socket.on('message', (raw) => {
        const data = JSON.parse(raw);
        if (data.type === 'package-reminder') resolve(data);
      }),
    );
    assert.deepEqual(
      (await f.call(`/api/packages/${body.id}/remind`, f.a.token, {})).data.notified,
      [f.b.id],
    );
    assert.equal((await reminder).packageId, body.id);
    assert.equal(
      (await f.call(`/api/packages/${body.id}/remind`, f.a.token, {})).data.notified.length,
      0,
    );
    const busy = view.files[0],
      idle = view.files[1];
    f.s.streams.set(busy.id, new AbortController());
    const cleaned = await f.s.packages.clean(body.id);
    assert.equal(cleaned.results.find((r) => r.id === busy.id).ok, false);
    assert.equal(cleaned.results.find((r) => r.id === idle.id).ok, true);
    f.s.streams.delete(busy.id);
    assert.equal((await f.call(`/api/packages/${body.id}/cancel`, f.b.token, {})).status, 403);
    await f.call(`/api/packages/${body.id}/cancel`, f.a.token, {});
    assert.equal(f.s.packages.get(body.id).state, 'cancelled');
    assert.equal(f.s.getTransfer(busy.transfers[0].id).status, 'cancelled');
    assert.equal((await f.call(`/api/packages/${body.id}/publish`, f.a.token, {})).status, 409);
    assert.equal((await f.call('/api/history', f.a.token)).data.items.length, 2);
  } finally {
    await f.close();
  }
});

test('过D后排队文件不能首次下载，过T清理缓存但保持包和下载历史', async () => {
  const f = await fixture();
  try {
    const body = f.manifest();
    await f.call('/api/packages', f.a.token, body);
    await f.upload(body, 0, '甲');
    await f.upload(body, 1, '乙');
    const p = (await f.call(`/api/packages/${body.id}/publish`, f.a.token, {})).data;
    const first = p.files[0].transfers[0],
      second = p.files[1].transfers[0];
    await f.call(`/api/transfers/${first.id}/accept`, f.b.token, {});
    const download = await f.s.hub.inject({
      method: 'GET',
      url: `/api/transfers/${first.id}/download`,
      headers: { Authorization: 'Bearer ' + f.b.token },
    });
    assert.equal(download.statusCode, 200);
    assert.equal(download.body, '甲');
    await f.call(`/api/transfers/${first.id}/complete`, f.b.token, {});
    for (const file of p.files)
      f.s.files.save({ ...f.s.files.get(file.id), receiveDeadline: Date.now() - 1 });
    assert.equal((await f.call(`/api/transfers/${second.id}/accept`, f.b.token, {})).status, 409);
    assert.equal((await f.call(`/api/transfers/${second.id}/reject`, f.b.token, {})).status, 409);
    assert.equal(f.s.getTransfer(second.id).status, 'expired');
    const repeat = await f.s.hub.inject({
      method: 'GET',
      url: `/api/transfers/${first.id}/download`,
      headers: { Authorization: 'Bearer ' + f.b.token },
    });
    assert.equal(repeat.statusCode, 200);
    await f.call(`/api/transfers/${first.id}/complete`, f.b.token, {});
    const last = f.s.getTransfer(first.id).lastDownloadedAt;
    await f.s.files.cleaning;
    await f.s.files.maintenance(p.expiresAt + 1);
    assert.ok(f.s.files.get(p.files[0].id).cleanedAt);
    assert.equal(f.s.getTransfer(first.id).lastDownloadedAt, last);
    assert.equal(f.s.packages.get(p.id).state, 'ready');
    assert.equal((await f.call('/api/history?groupPackages=1', f.b.token)).data.packages.length, 1);
  } finally {
    await f.close();
  }
});

test('取消重复下载保留已收到状态，已清理的成员不能再接受；旧逐文件接口仍兼容', async () => {
  const f = await fixture();
  try {
    const body = f.manifest();
    await f.call('/api/packages', f.a.token, body);
    await f.upload(body, 0, '甲');
    await f.upload(body, 1, '乙');
    const p = (await f.call(`/api/packages/${body.id}/publish`, f.a.token, {})).data;
    const t = p.files[0].transfers[0],
      time = Date.now();
    f.s.store.saveTransfer({ ...t, status: 'downloading', lastDownloadedAt: time });
    f.s.streams.set(t.id, new AbortController());
    await f.call(`/api/packages/${p.id}/cancel`, f.a.token, {});
    assert.equal(f.s.getTransfer(t.id).status, 'completed');
    assert.equal(f.s.getTransfer(t.id).lastDownloadedAt, time);
    assert.equal(f.s.streams.get(t.id).signal.aborted, true);
    f.s.streams.delete(t.id);
    assert.equal((await f.call(`/api/transfers/${t.id}/complete`, f.b.token, {})).status, 409);
    const legacy = await f.call('/api/files', f.a.token, {
      id: randomUUID(),
      name: '旧客户端.txt',
      remark: '',
      remarkStyle: 'note',
      size: 3,
      recipientIds: [f.b.id],
      bufferMinutes: 10,
      expectedSha256: hash('甲'),
    });
    assert.equal(legacy.status, 200);
    const up = await f.call(
      `/api/files/${legacy.data.id}/upload`,
      f.a.token,
      Buffer.from('甲'),
      'PUT',
    );
    assert.equal(up.status, 200);
    assert.equal(f.s.files.get(legacy.data.id).state, 'ready');
  } finally {
    await f.close();
  }
});

test('按包分页记录不拆包；跨站缓存拒绝较旧快照，包元数据与旧记录共存', async () => {
  const f = await fixture();
  try {
    const body = f.manifest();
    await f.call('/api/packages', f.a.token, body);
    await f.upload(body, 0, '甲');
    await f.upload(body, 1, '乙');
    const p = (await f.call(`/api/packages/${body.id}/publish`, f.a.token, {})).data;
    const page = (await f.call('/api/history?groupPackages=1', f.a.token)).data;
    assert.equal(page.total, 1);
    assert.equal(page.items.length, 2);
    assert.equal(page.packages.length, 1);
    const remote = {
      ...p,
      stationId: randomUUID(),
      senderId: f.s.store.settings.deviceId,
      snapshotAt: 20,
      state: 'cancelled',
    };
    remote.files = p.files.map((file) => ({
      ...file,
      senderId: remote.senderId,
      transfers: file.transfers.map((t) => ({
        ...t,
        stationId: remote.stationId,
        senderId: remote.senderId,
        status: 'cancelled',
      })),
    }));
    f.s.packages.remember([remote]);
    f.s.packages.remember([{ ...remote, snapshotAt: 10, state: 'ready' }]);
    const cached = JSON.parse(
      f.s.store.db
        .prepare('SELECT data FROM remote_packages WHERE id=?')
        .get(`${remote.stationId}:${remote.id}`).data,
    );
    assert.equal(cached.state, 'cancelled');
    const merged = f.s.packages.recordPage(
      [...f.s.store.transfers(), ...remote.files.flatMap((file) => file.transfers)],
      0,
    );
    assert.equal(merged.total, 2);
    assert.equal(merged.packages.length, 2);
  } finally {
    await f.close();
  }
});

test('重启后保留暂存成功成员和固定期限，24小时未成包自动取消', async () => {
  const f = await fixture();
  let next;
  try {
    const draft = f.manifest();
    await f.call('/api/packages', f.a.token, draft);
    await f.upload(draft, 0, '甲');
    const body = f.manifest();
    await f.call('/api/packages', f.a.token, body);
    await f.upload(body, 0, '甲');
    await f.upload(body, 1, '乙');
    const p = (await f.call(`/api/packages/${body.id}/publish`, f.a.token, {})).data;
    const dir = f.s.store.dataDir;
    for (const d of [f.a, f.b, f.c]) d.socket.close();
    await f.s.close();
    next = new RelayService(dir, path.resolve('dist'));
    await next.startHub();
    assert.equal(next.packages.get(p.id).receiveDeadline, p.receiveDeadline);
    assert.equal(next.files.get(draft.files[0].id).state, 'staged');
    assert.equal(next.packages.view(next.packages.get(draft.id), f.a.id).files.length, 2);
    await next.files.cleaning;
    await next.files.maintenance(next.packages.get(draft.id).createdAt + 86400001);
    assert.equal(next.packages.get(draft.id).state, 'cancelled');
    assert.equal(next.files.get(draft.files[0].id).state, 'cleaned');
  } finally {
    await next?.close();
    await f.close();
  }
});

test('整包取消正在上传的成员不会复活暂存状态，缓存删除等待流收尾', async () => {
  const f = await fixture();
  const { PassThrough } = await import('node:stream');
  try {
    const body = f.manifest(['甲']);
    await f.call('/api/packages', f.a.token, body);
    const stream = new PassThrough();
    const reply = {
      status: 200,
      code(status) {
        this.status = status;
        return this;
      },
      send(data) {
        return data;
      },
    };
    const operation = f.s.files.upload(
      {
        params: { id: body.files[0].id },
        headers: { authorization: 'Bearer ' + f.a.token },
        body: stream,
      },
      reply,
    );
    while (!f.s.streams.has(body.files[0].id)) await new Promise((r) => setImmediate(r));
    await f.call(`/api/packages/${body.id}/cancel`, f.a.token, {});
    await operation;
    assert.equal(reply.status, 409);
    assert.equal(f.s.packages.get(body.id).state, 'cancelled');
    assert.equal(f.s.files.transfers(body.files[0].id)[0].status, 'cancelled');
    await f.s.files.cleaning;
    await f.s.files.maintenance();
    assert.equal(f.s.files.get(body.files[0].id).state, 'cleaned');
    assert.equal((await f.upload(body, 0, '甲')).status, 409);
  } finally {
    await f.close();
  }
});

test('正在首次或重复下载时取消文件包，下载结束回调不能覆盖取消或已收到历史', async () => {
  const f = await fixture();
  const { EventEmitter } = await import('node:events');
  try {
    for (const repeated of [false, true]) {
      const body = f.manifest(['甲']);
      await f.call('/api/packages', f.a.token, body);
      await f.upload(body, 0, '甲');
      const p = (await f.call(`/api/packages/${body.id}/publish`, f.a.token, {})).data,
        t = p.files[0].transfers[0],
        last = Date.now() - 1000;
      f.s.store.saveTransfer({
        ...t,
        status: repeated ? 'completed' : 'ready',
        ...(repeated ? { lastDownloadedAt: last } : {}),
      });
      const raw = new EventEmitter();
      raw.writableFinished = false;
      const reply = {
        raw,
        header() {
          return this;
        },
        send(stream) {
          return stream;
        },
      };
      const stream = f.s.files.download(
        { query: {}, headers: { authorization: 'Bearer ' + f.b.token } },
        reply,
        f.s.getTransfer(t.id),
      );
      stream.on('error', () => {});
      await f.call(`/api/packages/${body.id}/cancel`, f.a.token, {});
      await new Promise((r) => setImmediate(r));
      assert.equal(f.s.getTransfer(t.id).status, repeated ? 'completed' : 'cancelled');
      assert.equal(f.s.getTransfer(t.id).lastDownloadedAt, repeated ? last : null);
      raw.emit('finish');
      stream.destroy();
      assert.equal(f.s.getTransfer(t.id).status, repeated ? 'completed' : 'cancelled');
    }
  } finally {
    await f.close();
  }
});
