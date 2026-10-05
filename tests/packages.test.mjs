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
