import type { FastifyInstance } from 'fastify';
import type { RelayService } from './service';
import type { Device, Transfer } from './store';
import type { SharedFile } from './files';
import type { Envelope, ChatMessage } from '../src/chat/types';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';

export interface FilePackage {
  id: string;
  stationId: string;
  stationName: string;
  senderId: string;
  senderName: string;
  senderPlatform: string;
  createdAt: number;
  state: 'uploading' | 'ready' | 'cancelled';
  readyAt: number | null;
  cancelledAt: number | null;
  receiveDeadline: number | null;
  expiresAt: number | null;
  bufferMinutes: number;
  retentionHours: number;
  recipients: { id: string; name: string; platform: string }[];
  chat: boolean;
  envelope?: Envelope;
  chatMessageId?: number;
  remark: string;
  remarkStyle: 'hint' | 'note' | 'clue';
  requestHash: string;
}
export interface PackageView extends Omit<FilePackage, 'requestHash'> {
  files: (SharedFile & { transfers: Transfer[]; position: number })[];
  removedCount: number;
}
function fail(message: string, statusCode = 400): never {
  throw Object.assign(new Error(message), { statusCode });
}
export class FilePackages {
  mutating = new Set<string>();
  constructor(readonly service: RelayService) {
    service.store.db
      .exec(`CREATE TABLE IF NOT EXISTS file_packages(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS packages_sender ON file_packages(json_extract(data,'$.senderId'),json_extract(data,'$.createdAt'));
      CREATE TABLE IF NOT EXISTS package_files(packageId TEXT NOT NULL,fileId TEXT PRIMARY KEY,position INTEGER NOT NULL,removedAt INTEGER);
      CREATE INDEX IF NOT EXISTS package_members ON package_files(packageId,position);
      CREATE TABLE IF NOT EXISTS package_reminders(packageId TEXT NOT NULL,deviceId TEXT NOT NULL,remindedAt INTEGER NOT NULL,PRIMARY KEY(packageId,deviceId));
      CREATE TABLE IF NOT EXISTS remote_packages(id TEXT PRIMARY KEY,data TEXT NOT NULL);`);
  }
  all(): FilePackage[] {
    return (
      this.service.store.db
        .prepare("SELECT data FROM file_packages ORDER BY json_extract(data,'$.createdAt') DESC")
        .all() as { data: string }[]
    ).map((r) => JSON.parse(r.data));
  }
  get(id: string): FilePackage {
    const row = this.service.store.db
      .prepare('SELECT data FROM file_packages WHERE id=?')
      .get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : fail('文件包不存在', 404);
  }
  save(p: FilePackage) {
    this.service.store.db
      .prepare('INSERT OR REPLACE INTO file_packages VALUES (?,?)')
      .run(p.id, JSON.stringify(p));
  }
  members(id: string, includeRemoved = false) {
    return this.service.store.db
      .prepare(
        `SELECT fileId,position,removedAt FROM package_files WHERE packageId=? ${includeRemoved ? '' : 'AND removedAt IS NULL'} ORDER BY position`,
      )
      .all(id) as { fileId: string; position: number; removedAt: number | null }[];
  }
  authorized(p: FilePackage, id: string) {
    if (id !== p.senderId && !p.recipients.some((d) => d.id === id)) return false;
    return (
      !p.chat ||
      !!p.envelope?.recipients.some((r) => r.id === id && r.publicKey === this.service.chat.key(id))
    );
  }
  transferVisible(t: Transfer, id: string) {
    if (!t.packageId) return true;
    const p = this.get(t.packageId);
    return this.authorized(p, id) && (!!p.readyAt || id === p.senderId);
  }
  view(p: FilePackage, id?: string): PackageView {
    if (id && (!this.authorized(p, id) || (!p.readyAt && id !== p.senderId)))
      fail('无权查看此文件包', 403);
    const { requestHash, ...visible } = p;
    return {
      ...visible,
      envelope:
        id && id !== p.senderId && p.envelope
          ? { ...p.envelope, recipients: p.envelope.recipients.filter((r) => r.id === id) }
          : p.envelope,
      // 接收端不暴露其他接收者与各自状态。
      recipients: id && id !== p.senderId ? p.recipients.filter((d) => d.id === id) : p.recipients,
      files: this.members(p.id).map(({ fileId, position }) => {
        const f = this.service.files.get(fileId);
        this.service.files.expire(f);
        return {
          ...f,
          envelope:
            id && id !== p.senderId && f.envelope
              ? { ...f.envelope, recipients: f.envelope.recipients.filter((r) => r.id === id) }
              : f.envelope,
          position,
          transfers: this.service.files
            .transfers(fileId)
            .filter((t) => !id || id === p.senderId || t.recipientId === id),
        };
      }),
      removedCount: this.members(p.id, true).filter((f) => f.removedAt).length,
    };
  }
  assertUploading(id: string) {
    const p = this.get(id);
    if (p.state !== 'uploading' || p.createdAt + 86400000 <= Date.now() || this.mutating.has(id))
      fail('文件包已生效、已取消或正在修改', 409);
    return p;
  }
  owner(id: string, deviceId: string) {
    const p = this.get(id);
    if (p.senderId !== deviceId) fail('只有发送者可以管理文件包', 403);
    return p;
  }
  create(d: Device, b: any) {
    if (
      !b ||
      !/^[a-zA-Z0-9-]{16,80}$/.test(b.id ?? '') ||
      !Array.isArray(b.files) ||
      !b.files.length ||
      b.files.length > 100 ||
      new Set(b.files.map((f: any) => f?.id)).size !== b.files.length
    )
      fail('文件包清单无效，每包最多100个文件');
    const hash = createHash('sha256').update(JSON.stringify(b)).digest('hex');
    const existing = this.all().find((p) => p.id === b.id);
    if (existing) {
      if (existing.senderId !== d.id || existing.requestHash !== hash)
        fail('文件包标识或清单不一致', 409);
      return this.view(existing, d.id);
    }
    if (this.all().filter((p) => p.senderId === d.id && p.state === 'uploading').length >= 10)
      fail('待成包任务过多', 409);
    if (
      b.files.some(
        (f: any) =>
          !f ||
          this.service.store.db.prepare('SELECT id FROM shared_files WHERE id=?').get(f.id ?? '') ||
          !/^[a-f0-9]{64}$/.test(f.expectedSha256 ?? ''),
      )
    )
      fail('文件标识重复或缺少内容校验');
    if (!Number.isSafeInteger(b.files.reduce((sum: number, f: any) => sum + f.size, 0)))
      fail('文件包大小无效');
    const p: FilePackage = {
      id: b.id,
      stationId: this.service.store.settings.stationId,
      stationName: this.service.store.settings.stationName,
      senderId: d.id,
      senderName: d.name,
      senderPlatform: d.platform,
      createdAt: Date.now(),
      state: 'uploading',
      readyAt: null,
      cancelledAt: null,
      receiveDeadline: null,
      expiresAt: null,
      bufferMinutes: b.bufferMinutes,
      retentionHours: this.service.store.settings.retentionHours,
      recipients: [],
      chat: b.chat === true,
      envelope: b.envelope,
      remark: b.remark,
      remarkStyle: b.remarkStyle,
      requestHash: hash,
    };
    const db = this.service.store.db;
    db.exec('BEGIN');
    try {
      b.files.forEach((file: any, position: number) => {
        const f = this.service.files.create(
          d,
          {
            ...file,
            recipientIds: b.recipientIds,
            bufferMinutes: b.bufferMinutes,
            chat: p.chat,
            remark: p.remark,
            remarkStyle: p.remarkStyle,
          },
          p.id,
        );
        db.prepare('INSERT INTO package_files VALUES (?,?,?,NULL)').run(p.id, f.id, position);
      });
      p.recipients = b.recipientIds.map((id: string) => {
        const recipient = this.service.store.device(id)!;
        return { id, name: recipient.name, platform: recipient.platform };
      });
      if (p.chat) {
        // 复用文件密文结构校验，不创建额外文件或消息。
        const e = p.envelope;
        const original = b.files[0].envelope as Envelope;
        if (
          !e ||
          e.clientId !== p.id ||
          JSON.stringify(e.recipients.map((r) => [r.id, r.publicKey])) !==
            JSON.stringify(original.recipients.map((r) => [r.id, r.publicKey])) ||
          !validEnvelope(e)
        )
          fail('文件包密文无效');
      }
      this.save(p);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    this.service.broadcast();
    return this.view(p, d.id);
  }
  publish(id: string, deviceId: string) {
    const owner = this.owner(id, deviceId);
    if (owner.state === 'ready') return this.view(owner, deviceId);
    const p = this.assertUploading(id),
      files = this.members(id).map((f) => this.service.files.get(f.fileId));
    if (
      !files.length ||
      files.some(
        (f) =>
          f.state !== 'staged' ||
          this.service.files.busy(f.id) ||
          !existsSync(this.service.files.filename(f)),
      )
    )
      fail('还有文件未上传成功，请重传或移除失败文件', 409);
    // 以保留成员最后上传成功时间为准，所有记录写入同一时间，重试发布不延长。
    const readyAt = Math.max(...files.map((f) => f.uploadedAt!));
    const receiveDeadline = readyAt + p.bufferMinutes * 60000,
      expiresAt = receiveDeadline + p.retentionHours * 3600000;
    const next: FilePackage = { ...p, state: 'ready', readyAt, receiveDeadline, expiresAt };
    const db = this.service.store.db;
    db.exec('BEGIN');
    try {
      if (p.chat) {
        const result = db
          .prepare(
            'INSERT INTO chat_messages(clientId,senderId,senderName,createdAt,mode,content,envelope,remark,remarkStyle,senderPlatform,kind,packageId) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
          )
          .run(
            p.id,
            p.senderId,
            p.senderName,
            Date.now(),
            'encrypted',
            null,
            JSON.stringify(p.envelope),
            p.remark,
            p.remarkStyle,
            p.senderPlatform,
            'package',
            p.id,
          );
        next.chatMessageId = Number(result.lastInsertRowid);
      }
      this.save(next);
      for (const f of files) {
        this.service.files.save({
          ...f,
          state: 'ready',
          receiveDeadline,
          expiresAt,
          chatMessageId: next.chatMessageId,
        });
        for (const t of this.service.files.transfers(f.id))
          this.service.store.saveTransfer({
            ...t,
            status: 'pending',
            receiveDeadline,
            expiresAt,
            chatMessageId: next.chatMessageId,
          });
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    this.service.broadcast();
    return this.view(next, deviceId);
  }
  async drop(id: string, deviceId: string, ids: string[]) {
    this.owner(id, deviceId);
    this.assertUploading(id);
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || new Set(ids).size !== ids.length)
      fail('移除清单无效');
    const members = this.members(id),
      files = ids.map((fileId) => {
        if (!members.some((m) => m.fileId === fileId)) fail('文件不属于此包');
        const f = this.service.files.get(fileId);
        if (!['waiting', 'failed', 'cleaned'].includes(f.state) || this.service.files.busy(fileId))
          fail('只能移除未上传成功且未在传输的文件', 409);
        return f;
      });
    if (members.length === ids.length) fail('请至少保留一个文件，或取消整个文件包');
    this.mutating.add(id);
    try {
      for (const f of files) await this.service.files.remove(f.id);
      const db = this.service.store.db;
      db.exec('BEGIN');
      try {
        for (const f of files) {
          const removedAt = Date.now();
          db.prepare('UPDATE package_files SET removedAt=? WHERE fileId=?').run(removedAt, f.id);
          this.service.files.save({ ...this.service.files.get(f.id), removedAt });
          for (const t of this.service.files.transfers(f.id))
            this.service.store.saveTransfer({
              ...t,
              status: 'cancelled',
              cleanedAt: removedAt,
              error: '成包前已移除',
            });
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    } finally {
      this.mutating.delete(id);
    }
    this.service.broadcast();
    return this.view(this.get(id), deviceId);
  }
  async cancel(id: string, deviceId: string) {
    const p = this.owner(id, deviceId);
    if (this.mutating.has(id)) fail('文件包正在修改', 409);
    if (p.state === 'cancelled') return this.view(p, deviceId);
    const db = this.service.store.db,
      cancelledAt = Date.now();
    db.exec('BEGIN');
    try {
      this.save({ ...p, state: 'cancelled', cancelledAt });
      for (const { fileId } of this.members(id)) {
        const f = this.service.files.get(fileId);
        this.service.files.save({ ...f, expiresAt: cancelledAt });
        for (const t of this.service.files.transfers(fileId)) {
          if (
            !['completed', 'rejected', 'expired', 'receive-expired', 'cancelled'].includes(t.status)
          )
            this.service.store.saveTransfer({
              ...t,
              status: 'cancelled',
              error: '发送者已取消文件包',
            });
        }
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    for (const { fileId } of this.members(id)) {
      this.service.streams.get(fileId)?.abort();
      for (const t of this.service.files.transfers(fileId)) this.service.streams.get(t.id)?.abort();
    }
    this.service.broadcast();
    setImmediate(() => {
      if (!this.service.closing) void this.service.files.maintenance();
    });
    return this.view(this.get(id), deviceId);
  }
  async maintenance(now: number) {
    for (const p of this.all())
      if (p.state === 'uploading' && p.createdAt + 86400000 <= now && !this.mutating.has(p.id))
        await this.cancel(p.id, p.senderId);
  }
  chatMessage(m: ChatMessage, deviceId: string): ChatMessage {
    if (m.kind !== 'package' || !m.packageId) return m;
    const p = this.get(m.packageId);
    if (this.authorized(p, deviceId))
      return {
        ...m,
        envelope:
          deviceId !== p.senderId && m.envelope
            ? { ...m.envelope, recipients: m.envelope.recipients.filter((r) => r.id === deviceId) }
            : m.envelope,
      };
    return { ...m, envelope: null, content: null };
  }
  async clean(id: string) {
    const p = this.get(id);
    const results = [];
    for (const { fileId } of this.members(p.id)) {
      try {
        await this.service.files.remove(fileId);
        results.push({ id: fileId, ok: true });
      } catch (e: any) {
        results.push({ id: fileId, ok: false, error: e.message });
      }
    }
    return { results };
  }
  remind(id: string, deviceId: string) {
    const p = this.owner(id, deviceId),
      now = Date.now();
    if (p.state !== 'ready' || !p.receiveDeadline || now >= p.receiveDeadline)
      fail('文件包已结束或超过接收期限', 409);
    const notified: string[] = [],
      skipped: string[] = [];
    for (const d of p.recipients) {
      const client = this.service.clients.get(d.id);
      const pending = this.members(id).some(({ fileId }) => {
        const f = this.service.files.get(fileId);
        return (
          !f.cleanedAt &&
          f.state === 'ready' &&
          this.service.files
            .transfers(fileId)
            .some((t) => t.recipientId === d.id && ['pending', 'ready'].includes(t.status))
        );
      });
      const last = this.service.store.db
        .prepare('SELECT remindedAt FROM package_reminders WHERE packageId=? AND deviceId=?')
        .get(id, d.id) as { remindedAt: number } | undefined;
      if (
        !client ||
        client.socket.readyState !== 1 ||
        !pending ||
        !this.authorized(p, d.id) ||
        (last && now - last.remindedAt < 60000)
      ) {
        skipped.push(d.id);
        continue;
      }
      this.service.store.db
        .prepare('INSERT OR REPLACE INTO package_reminders VALUES (?,?,?)')
        .run(id, d.id, now);
      client.socket.send(
        JSON.stringify({
          type: 'package-reminder',
          packageId: id,
          senderName: p.senderName,
          stationId: p.stationId,
        }),
      );
      notified.push(d.id);
    }
    return { notified, skipped };
  }
  register(app: FastifyInstance, admin = false) {
    if (admin) {
      app.get('/admin/packages', async () => ({
        items: this.all()
          .slice(0, 100)
          .map((p) => this.view(p)),
      }));
      app.post('/admin/packages/:id/clean', async (r) => this.clean((r.params as any).id));
      app.get('/admin/packages/:id', async (r) => this.view(this.get((r.params as any).id)));
      return;
    }
    app.post('/api/packages', async (r) => this.create(this.service.device(r), r.body));
    app.get('/api/packages', async (r) => {
      const d = this.service.device(r),
        q = r.query as any;
      const all = this.all().filter(
        (p) => this.authorized(p, d.id) && (p.readyAt || p.senderId === d.id),
      );
      const offset = Math.max(0, Number(q.offset) || 0);
      return {
        items: all.slice(offset, offset + 30).map((p) => this.view(p, d.id)),
        total: all.length,
      };
    });
    app.get('/api/packages/:id', async (r) =>
      this.view(this.get((r.params as any).id), this.service.device(r).id),
    );
    app.post('/api/packages/:id/publish', async (r) =>
      this.publish((r.params as any).id, this.service.device(r).id),
    );
    app.post('/api/packages/:id/drop', async (r) =>
      this.drop((r.params as any).id, this.service.device(r).id, (r.body as any)?.ids),
    );
    app.post('/api/packages/:id/cancel', async (r) =>
      this.cancel((r.params as any).id, this.service.device(r).id),
    );
    app.post('/api/packages/:id/remind', async (r) =>
      this.remind((r.params as any).id, this.service.device(r).id),
    );
  }
}
function validEnvelope(e: Envelope) {
  const b64 = (s: any, length: number) =>
    typeof s === 'string' &&
    Buffer.from(s, 'base64').length === length &&
    Buffer.from(s, 'base64').toString('base64') === s;
  return (
    e.version === 1 &&
    b64(e.ephemeral, 32) &&
    b64(e.salt, 32) &&
    b64(e.nonce, 12) &&
    typeof e.body === 'string' &&
    b64(e.body, Buffer.from(e.body, 'base64').length) &&
    Buffer.from(e.body, 'base64').length >= 17 &&
    Buffer.from(e.body, 'base64').length <= 4016 &&
    e.recipients.every((r) => b64(r.publicKey, 32) && b64(r.nonce, 12) && b64(r.key, 48))
  );
}
