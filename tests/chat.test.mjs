import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { RelayService } from '../dist-electron/index.js';
import { generateIdentity, encryptMessage, decryptMessage } from '../dist-electron/chatCrypto.js';
const pause = () => new Promise((r) => setTimeout(r, 20));
async function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'relay3-chat-test-'));
  const service = new RelayService(dir, path.resolve('dist'));
  service.store.settings.port = 0;
  await service.startControl();
  await service.startHub();
  const sockets = [];
  async function call(url, token, body, admin = false) {
    const response = await (admin ? service.control : service.hub).inject({
      url,
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: 'Bearer ' + token },
      ...(body === undefined ? {} : { payload: body }),
    });
    return { status: response.statusCode, data: response.json() };
  }
  async function join(name) {
    const id = randomUUID(),
      identity = generateIdentity();
    const { data } = await call('/api/join', '', { id, name, pairingToken: service.pairingToken });
    const socket = await service.hub.injectWS('/api/ws?token=' + data.token, {
      socket: { remoteAddress: '127.0.0.1' },
    });
    sockets.push(socket);
    await pause();
    assert.equal(
      (await call('/api/chat/key', data.token, { publicKey: identity.publicKey })).status,
      200,
    );
    return { id, identity, token: data.token };
  }
  const context = (sender, remark = '') => ({
    stationId: service.store.settings.stationId,
    senderId: sender.id,
    remark,
    remarkStyle: 'note',
  });
  async function send(sender, text, recipients = null, remark = '') {
    const clientId = randomUUID();
    const payload = recipients
      ? {
          clientId,
          mode: 'encrypted',
          remark,
          remarkStyle: 'note',
          envelope: encryptMessage(
            text,
            recipients.map((d) => ({ id: d.id, publicKey: d.identity.publicKey })),
            context(sender, remark),
            clientId,
          ),
        }
      : { clientId, mode: 'plain', content: text };
    return { ...(await call('/api/chat/messages', sender.token, payload)), payload };
  }
  async function close() {
    for (const s of sockets) s.terminate();
    await pause();
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
  return { dir, service, call, join, send, context, close };
}
test('端侧加密包含发送者和离线接收方，未授权身份和篡改无法解密', async () => {
  const f = await fixture();
  try {
    const a = await f.join('Mac'),
      b = await f.join('手机'),
      c = await f.join('PC');
    await f.call('/admin/device/disconnect', f.service.adminToken, { id: b.id }, true);
    assert.equal(f.service.clients.has(b.id), false);
    const secret = '离线接收方的秘密 <script>不渲染</script> 🌙';
    const result = await f.send(a, secret, [a, b], '公开线索');
    assert.equal(result.status, 200);
    const message = result.data;
    assert.equal(
      decryptMessage(message.envelope, a.identity, a.id, f.context(a, '公开线索')),
      secret,
    );
    assert.equal(
      decryptMessage(message.envelope, b.identity, b.id, f.context(a, '公开线索')),
      secret,
    );
    assert.equal(
      decryptMessage(message.envelope, c.identity, c.id, f.context(a, '公开线索')),
      null,
    );
    assert.equal(
      decryptMessage(message.envelope, generateIdentity(), b.id, f.context(a, '公开线索')),
      null,
    );
    assert.equal(
      decryptMessage(message.envelope, b.identity, b.id, f.context(a, '被篡改备注')),
      null,
    );
    const changed = structuredClone(message.envelope);
    changed.body = changed.body.slice(0, -4) + 'AAAA';
    assert.equal(decryptMessage(changed, b.identity, b.id, f.context(a, '公开线索')), null);
    const row = f.service.store.db
      .prepare('SELECT content,envelope,remark FROM chat_messages')
      .get();
    assert.equal(row.content, null);
    assert.ok(!row.envelope.includes(secret));
    assert.equal(row.remark, '公开线索');
    assert.equal(
      (await f.call('/api/chat/key', a.token, { publicKey: generateIdentity().publicKey })).status,
      409,
    );
    assert.equal(
      (
        await f.call('/api/chat/messages', a.token, {
          ...result.payload,
          clientId: randomUUID(),
          content: secret,
        })
      ).status,
      400,
    );
    assert.equal((await f.call('/api/chat/messages', 'wrong', result.payload)).status, 401);
  } finally {
    await f.close();
  }
});
test('原文保留、消息幂等、阅读游标单调与历史分页', async () => {
  const f = await fixture();
  try {
    const a = await f.join('Mac'),
      b = await f.join('手机');
    const text = '# 标题\n<script>window.hacked=true</script>\n**原文**';
    const first = await f.send(a, text);
    assert.equal(first.data.content, text);
    assert.equal(
      (await f.call('/api/chat/messages', a.token, first.payload)).data.id,
      first.data.id,
    );
    assert.equal((await f.send(a, 'a'.repeat(10001))).status, 400);
    assert.equal((await f.send(a, '🙂'.repeat(10000))).status, 200);
    for (let i = 0; i < 22; i++) assert.equal((await f.send(a, '历史 ' + i)).status, 200);
    const info = (await f.call('/api/chat/info', b.token)).data;
    assert.equal(info.unread, 24);
    const latest = (await f.call('/api/chat/messages?limit=20', b.token)).data;
    assert.equal(latest.items.length, 20);
    assert.equal(
      (await f.call('/api/chat/read', b.token, { messageId: info.latestId })).status,
      200,
    );
    assert.equal((await f.call('/api/chat/read', b.token, { messageId: 1 })).status, 200);
    assert.equal((await f.call('/api/chat/info', b.token)).data.cursor, info.latestId);
    assert.equal(
      (await f.call('/api/chat/read', b.token, { messageId: info.latestId + 100 })).status,
      400,
    );
    const unread = (await f.call('/api/chat/messages?after=0&limit=20', b.token)).data;
    assert.equal(unread.items[0].id, first.data.id);
    const older = (await f.call('/api/chat/messages?before=' + latest.items[0].id, b.token)).data;
    assert.equal(older.items.length, 4);
    const cursor = f.service.chat.cursor(b.id);
    await f.call('/api/chat/messages?mode=encrypted&page=1&limit=20', b.token);
    assert.equal(f.service.chat.cursor(b.id), cursor);
  } finally {
    await f.close();
  }
});
test('组合清理采用交集与预览快照，保留新消息、文件记录和持久游标', async () => {
  const f = await fixture();
  try {
    const a = await f.join('Mac'),
      b = await f.join('手机');
    const encrypted = await f.send(a, '清理前的密文', [a, b]);
    const plain = await f.send(a, '保留普通消息'),
      other = await f.send(b, '保留其他发送者');
    const filter = {
      senderId: a.id,
      mode: 'encrypted',
      before: Date.now() + 1000,
      ids: [encrypted.data.id, plain.data.id, other.data.id],
    };
    assert.equal((await f.call('/admin/chat/preview', 'wrong', filter, true)).status, 401);
    const preview = (await f.call('/admin/chat/preview', f.service.adminToken, filter, true)).data;
    assert.equal(preview.count, 1);
    await f.send(a, '预览后的密文', [a, b]);
    const clear = await f.call(
      '/admin/chat/clear',
      f.service.adminToken,
      { ...filter, throughId: preview.throughId },
      true,
    );
    assert.equal(clear.data.deleted, 1);
    assert.equal(f.service.chat.latest(), 4);
    assert.equal((await f.call('/api/chat/info', b.token)).data.unread, 3);
    assert.equal(f.service.store.connections().length, 2);
    assert.equal((await f.call('/admin/chat/preview', f.service.adminToken, {}, true)).status, 400);
    await f.call('/api/chat/read', b.token, { messageId: 4 });
    const all = await f.call('/admin/chat/preview', f.service.adminToken, { all: true }, true);
    await f.call(
      '/admin/chat/clear',
      f.service.adminToken,
      { all: true, throughId: all.data.throughId },
      true,
    );
    assert.equal(f.service.chat.latest(), 4);
    assert.equal(f.service.chat.unread(b.id), 0);
    const next = await f.send(a, '清理后消息');
    assert.equal(next.data.id, 5);
    assert.equal(f.service.chat.unread(b.id), 1);
    assert.equal(f.service.chat.cursor(b.id), 4);
    await f.service.close();
    const reopened = new RelayService(f.dir, path.resolve('dist'));
    assert.equal(reopened.chat.cursor(b.id), 4);
    assert.equal(reopened.chat.latest(), 5);
    assert.equal(reopened.chat.key(b.id), b.identity.publicKey);
    assert.equal(reopened.chat.unread(b.id), 1);
    await reopened.close();
  } finally {
    await f.close();
  }
});
