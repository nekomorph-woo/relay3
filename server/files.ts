import { assertCapacity, capacitySnapshot } from './capacity';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { RelayService } from './service';
import type { Device, Transfer } from './store';
import type { Envelope } from '../src/chat/types';
import { randomUUID, createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  renameSync,
  statfsSync,
  rmSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { diagnostic } from './diagnostics';
export interface SharedFile {
  id: string;
  packageId?: string;
  removedAt?: number;
  senderId: string;
  senderName: string;
  name: string;
  size: number;
  state: 'waiting' | 'uploading' | 'staged' | 'ready' | 'failed' | 'cleaned';
  createdAt: number;
  uploadedAt: number | null;
  uploaded: number;
  sha256: string | null;
  expectedSha256?: string;
  bufferMinutes: number;
  receiveDeadline: number | null;
  expiresAt: number | null;
  cleanedAt: number | null;
  envelope?: Envelope;
  remark: string;
  remarkStyle: 'hint' | 'note' | 'clue';
  chatMessageId?: number;
  error?: string;
}
const fail = (message: string, statusCode = 400): never => {
  throw Object.assign(new Error(message), { statusCode });
};
const b64 = (v: unknown, length: number) =>
  typeof v === 'string' &&
  Buffer.from(v, 'base64').length === length &&
  Buffer.from(v, 'base64').toString('base64') === v;
export class FileDelivery {
  cleaning: Promise<void> | null = null;
  removing = new Set<string>();
  constructor(readonly service: RelayService) {
    service.store.db.exec(
      'CREATE TABLE IF NOT EXISTS shared_files (id TEXT PRIMARY KEY, data TEXT NOT NULL)',
    );
    service.store.db.exec(
      "CREATE INDEX IF NOT EXISTS transfers_file ON transfers(json_extract(data,'$.fileId'))",
    );
    for (const f of this.all()) {
      if (f.state === 'uploading')
        this.save({ ...f, state: 'failed', error: '上传中断，请重新选择原文件重试' });
      if (['uploading', 'failed'].includes(f.state)) {
        try {
          rmSync(this.filename(f, true), { force: true });
        } catch (error) {
          diagnostic('warn', 'partial.cleanup-failed', { error });
        }
      }
    }
  }
  all(): SharedFile[] {
    return (
      this.service.store.db.prepare('SELECT data FROM shared_files').all() as { data: string }[]
    ).map((r) => JSON.parse(r.data));
  }
  get(id: string): SharedFile {
    const r = this.service.store.db.prepare('SELECT data FROM shared_files WHERE id=?').get(id) as
      { data: string } | undefined;
    return r ? JSON.parse(r.data) : fail('文件不存在', 404);
  }
  save(f: SharedFile) {
    this.service.store.db
      .prepare('INSERT OR REPLACE INTO shared_files VALUES (?,?)')
      .run(f.id, JSON.stringify(f));
  }
  filename(f: SharedFile, partial = false) {
    return path.join(this.service.store.settings.cacheDir, partial ? 'partial' : 'ready', f.id);
  }
  transfers(id: string) {
    return (
      this.service.store.db
        .prepare("SELECT data FROM transfers WHERE json_extract(data,'$.fileId')=?")
        .all(id) as { data: string }[]
    ).map((r) => JSON.parse(r.data) as Transfer);
  }
  busy(id: string) {
    return (
      this.removing.has(id) ||
      this.service.streams.has(id) ||
      this.transfers(id).some((t) => this.service.streams.has(t.id))
    );
  }
  patchTransfers(id: string, patch: Partial<Transfer>) {
    for (const t of this.transfers(id))
      this.service.store.saveTransfer({
        ...t,
        ...patch,
        ...(patch.status && ['cancelled', 'rejected', 'completed'].includes(t.status)
          ? { status: t.status }
          : {}),
      });
    this.service.broadcast();
  }
  expire(f: SharedFile, now = Date.now()) {
    if (f.receiveDeadline && now >= f.receiveDeadline)
      for (const t of this.transfers(f.id)) {
        if (t.status === 'pending' || t.status === 'ready' || t.status === 'accepted')
          this.service.store.saveTransfer({
            ...t,
            status: t.lastDownloadedAt
              ? 'completed'
              : t.status === 'pending'
                ? 'expired'
                : 'receive-expired',
          });
      }
  }
  async remove(id: string, track = true) {
    if (this.busy(id)) fail('文件正在传输，请稍后清理', 409);
    const f = this.get(id);
    const task = track
      ? this.service.tasks.start('cleanup', f.name, 1, undefined, f.id)
      : undefined;
    this.removing.add(id);
    try {
      await rm(this.filename(f), { force: true });
      await rm(this.filename(f, true), { force: true });
      this.save({ ...this.get(id), state: 'cleaned', cleanedAt: Date.now() });
      this.patchTransfers(id, { cleanedAt: Date.now() });
      if (task) {
        this.service.tasks.progress(task, 1);
        this.service.tasks.released(task, f.uploaded);
        this.service.tasks.finish(task);
      }
    } catch (error) {
      if (task) this.service.tasks.finish(task, '缓存清理失败');
      throw error;
    } finally {
      this.removing.delete(id);
    }
  }
  async maintenance(now = Date.now()) {
    if (this.service.closing || this.service.closed) return;
    if (this.cleaning || this.service.cacheMigration) return this.cleaning;
    this.cleaning = this.runMaintenance(now).finally(() => {
      this.cleaning = null;
    });
    return this.cleaning;
  }
  private async runMaintenance(now: number) {
    await this.service.packages.maintenance(now);
    const files = this.all();
    const scan = this.service.tasks.start('scan', '检查中转缓存', files.length);
    let cleanup: string | undefined;
    let checked = 0;
    try {
      for (const f of files) {
        this.expire(f, now);
        if (
          !this.busy(f.id) &&
          f.state !== 'cleaned' &&
          ((f.expiresAt !== null && f.expiresAt <= now) ||
            (f.state === 'ready' && !existsSync(this.filename(f))) ||
            ((f.state === 'waiting' || f.state === 'failed' || f.state === 'staged') &&
              f.createdAt + 86400000 <= now))
        ) {
          cleanup ??= this.service.tasks.start('cleanup', '清理过期缓存', files.length);
          try {
            await this.remove(f.id, false);
            this.service.tasks.released(cleanup, f.uploaded);
            this.service.tasks.progress(cleanup, ++checked);
          } catch (error) {
            diagnostic('error', 'cache.cleanup-failed', { error });
            this.service.tasks.finish(cleanup, '部分缓存清理失败，将稍后重试');
            cleanup = undefined;
          }
        }
        this.service.tasks.progress(scan, files.indexOf(f) + 1);
        // 每批让出事件循环，避免启动检查阻塞上传和界面请求。
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (cleanup) this.service.tasks.finish(cleanup);
      this.service.tasks.finish(scan);
      this.service.broadcast();
    } catch (e: any) {
      this.service.tasks.finish(scan, e.message);
    }
  }
  register(app: FastifyInstance) {
    app.get('/api/files/:id', async (r) => {
      const d = this.service.device(r),
        f = this.get((r.params as any).id);
      if (
        !f.chatMessageId &&
        f.senderId !== d.id &&
        !this.transfers(f.id).some((t) => t.recipientId === d.id)
      )
        fail('无权查看此文件', 403);
      if (
        f.packageId &&
        (!this.service.packages.authorized(this.service.packages.get(f.packageId), d.id) ||
          (!this.service.packages.get(f.packageId).readyAt && d.id !== f.senderId))
      )
        fail('无权查看此文件', 403);
      this.expire(f);
      return {
        ...f,
        envelope:
          f.packageId && f.envelope && d.id !== f.senderId
            ? { ...f.envelope, recipients: f.envelope.recipients.filter((r) => r.id === d.id) }
            : f.envelope,
        transfers: this.transfers(f.id).filter(
          (t) => t.senderId === d.id || t.recipientId === d.id,
        ),
      };
    });
    app.post('/api/files', async (r) => this.create(this.service.device(r), r.body));
    app.put('/api/files/:id/upload', async (r, reply) => this.upload(r, reply));
  }
  create(d: Device, b: any, packageId?: string) {
    if (!this.service.clients.has(d.id)) fail('请先连接中转站', 409);
    if (
      !b ||
      !/^[a-zA-Z0-9-]{16,80}$/.test(b.id ?? '') ||
      !Number.isSafeInteger(b.size) ||
      b.size < 0 ||
      !Number.isInteger(b.bufferMinutes) ||
      b.bufferMinutes < 10 ||
      b.bufferMinutes > 1440
    )
      fail('文件大小、标识或接收缓冲时间无效');
    if (
      !Array.isArray(b.recipientIds) ||
      !b.recipientIds.length ||
      b.recipientIds.length > 256 ||
      new Set(b.recipientIds).size !== b.recipientIds.length
    )
      fail('请选择接收设备');
    const recipients = b.recipientIds.map(
      (id: string) => this.service.store.device(id) ?? fail('接收设备已被清除'),
    );
    if (recipients.some((x: any) => x.id === d.id)) fail('不能发送给自己');
    if (
      typeof b.remark !== 'string' ||
      [...b.remark].length > 1000 ||
      !['hint', 'note', 'clue'].includes(b.remarkStyle)
    )
      fail('公开备注无效');
    if (
      b.expectedSha256 !== undefined &&
      (typeof b.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(b.expectedSha256))
    )
      fail('文件校验摘要无效');
    const existing = this.all().find((f) => f.id === b.id);
    if (existing) {
      if (existing.senderId !== d.id) fail('文件标识已占用', 409);
      return { ...existing, transfers: this.transfers(existing.id) };
    }
    if (
      this.all().filter(
        (f) => f.senderId === d.id && (f.state === 'waiting' || f.state === 'uploading'),
      ).length >= 100
    )
      fail('待上传文件过多', 409);
    if (!packageId) assertCapacity(b.size, this.service.capacity().availableBytes);
    let name = b.name;
    const e = b.envelope as Envelope | undefined;
    if (b.chat) {
      if (
        b.name !== undefined ||
        !e ||
        e.version !== 1 ||
        e.clientId !== b.id ||
        !b64(e.ephemeral, 32) ||
        !b64(e.salt, 32) ||
        !b64(e.nonce, 12) ||
        typeof e.body !== 'string' ||
        !b64(e.body, Buffer.from(e.body, 'base64').length) ||
        Buffer.from(e.body, 'base64').length < 17 ||
        Buffer.from(e.body, 'base64').length > 4016 ||
        !Array.isArray(e.recipients) ||
        e.recipients.length !== recipients.length + 1
      )
        fail('文件名密文格式无效');
      const ids = new Set<string>();
      for (const recipient of e!.recipients) {
        if (
          !recipient ||
          ids.has(recipient.id) ||
          ![d.id, ...b.recipientIds].includes(recipient.id) ||
          this.service.chat.key(recipient.id) !== recipient.publicKey ||
          !b64(recipient.publicKey, 32) ||
          !b64(recipient.nonce, 12) ||
          !b64(recipient.key, 48)
        )
          fail('接收设备公钥已变化，请刷新列表');
        ids.add(recipient.id);
      }
      name = '未知文件';
    } else if (
      typeof name !== 'string' ||
      !name.trim() ||
      name.length > 240 ||
      /[\x00-\x1f]/.test(name)
    )
      fail('文件名无效');
    const f: SharedFile = {
      id: b.id,
      packageId,
      expectedSha256: b.expectedSha256,
      senderId: d.id,
      senderName: d.name,
      name,
      size: b.size,
      state: 'waiting',
      createdAt: Date.now(),
      uploadedAt: null,
      uploaded: 0,
      sha256: null,
      bufferMinutes: b.bufferMinutes,
      receiveDeadline: null,
      expiresAt: null,
      cleanedAt: null,
      remark: b.remark,
      remarkStyle: b.remarkStyle,
      ...(b.chat ? { envelope: e } : {}),
    };
    const db = this.service.store.db;
    const ownsTransaction = !packageId;
    if (ownsTransaction) db.exec('BEGIN');
    try {
      if (b.chat && !packageId) {
        const result = db
          .prepare(
            'INSERT INTO chat_messages(clientId,senderId,senderName,createdAt,mode,content,envelope,remark,remarkStyle,senderPlatform,kind,fileId) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
          )
          .run(
            f.id,
            d.id,
            d.name,
            f.createdAt,
            'encrypted',
            null,
            JSON.stringify(e),
            f.remark,
            f.remarkStyle,
            d.platform,
            'file',
            f.id,
          );
        f.chatMessageId = Number(result.lastInsertRowid);
      }
      this.save(f);
      for (const recipient of recipients)
        this.service.store.saveTransfer({
          id: randomUUID(),
          fileId: f.id,
          packageId,
          chatMessageId: f.chatMessageId,
          stationId: this.service.store.settings.stationId,
          stationName: this.service.store.settings.stationName,
          name: f.name,
          size: f.size,
          senderId: d.id,
          senderName: d.name,
          senderPlatform: d.platform,
          recipientId: recipient.id,
          recipientName: recipient.name,
          recipientPlatform: recipient.platform,
          status: 'accepted',
          createdAt: f.createdAt,
          startedAt: null,
          completedAt: null,
          duration: null,
          uploaded: 0,
          downloaded: 0,
          sha256: null,
          expiresAt: null,
          cleanedAt: null,
          error: null,
          receiveDeadline: null,
          lastDownloadedAt: null,
        });
      if (ownsTransaction) db.exec('COMMIT');
    } catch (e) {
      if (ownsTransaction) db.exec('ROLLBACK');
      throw e;
    }
    if (!packageId) this.service.broadcast();
    return { ...f, transfers: this.transfers(f.id) };
  }
  async upload(r: FastifyRequest, reply: FastifyReply) {
    const d = this.service.device(r),
      f = this.get((r.params as any).id);
    if (f.packageId) this.service.packages.assertUploading(f.packageId);
    if (f.removedAt) fail('文件已从发送清单移除', 409);
    if (f.senderId !== d.id) fail('只有发送设备可以上传', 403);
    if (f.createdAt + 86400000 <= Date.now()) fail('上传任务已过期', 409);
    if (!['waiting', 'failed'].includes(f.state) || this.busy(f.id)) fail('文件不能重复上传', 409);
    const capacity = this.service.capacity();
    // 本文件已经在整次发送中预留，复查时仅比较所有剩余承诺与当前可用磁盘。
    assertCapacity(
      capacity.committedBytes,
      capacitySnapshot(this.service.store.settings.cacheDir).availableBytes,
    );
    const controller = new AbortController();
    this.service.streams.set(f.id, controller);
    const task = this.service.tasks.start('upload', f.name, f.size, d.name, f.id);
    const start = Date.now();
    let bytes = 0,
      last = 0;
    const hash = createHash('sha256');
    this.save({ ...f, state: 'uploading' });
    this.patchTransfers(f.id, { status: 'uploading', startedAt: start, error: null });
    try {
      await rm(this.filename(f, true), { force: true });
      const meter = new Transform({
        transform: (chunk, _enc, cb) => {
          bytes += chunk.length;
          if (bytes > f.size) return cb(new Error('上传大小超过声明大小'));
          hash.update(chunk);
          this.service.uploadBytes.set(f.id, bytes);
          this.service.tasks.progress(task, bytes);
          if (Date.now() - last > 300) {
            last = Date.now();
            this.patchTransfers(f.id, { uploaded: bytes });
          }
          cb(null, chunk);
        },
      });
      await pipeline(
        r.body as Readable,
        meter,
        createWriteStream(this.filename(f, true), { flags: 'wx' }),
        { signal: controller.signal },
      );
      if (bytes !== f.size) throw new Error('文件大小不匹配');
      const now = Date.now(),
        receiveDeadline = f.packageId ? null : now + f.bufferMinutes * 60000,
        expiresAt =
          receiveDeadline === null
            ? null
            : receiveDeadline + this.service.store.settings.retentionHours * 3600000;
      const checksum = hash.digest('hex');
      if (f.expectedSha256 && checksum !== f.expectedSha256) throw new Error('文件与原任务不一致');
      if (f.packageId) this.service.packages.assertUploading(f.packageId);
      renameSync(this.filename(f, true), this.filename(f));
      const next = {
        ...f,
        state: f.packageId ? ('staged' as const) : ('ready' as const),
        uploaded: bytes,
        uploadedAt: now,
        receiveDeadline,
        expiresAt,
        sha256: checksum,
      };
      this.save(next);
      this.patchTransfers(f.id, {
        status: f.packageId ? 'accepted' : 'pending',
        uploaded: bytes,
        sha256: next.sha256,
        uploadDuration: now - start,
        receiveDeadline,
        expiresAt,
      });
      this.service.tasks.finish(task);
      return { ok: true };
    } catch (e: any) {
      await rm(this.filename(f, true), { force: true });
      this.save({
        ...this.get(f.id),
        state: 'failed',
        uploaded: bytes,
        error: '上传中断，请重新选择原文件重试',
      });
      this.patchTransfers(f.id, {
        status: 'failed',
        uploaded: bytes,
        error: '上传中断，请重新选择原文件重试',
      });
      this.service.tasks.finish(task, '上传未完成');
      diagnostic('warn', 'file.upload-failed', { error: e });
      return reply.code(409).send({ error: '上传未完成，请重新选择原文件重试' });
    } finally {
      this.service.streams.delete(f.id);
      this.service.uploadBytes.delete(f.id);
    }
  }
  action(r: FastifyRequest, t: Transfer) {
    const d = this.service.device(r),
      action = (r.params as any).action,
      f = this.get(t.fileId!);
    this.expire(f);
    t = this.service.getTransfer(t.id);
    const now = Date.now();
    if (t.packageId && d.id === t.senderId && action === 'cancel')
      fail('请在传输详情中取消本次发送', 409);
    if (action === 'cancel' && (d.id === t.senderId || d.id === t.recipientId)) {
      if (
        !['pending', 'accepted', 'uploading', 'ready', 'downloading', 'awaiting-confirm'].includes(
          t.status,
        )
      )
        fail('传输已结束', 409);
      this.service.streams.get(t.id)?.abort();
      return this.service.update(t, { status: 'cancelled', error: '该接收任务已取消' });
    }
    if (d.id !== t.recipientId) fail('只有接收设备可以操作', 403);
    if (
      f.packageId &&
      (!this.service.packages.authorized(this.service.packages.get(f.packageId), d.id) ||
        this.service.packages.get(f.packageId).state !== 'ready')
    )
      fail('文件尚未发送或已取消', 409);
    if (action === 'complete' && t.status === 'completed') return t;
    if (action === 'complete' && t.status === 'awaiting-confirm')
      return this.service.update(t, {
        status: 'completed',
        completedAt: now,
        lastDownloadedAt: now,
        duration: (t.uploadDuration ?? 0) + (t.downloadDuration ?? 0),
        error: null,
      });
    if (f.state !== 'ready' || !f.receiveDeadline || now >= f.receiveDeadline || f.cleanedAt)
      fail('已超过接收缓冲时间或缓存不可用', 409);
    if (action === 'accept' && t.status === 'pending')
      return this.service.update(t, { status: 'ready' });
    if (action === 'reject' && t.status === 'pending')
      return this.service.update(t, { status: 'rejected' });
    fail('传输状态已变化', 409);
  }
  download(r: FastifyRequest, reply: FastifyReply, t: Transfer) {
    const query = r.query as any;
    const secret =
      typeof query.token === 'string'
        ? query.token
        : String(r.headers.authorization ?? '').replace(/^Bearer /, '');
    const d =
      this.service.store.auth(createHash('sha256').update(secret).digest('hex')) ??
      fail('连接凭证无效', 401);
    if (d.id !== t.recipientId) fail('只有接收设备可以下载', 403);
    const f = this.get(t.fileId!);
    if (
      f.packageId &&
      (!this.service.packages.authorized(this.service.packages.get(f.packageId), d.id) ||
        this.service.packages.get(f.packageId).state !== 'ready')
    )
      fail('文件尚未发送或已取消', 409);
    this.expire(f);
    t = this.service.getTransfer(t.id);
    const now = Date.now();
    const allowed = t.lastDownloadedAt
      ? ['completed', 'ready', 'awaiting-confirm'].includes(t.status) && now < (f.expiresAt ?? 0)
      : ['ready', 'awaiting-confirm'].includes(t.status) && now < (f.receiveDeadline ?? 0);
    if (this.removing.has(f.id)) fail('缓存正在清理', 409);
    if (!allowed || f.state !== 'ready' || f.cleanedAt || this.service.streams.has(t.id))
      fail('文件暂不可下载或已超时', 409);
    if (!existsSync(this.filename(f))) fail('中转缓存已不存在', 404);
    const prior = t.lastDownloadedAt ? 'completed' : 'ready';
    const controller = new AbortController();
    this.service.streams.set(t.id, controller);
    this.service.update(t, { status: 'downloading', downloaded: 0, error: null });
    const task = this.service.tasks.start('download', f.name, f.size, d.name, f.id);
    const start = Date.now();
    const stream = createReadStream(this.filename(f));
    let bytes = 0,
      last = 0,
      finished = false;
    stream.on('data', (chunk) => {
      bytes += chunk.length;
      this.service.tasks.progress(task, bytes);
      if (Date.now() - last > 300) {
        last = Date.now();
        this.service.update(t, { downloaded: bytes }, false);
      }
    });
    controller.signal.addEventListener('abort', () => stream.destroy(new Error('下载已取消')), {
      once: true,
    });
    const finish = (success: boolean) => {
      if (finished) return;
      finished = true;
      this.service.streams.delete(t.id);
      const current = this.service.getTransfer(t.id);
      if (
        current.status !== 'cancelled' &&
        (!f.packageId || this.service.packages.get(f.packageId).state !== 'cancelled')
      )
        this.service.update(current, {
          status: success ? 'awaiting-confirm' : prior,
          downloaded: bytes,
          ...(success ? { downloadDuration: Date.now() - start } : {}),
          error: success ? null : '下载中断，可重试',
        });
      this.service.tasks.finish(task, success ? undefined : '下载中断');
      void this.maintenance();
    };
    reply.raw.on('finish', () => finish(bytes === f.size));
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) {
        stream.destroy();
        finish(false);
      }
    });
    stream.on('error', () => finish(false));
    reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Length', f.size)
      .header(
        'Content-Disposition',
        `attachment; filename="Relay3-file"; filename*=UTF-8''${encodeURIComponent(f.envelope ? 'Relay3-file' : f.name).replace(/'/g, '%27')}`,
      );
    return reply.send(stream);
  }
}
