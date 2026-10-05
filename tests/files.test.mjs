import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { localFetch as fetch } from './http.mjs';
import { RelayService } from '../dist-electron/index.js';
import { generateIdentity, encryptMessage, decryptMessage } from '../dist-electron/chatCrypto.js';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'relay3-files-'));
  const s = new RelayService(dir, path.resolve('dist'));
  s.store.settings.port = 0;
  await s.startControl();
  await s.startHub();
  const base = `http://127.0.0.1:${s.hub.server.address().port}`;
  const sockets = [];
  const call = async (url, token, body) => {
    const res = await fetch(base + url, {
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, data: await res.json() };
  };
  async function join(name) {
    const result = await call('/api/join', '', {
      id: randomUUID(),
      name,
      platform: 'PC',
      pairingToken: s.pairingToken,
    });
    const c = result.data;
    c.socket = await s.hub.injectWS('/api/ws?token=' + c.token, {
      socket: { remoteAddress: '127.0.0.1' },
    });
    sockets.push(c.socket);
    await wait(10);
    return c;
  }
  async function create(a, targets, extra = {}) {
    return call('/api/files', a.token, {
      id: randomUUID(),
      name: '文件.txt',
      size: 3,
      recipientIds: targets.map((c) => c.self.id),
      bufferMinutes: 10,
      remark: '',
      remarkStyle: 'note',
      ...extra,
    });
  }
  async function upload(a, id) {
    const res = await fetch(base + `/api/files/${id}/upload`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${a.token}`, 'Content-Type': 'application/octet-stream' },
      body: Buffer.from('abc'),
    });
    return { status: res.status, data: await res.json() };
  }
  async function download(a, t) {
    return fetch(base + `/api/transfers/${t.id}/download`, {
      headers: { Authorization: `Bearer ${a.token}` },
    });
  }
  return {
    s,
    dir,
    base,
    call,
    join,
    create,
    upload,
    download,
    close: async () => {
      for (const socket of sockets) socket.close();
      await s.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test('离线多目标共享上传、独立接收拒绝、D/T固定和重新下载', async () => {
  const f = await fixture();
  try {
    const a = await f.join('发送者'),
      b = await f.join('接收者'),
      c = await f.join('离线接收者');
    c.socket.close();
    await wait(20);
    const result = await f.create(a, [b, c]);
    assert.equal(result.status, 200);
    const file = result.data;
    assert.equal(file.transfers.length, 2);
    assert.equal((await f.upload(a, file.id)).status, 200);
    const shared = f.s.files.get(file.id);
    assert.equal(shared.receiveDeadline - shared.uploadedAt, 600000);
    assert.equal(shared.expiresAt - shared.receiveDeadline, 3600000);
    assert.equal(f.s.cache().entries.filter((x) => x.id === file.id).length, 1);
    a.socket.close();
    await wait(10);
    const tb = file.transfers.find((t) => t.recipientId === b.self.id),
      tc = file.transfers.find((t) => t.recipientId === c.self.id);
    assert.equal((await f.download(b, tb)).status, 409);
    assert.equal((await f.call(`/api/transfers/${tb.id}/accept`, b.token, {})).status, 200);
    assert.equal(await (await f.download(b, tb)).text(), 'abc');
    await wait(20);
    assert.equal((await f.call(`/api/transfers/${tb.id}/complete`, b.token, {})).status, 200);
    assert.equal((await f.call(`/api/transfers/${tc.id}/reject`, c.token, {})).status, 200);
    assert.equal(f.s.getTransfer(tc.id).status, 'rejected');
    const completed = f.s.getTransfer(tb.id);
    assert.ok(completed.lastDownloadedAt);
    const now = Date.now();
    f.s.files.save({ ...shared, receiveDeadline: now - 1, expiresAt: now + 100000 });
    assert.equal(await (await f.download(b, tb)).text(), 'abc');
    await wait(20);
    assert.equal((await f.call(`/api/transfers/${tb.id}/complete`, b.token, {})).status, 200);
    assert.equal(f.s.files.get(file.id).expiresAt, now + 100000);
    await f.s.files.maintenance(now + 100001);
    assert.equal(f.s.files.get(file.id).state, 'cleaned');
    assert.equal(f.s.getTransfer(tb.id).status, 'completed');
    assert.equal((await f.download(b, tb)).status, 409);
    assert.equal(f.s.store.records().length, 2);
  } finally {
    await f.close();
  }
});
test('首次接收超时不可处理、越权访问拒绝、重启检查完整缓存与过期清理', async () => {
  const f = await fixture();
  try {
    const a = await f.join('A'),
      b = await f.join('B'),
      c = await f.join('C');
    assert.equal((await f.create(a, [b], { bufferMinutes: 9 })).status, 400);
    const { data: file } = await f.create(a, [b]);
    await f.upload(a, file.id);
    const t = file.transfers[0];
    assert.equal((await f.call(`/api/files/${file.id}`, c.token)).status, 403);
    assert.equal((await f.call(`/api/transfers/${t.id}/accept`, c.token, {})).status, 403);
    const old = f.s.files.get(file.id);
    f.s.files.save({ ...old, receiveDeadline: Date.now() - 1 });
    assert.equal((await f.call(`/api/transfers/${t.id}/accept`, b.token, {})).status, 409);
    assert.equal((await f.call(`/api/transfers/${t.id}/reject`, b.token, {})).status, 409);
    assert.equal(f.s.getTransfer(t.id).status, 'expired');
    await f.s.stopHub(true);
    assert.ok(existsSync(f.s.files.filename(old)));
    f.s.files.save({ ...old, expiresAt: Date.now() - 1 });
    await f.s.startHub();
    await f.s.files.cleaning;
    assert.equal(f.s.files.get(file.id).state, 'cleaned');
    assert.ok(f.s.tasks.list().some((t) => t.kind === 'scan'));
  } finally {
    await f.close();
  }
});
test('群聊文件名仅授权身份解密，数据库/传输/缓存不保存明文名称', async () => {
  const f = await fixture();
  try {
    const a = await f.join('A'),
      b = await f.join('B'),
      c = await f.join('C');
    const ka = generateIdentity(),
      kb = generateIdentity();
    await f.call('/api/chat/key', a.token, { publicKey: ka.publicKey });
    await f.call('/api/chat/key', b.token, { publicKey: kb.publicKey });
    const id = randomUUID(),
      ctx = {
        stationId: f.s.store.settings.stationId,
        senderId: a.self.id,
        remark: '公开说明',
        remarkStyle: 'note',
        purpose: 'file-name',
        fileId: id,
      };
    const envelope = encryptMessage(
      '保密文件名.txt',
      [
        { id: a.self.id, publicKey: ka.publicKey },
        { id: b.self.id, publicKey: kb.publicKey },
      ],
      ctx,
      id,
    );
    const result = await f.create(a, [b], {
      id,
      name: undefined,
      chat: true,
      envelope,
      remark: ctx.remark,
    });
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(decryptMessage(envelope, kb, b.self.id, ctx), '保密文件名.txt');
    assert.equal(decryptMessage(envelope, generateIdentity(), c.self.id, ctx), null);
    assert.equal(JSON.stringify(f.s.store.transfers()).includes('保密文件名'), false);
    assert.equal(JSON.stringify(f.s.files.all()).includes('保密文件名'), false);
    assert.equal((await f.call('/api/chat/messages', c.token)).data.items[0].kind, 'file');
    await f.upload(a, id);
    assert.equal(f.s.cache().entries[0].name, '未知文件');
    const t = result.data.transfers[0];
    await f.call(`/api/transfers/${t.id}/accept`, b.token, {});
    const response = await f.download(b, t);
    assert.equal(response.headers.get('Content-Disposition').includes('保密'), false);
    await response.text();
  } finally {
    await f.close();
  }
});
