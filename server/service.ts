import { detectPlatform, normalizePlatform } from '../src/devicePlatform';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import staticFiles from '@fastify/static';
import websocket from '@fastify/websocket';
import { WebSocket } from 'ws';
import { createHash, randomBytes, randomUUID, randomInt } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  existsSync,
  readdirSync,
  statSync,
  statfsSync,
  renameSync,
  rmSync,
  cpSync,
} from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';
import path from 'node:path';
import os from 'node:os';
import { ChatStore, registerChat } from './chat';
import { Store, type Device, type Transfer, type SavedConnection, activeStatuses } from './store';

const token = () => randomBytes(32).toString('hex');
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
function fail(message: string, statusCode = 400): never {
  throw Object.assign(new Error(message), { statusCode });
}
function cleanName(name: unknown) {
  if (typeof name !== 'string' || !name.trim() || name.length > 240 || /[\x00-\x1f]/.test(name))
    fail('名称无效，最多 240 个字符');
  return name.trim();
}
function bearer(r: FastifyRequest) {
  return String(r.headers.authorization ?? '').replace(/^Bearer /, '');
}

export class RelayService {
  store: Store;
  chat: ChatStore;
  closed = false;
  adminToken = token();
  pairingToken = token();
  pairingCode = String(randomInt(0, 1_000_000)).padStart(6, '0');
  pairingCodeExpiresAt = Date.now() + 5 * 60_000;
  pairingAttempts = new Map<string, { count: number; until: number }>();
  rotateCode() {
    const previous = this.pairingCode;
    do {
      this.pairingCode = String(randomInt(0, 1_000_000)).padStart(6, '0');
    } while (this.pairingCode === previous);
    this.pairingCodeExpiresAt = Date.now() + 5 * 60_000;
  }
  cancelDeviceTransfers(id: string) {
    for (const t of this.store.transfers())
      if (activeStatuses.includes(t.status) && (t.senderId === id || t.recipientId === id)) {
        this.update(t, { status: 'cancelled', error: '设备身份已更换或已被清除' });
        this.streams.get(t.id)?.abort();
      }
  }
  revokeDevice(id: string) {
    this.cancelDeviceTransfers(id);
    this.detachDevice(id, 4001, '设备身份已失效');
    const d = this.store.device(id);
    if (d) this.store.saveDevice({ ...d, disconnectedAt: Date.now() }, digest(token()));
    this.broadcast();
  }
  detachDevice(id: string, code: number, reason: string) {
    const c = this.clients.get(id);
    if (!c) return;
    this.clients.delete(id);
    this.store.disconnect(c.connection);
    const d = this.store.device(id);
    if (d) this.store.saveDevice({ ...d, disconnectedAt: Date.now() });
    const timer = setTimeout(() => c.socket.terminate(), 500);
    timer.unref();
    c.socket.once('close', () => clearTimeout(timer));
    c.socket.close(code, reason);
    this.broadcast();
  }
  forgetDevice(id: string) {
    this.revokeDevice(id);
    this.chat.forget(id);
    this.store.db.prepare('DELETE FROM connections WHERE deviceId=?').run(id);
    this.store.db.prepare('DELETE FROM devices WHERE id=?').run(id);
  }
  hub: FastifyInstance | null = null;
  control: FastifyInstance | null = null;
  controlUrl = '';
  clients = new Map<string, { socket: WebSocket; connection: number; alive: boolean }>();
  streams = new Map<string, AbortController>();
  cleanTimer: NodeJS.Timeout;
  heartbeat: NodeJS.Timeout;
  lastBroadcast = 0;
  constructor(
    dataDir: string,
    readonly webRoot: string,
    receiveDir?: string,
  ) {
    this.store = new Store(dataDir, receiveDir);
    this.chat = new ChatStore(this.store.db);
    this.ensureCache();
    this.cleanTimer = setInterval(() => this.cleanup(), 30_000);
    this.cleanTimer.unref();
    this.heartbeat = setInterval(() => {
      for (const c of this.clients.values()) {
        if (!c.alive) c.socket.terminate();
        else {
          c.alive = false;
          c.socket.ping();
        }
      }
    }, 15_000);
    this.heartbeat.unref();
    this.reconcile();
    this.cleanup();
  }
  ensureCache() {
    for (const p of ['partial', 'ready'])
      mkdirSync(path.join(this.store.settings.cacheDir, p), { recursive: true });
  }
  file(t: Transfer, partial = false) {
    return path.join(this.store.settings.cacheDir, partial ? 'partial' : 'ready', t.id);
  }
  reconcile() {
    for (const t of this.store.transfers())
      if (
        !t.cleanedAt &&
        t.uploaded > 0 &&
        !existsSync(this.file(t)) &&
        !existsSync(this.file(t, true))
      )
        this.store.saveTransfer({
          ...t,
          cleanedAt: Date.now(),
          ...(activeStatuses.includes(t.status)
            ? { status: 'failed' as const, error: '中转文件已不存在，请重新发送' }
            : {}),
        });
  }
  device(r: FastifyRequest): Device {
    const d = this.store.auth(digest(bearer(r)));
    return d ?? fail('连接凭证无效，请重新配对', 401);
  }
  getTransfer(id: string) {
    return this.store.transfer(id) ?? fail('传输不存在', 404);
  }
  state(d: Device) {
    return {
      stationId: this.store.settings.stationId,
      stationName: this.store.settings.stationName,
      chatLatestId: this.chat.latest(),
      chatUnread: this.chat.unread(d.id),
      self: d,
      devices: this.store
        .devices()
        .filter((x) => this.clients.has(x.id))
        .map((x) => ({ ...x, online: true })),
      transfers: this.store
        .transfers()
        .filter((t) => t.senderId === d.id || t.recipientId === d.id)
        .filter((t, i) => i < 200 || activeStatuses.includes(t.status)),
    };
  }
  broadcast(force = true) {
    if (!force && Date.now() - this.lastBroadcast < 200) return;
    this.lastBroadcast = Date.now();
    for (const [id, c] of this.clients) {
      const d = this.store.device(id);
      if (d && c.socket.readyState === WebSocket.OPEN) c.socket.send(JSON.stringify(this.state(d)));
    }
  }
  update(t: Transfer, patch: Partial<Transfer>, force = true) {
    const next = { ...this.store.transfer(t.id)!, ...patch };
    this.store.saveTransfer(next);
    this.broadcast(force);
    return next;
  }
  addresses() {
    const ips = new Set<string>();
    for (const list of Object.values(os.networkInterfaces()))
      for (const item of list ?? [])
        if (item.family === 'IPv4' && !item.internal) ips.add(item.address);
    return [...ips].map((ip) => `http://${ip}:${this.store.settings.port}`);
  }
  status() {
    return {
      running: !!this.hub,
      addresses: this.addresses(),
      pairingToken: this.pairingToken,
      pairingCode: this.pairingCode,
      pairingCodeExpiresAt: this.pairingCodeExpiresAt,
      settings: this.store.settings,
      dataDir: this.store.dataDir,
      databasePath: this.store.dbPath,
      sizes: this.store.sizes(),
      devices: this.store.devices().map((d) => {
        const latest = this.store.db
          .prepare(
            'SELECT MAX(connectedAt) AS time, COUNT(*) AS loginCount FROM connections WHERE deviceId=?',
          )
          .get(d.id) as { time: number | null; loginCount: number };
        return {
          ...d,
          lastSeen: latest.time ?? d.lastSeen,
          loginCount: latest.loginCount,
          online: this.clients.has(d.id),
        };
      }),
      connections: this.store.connections(),
    };
  }
  cache() {
    const transfers = new Map(this.store.transfers().map((t) => [t.id, t]));
    const entries: any[] = [];
    for (const folder of ['partial', 'ready'])
      for (const id of readdirSync(path.join(this.store.settings.cacheDir, folder))) {
        const filename = path.join(this.store.settings.cacheDir, folder, id);
        const stat = statSync(filename);
        if (!stat.isFile()) continue;
        const t = transfers.get(id);
        entries.push({
          id,
          folder,
          path: filename,
          bytes: stat.size,
          name: t?.name ?? `未关联文件 ${id}`,
          status: t?.status ?? 'orphan',
          expiresAt: t?.expiresAt ?? null,
          busy: this.streams.has(id),
          createdAt: t?.createdAt ?? stat.mtimeMs,
        });
      }
    const disk = statfsSync(this.store.settings.cacheDir);
    return {
      entries,
      totalBytes: entries.reduce((n, x) => n + x.bytes, 0),
      freeBytes: disk.bavail * disk.bsize,
      path: this.store.settings.cacheDir,
    };
  }
  removeCache(id: string) {
    if (!/^[a-zA-Z0-9-]+$/.test(id)) fail('文件标识无效');
    if (this.streams.has(id)) fail('文件正在传输，请先取消', 409);
    const t = this.store.transfer(id);
    for (const folder of ['partial', 'ready'])
      rmSync(path.join(this.store.settings.cacheDir, folder, id), { force: true });
    if (t)
      this.update(t, {
        cleanedAt: Date.now(),
        ...(activeStatuses.includes(t.status)
          ? { status: 'failed', error: '中转文件已手动清理' }
          : {}),
      });
  }
  cleanup(now = Date.now()) {
    for (const t of this.store.transfers())
      if (
        t.status === 'completed' &&
        t.expiresAt !== null &&
        t.expiresAt <= now &&
        !t.cleanedAt &&
        !this.streams.has(t.id)
      )
        this.removeCache(t.id);
  }
  async base() {
    const app = Fastify({
      logger: false,
      bodyLimit: 1_048_576,
      requestTimeout: 0,
      forceCloseConnections: true,
    });
    await app.register(cors, {
      methods: ['GET', 'HEAD', 'POST', 'PUT', 'OPTIONS'],
      origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        try {
          const u = new URL(origin);
          cb(
            null,
            u.protocol === 'http:' &&
              (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname) ||
                /^192\.168\./.test(u.hostname) ||
                /^10\./.test(u.hostname) ||
                /^172\.(1[6-9]|2\d|3[01])\./.test(u.hostname)),
          );
        } catch {
          cb(null, false);
        }
      },
    });
    app.addHook('onSend', async (_r, reply, payload) => {
      reply
        .header(
          'Content-Security-Policy',
          "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src http: ws:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        )
        .header('X-Content-Type-Options', 'nosniff')
        .header('Referrer-Policy', 'no-referrer')
        .header('Cache-Control', 'no-store');
      return payload;
    });
    app.setErrorHandler((err: any, _r, reply) =>
      reply
        .code(err.statusCode ?? 500)
        .send({ error: err.statusCode ? err.message : '操作失败，请检查磁盘空间和文件权限' }),
    );
    if (existsSync(this.webRoot))
      await app.register(staticFiles, { root: this.webRoot, index: 'index.html' });
    return app;
  }
  async startControl() {
    const app = await this.base();
    app.addHook('onRequest', async (r) => {
      if (r.url.startsWith('/admin/') && bearer(r) !== this.adminToken) fail('管理权限不足', 401);
    });
    registerChat(app, this, true);
    app.get('/admin/status', async () => this.status());
    app.post('/admin/client/session', async (r) => {
      const b = r.body as SavedConnection;
      let url: URL;
      try {
        url = new URL(b?.base);
      } catch {
        fail('中转站地址无效');
      }
      if (
        url!.protocol !== 'http:' ||
        url!.origin !== b.base ||
        b.id !== this.store.settings.deviceId ||
        typeof b.token !== 'string' ||
        !/^[a-f0-9]{64}$/.test(b.token) ||
        typeof b.stationId !== 'string' ||
        !/^[a-zA-Z0-9-]{16,80}$/.test(b.stationId) ||
        typeof b.stationName !== 'string' ||
        b.stationName.length > 240
      )
        fail('客户端连接凭证无效');
      this.store.saveClientSession({
        base: b.base,
        id: b.id,
        token: b.token,
        stationId: b.stationId,
        stationName: b.stationName,
      });
      return { ok: true };
    });
    app.post('/admin/client/join-local', async () => {
      if (!this.hub) fail('请先开启本机中转站', 409);
      const settings = this.store.settings;
      const base = `http://127.0.0.1:${(this.hub!.server.address() as any).port}`;
      const saved = this.store.clientSessions()[base];
      const valid = saved && this.store.auth(digest(saved.token))?.id === settings.deviceId;
      const secret = valid ? saved.token : token();
      const previous = this.store.device(settings.deviceId);
      const d: Device = {
        id: settings.deviceId,
        name: settings.deviceName,
        platform: process.platform === 'darwin' ? 'Mac' : 'PC',
        platformSource: 'native',
        firstSeen: previous?.firstSeen ?? Date.now(),
        lastSeen: Date.now(),
        disconnectedAt: previous?.disconnectedAt ?? Date.now(),
        ip: '127.0.0.1',
      };
      this.store.saveDevice(d, digest(secret));
      const state = this.state(d);
      this.store.saveClientSession({
        base,
        token: secret,
        id: d.id,
        stationId: state.stationId,
        stationName: state.stationName,
      });
      return { base, token: secret, ...state };
    });
    app.post('/admin/station/start', async () => {
      await this.startHub();
      return this.status();
    });
    app.post('/admin/station/stop', async (r) => {
      await this.stopHub(!!(r.body as any)?.force);
      return this.status();
    });
    app.post('/admin/pairing/rotate', async () => {
      this.pairingToken = token();
      this.rotateCode();
      return this.status();
    });
    app.post('/admin/pairing/code', async () => {
      this.rotateCode();
      return this.status();
    });
    app.post('/admin/identity/reset', async () => {
      this.revokeDevice(this.store.settings.deviceId);
      this.store.clearClientSessions();
      this.store.saveSettings({ ...this.store.settings, deviceId: randomUUID() });
      return this.status();
    });
    app.post('/admin/device/delete', async (r) => {
      const id = (r.body as any)?.id;
      if (typeof id !== 'string' || !this.store.device(id)) fail('设备不存在', 404);
      this.forgetDevice(id);
      return { ok: true };
    });
    app.post('/admin/device/disconnect', async (r) => {
      const id = (r.body as any)?.id;
      this.detachDevice(id, 4003, '管理员断开连接');
      return { ok: true };
    });
    app.get('/admin/cache', async () => this.cache());
    app.post('/admin/cache/delete', async (r) => {
      const ids = (r.body as any)?.ids;
      if (!Array.isArray(ids) || ids.length > 1000) fail('清理列表无效');
      const results = ids.map((id) => {
        try {
          this.removeCache(String(id));
          return { id, ok: true };
        } catch (e: any) {
          return { id, ok: false, error: e.message };
        }
      });
      return { results };
    });
    app.get('/admin/received', async () => ({
      entries: this.store.received().map((f) => ({ ...f, exists: existsSync(f.path) })),
    }));
    app.post('/admin/received/delete', async (r) => {
      const ids = (r.body as any)?.ids;
      if (!Array.isArray(ids) || ids.length > 1000) fail('清理列表无效');
      let deleted = 0;
      for (const f of this.store.received())
        if (ids.includes(f.id)) {
          rmSync(f.path, { force: true });
          this.store.db.prepare('DELETE FROM received_files WHERE id=?').run(f.id);
          deleted++;
        }
      return { deleted };
    });
    app.get('/admin/records', async (r) => {
      const q = r.query as any;
      const all = this.store
        .records()
        .filter(
          (t) =>
            !q.search ||
            [t.name, t.senderName, t.recipientName].some((x) =>
              x.toLowerCase().includes(String(q.search).toLowerCase()),
            ),
        );
      const visible = all.filter(
        (t) =>
          !q.direction ||
          q.direction === 'all' ||
          (q.direction === 'send'
            ? t.senderId === this.store.settings.deviceId
            : t.recipientId === this.store.settings.deviceId),
      );
      const offset = Math.max(0, Number(q.offset) || 0);
      return { items: visible.slice(offset, offset + 50), total: visible.length };
    });
    app.post('/admin/remember', async (r) => {
      const records = (r.body as any)?.records;
      if (!Array.isArray(records) || records.length > 500) fail('记录无效');
      this.store.remember(records);
      return { ok: true };
    });
    app.post('/admin/records/clear', async () => ({ deleted: this.store.clearRecords() }));
    app.post('/admin/devices/clear', async (r) => {
      const hours = (r.body as any)?.hours;
      if (![1, 24, 168, 720].includes(hours)) fail('请选择有效的清理时间范围');
      const before = Date.now() - hours * 60 * 60_000;
      let deleted = 0;
      for (const d of this.store.devices()) {
        const latest = this.store.db
          .prepare(
            'SELECT MAX(connectedAt) AS time, COUNT(*) AS loginCount FROM connections WHERE deviceId=?',
          )
          .get(d.id) as { time: number | null; loginCount: number };
        if (!this.clients.has(d.id) && (latest.time ?? d.lastSeen) < before) {
          this.forgetDevice(d.id);
          deleted++;
        }
      }
      return { deleted };
    });
    app.post('/admin/database/compact', async () => {
      this.store.db.exec(
        'PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);',
      );
      return this.store.sizes();
    });
    app.post('/admin/settings', async (r) => {
      const b = r.body as any;
      const s = { ...this.store.settings };
      if (b.stationName !== undefined) {
        if (
          typeof b.stationName !== 'string' ||
          !b.stationName.trim() ||
          b.stationName.trim().length > 80
        )
          fail('中转站名称需为 1–80 个字符');
        s.stationName = cleanName(b.stationName).slice(0, 80);
      }
      if (b.deviceName !== undefined) s.deviceName = cleanName(b.deviceName).slice(0, 80);
      if (b.port !== undefined && b.port !== s.port) {
        if (this.hub) fail('修改端口前请关闭中转站', 409);
        if (!Number.isInteger(b.port) || b.port < 1024 || b.port > 65535)
          fail('端口需在 1024–65535 之间');
        s.port = b.port;
      }
      if (b.retentionHours !== undefined) {
        if (
          typeof b.retentionHours !== 'number' ||
          b.retentionHours < 0.01 ||
          b.retentionHours > 720
        )
          fail('保留时间需在 0.01–720 小时之间');
        s.retentionHours = b.retentionHours;
      }
      if (b.receiveDir !== undefined) {
        if (typeof b.receiveDir !== 'string' || !path.isAbsolute(b.receiveDir))
          fail('请选择绝对路径');
        mkdirSync(b.receiveDir, { recursive: true });
        s.receiveDir = b.receiveDir;
      }
      if (b.cacheDir !== undefined && b.cacheDir !== s.cacheDir) {
        if (this.hub || this.streams.size) fail('迁移存储位置前请关闭中转站', 409);
        if (typeof b.cacheDir !== 'string' || !path.isAbsolute(b.cacheDir)) fail('请选择绝对路径');
        const target = path.resolve(b.cacheDir),
          source = path.resolve(s.cacheDir);
        if (
          target === source ||
          target.startsWith(source + path.sep) ||
          source.startsWith(target + path.sep) ||
          target === this.store.dataDir
        )
          fail('请选择独立的缓存目录');
        mkdirSync(target, { recursive: true });
        if (readdirSync(target).length) fail('新缓存目录必须为空，以免覆盖已有文件');
        try {
          cpSync(source, target, { recursive: true, errorOnExist: true, force: false });
        } catch (e) {
          for (const dir of ['partial', 'ready'])
            rmSync(path.join(target, dir), { recursive: true, force: true });
          throw e;
        }
        s.cacheDir = target;
        this.store.saveSettings(s);
        rmSync(source, { recursive: true, force: true });
      }
      this.store.saveSettings(s);
      // Retention changes apply to completed caches as well.
      for (const t of this.store.transfers())
        if (t.status === 'completed' && !t.cleanedAt && t.completedAt)
          this.update(t, { expiresAt: t.completedAt + s.retentionHours * 3600_000 });
      this.cleanup();
      this.broadcast();
      return this.status();
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    this.control = app;
    this.controlUrl = `http://127.0.0.1:${(app.server.address() as any).port}`;
    return this.controlUrl;
  }
  async startHub() {
    if (this.hub) return;
    const app = await this.base();
    await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
    app.addContentTypeParser('application/octet-stream', (req, payload, done) =>
      done(null, payload),
    );
    registerChat(app, this, false);
    app.get('/api/info', async () => ({
      app: 'Relay3',
      name: this.store.settings.stationName,
      stationId: this.store.settings.stationId,
      running: true,
      onlineDevices: this.clients.size,
    }));
    app.post('/api/join', async (r) => {
      const b = r.body as any;
      if (!b || typeof b.id !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(b.id))
        fail('设备标识无效');
      const previous = this.store.device(b.id);
      const authed = this.store.auth(digest(bearer(r)));
      const usingCode = typeof b.pairingCode === 'string';
      if (usingCode) {
        const now = Date.now();
        for (const [ip, attempt] of this.pairingAttempts)
          if (attempt.until < now) this.pairingAttempts.delete(ip);
        const attempt = this.pairingAttempts.get(r.ip) ?? { count: 0, until: now + 60_000 };
        if (attempt.count >= 10) fail('尝试过于频繁，请稍后再试', 429);
        attempt.count++;
        this.pairingAttempts.set(r.ip, attempt);
        if (
          !/^\d{6}$/.test(b.pairingCode) ||
          b.pairingCode !== this.pairingCode ||
          now >= this.pairingCodeExpiresAt
        )
          fail('一次性配对码无效或已过期，请使用中转站当前的 6 位数字', 401);
      } else if (b.pairingToken !== this.pairingToken && authed?.id !== b.id)
        fail('配对凭证无效，请重新扫码或输入一次性配对码', 401);
      if (previous && authed?.id !== b.id)
        fail('该设备已配对，请使用原连接凭证或重置设备身份', 409);
      const secret = authed?.id === b.id ? bearer(r) : token();
      const reportedPlatform = normalizePlatform(
        typeof b.platform === 'string' ? b.platform : undefined,
      );
      const inferred = detectPlatform({ userAgent: r.headers['user-agent'] ?? '' });
      const platform =
        reportedPlatform !== 'Unknown'
          ? reportedPlatform
          : inferred.platform !== 'Unknown'
            ? inferred.platform
            : (previous?.platform ?? 'Unknown');
      const platformSource =
        reportedPlatform !== 'Unknown'
          ? ['native', 'browser-platform', 'user-agent'].includes(b.platformSource)
            ? b.platformSource
            : 'user-agent'
          : inferred.platform !== 'Unknown'
            ? inferred.source
            : (previous?.platformSource ?? 'unknown');
      const d: Device = {
        id: b.id,
        name: cleanName(b.name).slice(0, 80),
        platform,
        platformSource,
        firstSeen: previous?.firstSeen ?? Date.now(),
        lastSeen: Date.now(),
        disconnectedAt: previous?.disconnectedAt ?? Date.now(),
        ip: r.ip,
      };
      this.store.saveDevice(d, digest(secret));
      if (usingCode) this.rotateCode();
      return { token: secret, ...this.state(d) };
    });
    app.get('/api/ws', { websocket: true }, (socket, r) => {
      const secret = (r.query as any).token;
      const d = typeof secret === 'string' && this.store.auth(digest(secret));
      if (!d) {
        socket.close(4001, '凭证无效');
        return;
      }
      const old = this.clients.get(d.id);
      if (old) old.socket.close(4002, '设备已从另一窗口连接');
      const next = { ...d, lastSeen: Date.now(), disconnectedAt: null, ip: r.ip };
      this.store.saveDevice(next);
      const connection = this.store.connection(next);
      const client = { socket, connection, alive: true };
      this.clients.set(d.id, client);
      socket.on('pong', () => {
        client.alive = true;
        const current = this.store.device(d.id);
        if (current) this.store.saveDevice({ ...current, lastSeen: Date.now() });
      });
      socket.on('error', () => {});
      socket.on('close', () => {
        if (this.closed) return;
        this.store.disconnect(connection);
        if (this.clients.get(d.id) === client) {
          this.clients.delete(d.id);
          const current = this.store.device(d.id);
          if (current)
            this.store.saveDevice({
              ...current,
              lastSeen: Date.now(),
              disconnectedAt: Date.now(),
            });
          this.broadcast();
        }
      });
      this.broadcast();
    });
    app.get('/api/state', async (r) => this.state(this.device(r)));
    app.get('/api/history', async (r) => {
      const d = this.device(r);
      const q = r.query as any;
      const all = this.store
        .transfers()
        .filter((t) => t.senderId === d.id || t.recipientId === d.id)
        .filter(
          (t) =>
            !q.search ||
            [t.name, t.senderName, t.recipientName].some((x) =>
              x.toLowerCase().includes(String(q.search).toLowerCase()),
            ),
        );
      const visible = all.filter(
        (t) =>
          !q.direction ||
          q.direction === 'all' ||
          (q.direction === 'send' ? t.senderId === d.id : t.recipientId === d.id),
      );
      const offset = Math.max(0, Number(q.offset) || 0);
      return { items: visible.slice(offset, offset + 50), total: visible.length };
    });
    app.post('/api/identity/reset', async (r) => {
      this.revokeDevice(this.device(r).id);
      return { ok: true };
    });
    app.post('/api/device', async (r) => {
      const d = this.device(r);
      const next = { ...d, name: cleanName((r.body as any)?.name).slice(0, 80) };
      this.store.saveDevice(next);
      this.broadcast();
      return next;
    });
    app.post('/api/transfers', async (r) => {
      const d = this.device(r),
        b = r.body as any;
      if (!this.clients.has(d.id)) fail('设备尚未连接，请等待连接建立', 409);
      const recipient = this.store.device(String(b?.recipientId));
      if (!recipient || !this.clients.has(recipient.id) || recipient.id === d.id)
        fail('请选择另一台在线设备');
      if (!Number.isSafeInteger(b.size) || b.size < 0) fail('文件大小无效');
      if (
        this.store
          .transfers()
          .filter((t) => t.senderId === d.id && activeStatuses.includes(t.status)).length >= 100
      )
        fail('待传输文件过多，请先完成现有传输');
      const t: Transfer = {
        id: randomUUID(),
        stationId: this.store.settings.stationId,
        name: cleanName(b.name),
        size: b.size,
        senderId: d.id,
        senderName: d.name,
        senderPlatform: d.platform,
        recipientId: recipient.id,
        recipientName: recipient.name,
        recipientPlatform: recipient.platform,
        status: 'pending',
        createdAt: Date.now(),
        startedAt: null,
        completedAt: null,
        duration: null,
        uploaded: 0,
        downloaded: 0,
        sha256: null,
        expiresAt: null,
        cleanedAt: null,
        error: null,
      };
      this.store.saveTransfer(t);
      this.broadcast();
      return t;
    });
    app.post('/api/transfers/:id/:action', async (r) => {
      const d = this.device(r),
        p = r.params as any,
        t = this.getTransfer(p.id);
      if (t.senderId !== d.id && t.recipientId !== d.id) fail('无权操作此传输', 403);
      if (p.action === 'cancel') {
        if (!activeStatuses.includes(t.status)) fail('传输已结束', 409);
        this.streams.get(t.id)?.abort();
        return this.update(t, { status: 'cancelled', error: '传输已取消' });
      }
      if (d.id !== t.recipientId) fail('只有接收设备可以操作', 403);
      if (p.action === 'accept' && t.status === 'pending')
        return this.update(t, { status: 'accepted' });
      if (p.action === 'reject' && t.status === 'pending')
        return this.update(t, { status: 'rejected', error: '接收设备拒绝了文件' });
      if (p.action === 'complete' && t.status === 'awaiting-confirm') {
        const now = Date.now();
        return this.update(t, {
          status: 'completed',
          completedAt: now,
          duration: (t.uploadDuration ?? 0) + (t.downloadDuration ?? 0),
          expiresAt: now + this.store.settings.retentionHours * 3600_000,
        });
      }
      fail('传输状态已变化，请刷新后重试', 409);
    });
    app.put('/api/transfers/:id/upload', async (r, reply) => {
      const d = this.device(r),
        t = this.getTransfer((r.params as any).id);
      if (d.id !== t.senderId) fail('只有发送设备可以上传', 403);
      if (t.status !== 'accepted' || this.streams.has(t.id)) fail('等待接收设备确认后再上传', 409);
      const disk = statfsSync(this.store.settings.cacheDir);
      if (disk.bavail * disk.bsize < t.size + 64 * 1024 * 1024) fail('中转站磁盘空间不足', 507);
      const controller = new AbortController();
      this.streams.set(t.id, controller);
      this.update(t, { status: 'uploading', startedAt: Date.now(), error: null });
      let bytes = 0,
        lastSave = 0;
      const hash = createHash('sha256');
      try {
        const meter = new Transform({
          transform: (chunk, _enc, cb) => {
            bytes += chunk.length;
            if (bytes > t.size) return cb(new Error('上传字节数超过声明大小'));
            hash.update(chunk);
            if (Date.now() - lastSave > 300) {
              lastSave = Date.now();
              this.update(t, { uploaded: bytes }, false);
            }
            cb(null, chunk);
          },
        });
        await pipeline(
          r.body as Readable,
          meter,
          createWriteStream(this.file(t, true), { flags: 'wx' }),
          { signal: controller.signal },
        );
        if (bytes !== t.size) throw new Error('文件大小不匹配，请重新发送');
        if (this.getTransfer(t.id).status === 'cancelled') fail('传输已取消', 409);
        renameSync(this.file(t, true), this.file(t));
        this.update(t, {
          status: 'ready',
          uploaded: bytes,
          uploadDuration: Date.now() - (this.getTransfer(t.id).startedAt ?? Date.now()),
          sha256: hash.digest('hex'),
        });
        return { ok: true };
      } catch (e: any) {
        const current = this.getTransfer(t.id);
        if (current.status !== 'cancelled')
          this.update(t, {
            status: 'failed',
            uploaded: bytes,
            error: e.name === 'AbortError' ? '上传已中断' : e.message,
          });
        if (!reply.sent)
          return reply.code(409).send({ error: this.getTransfer(t.id).error ?? '上传中断' });
      } finally {
        this.streams.delete(t.id);
      }
    });
    app.get('/api/transfers/:id/download', async (r, reply) => {
      const query = r.query as any;
      const d =
        this.store.auth(digest(typeof query.token === 'string' ? query.token : bearer(r))) ??
        fail('连接凭证无效', 401);
      const t = this.getTransfer((r.params as any).id);
      if (d.id !== t.recipientId) fail('只有接收设备可以下载', 403);
      if (
        !['ready', 'awaiting-confirm'].includes(t.status) ||
        t.cleanedAt ||
        this.streams.has(t.id)
      )
        fail('文件暂不可下载', 409);
      if (!existsSync(this.file(t))) fail('缓存文件已不存在', 404);
      const controller = new AbortController();
      this.streams.set(t.id, controller);
      this.update(t, { status: 'downloading', downloaded: 0 });
      const downloadStarted = Date.now();
      const stream = createReadStream(this.file(t));
      let bytes = 0,
        lastSave = 0;
      stream.on('data', (chunk) => {
        bytes += chunk.length;
        if (Date.now() - lastSave > 300) {
          lastSave = Date.now();
          this.update(t, { downloaded: bytes }, false);
        }
      });
      controller.signal.addEventListener('abort', () => stream.destroy(new Error('下载已取消')), {
        once: true,
      });
      const finish = (success: boolean) => {
        if (!this.streams.has(t.id)) return;
        this.streams.delete(t.id);
        const current = this.getTransfer(t.id);
        if (current.status === 'cancelled') return;
        this.update(t, {
          status: success ? 'awaiting-confirm' : 'ready',
          downloaded: bytes,
          ...(success ? { downloadDuration: Date.now() - downloadStarted } : {}),
          error: success ? null : '下载中断，可重新接收',
        });
      };
      reply.raw.on('finish', () => finish(bytes === t.size));
      reply.raw.on('close', () => {
        if (!reply.raw.writableFinished) {
          stream.destroy();
          finish(false);
        }
      });
      stream.on('error', () => finish(false));
      reply
        .header('Content-Type', 'application/octet-stream')
        .header('Content-Length', t.size)
        .header(
          'Content-Disposition',
          `attachment; filename="Relay3-file"; filename*=UTF-8''${encodeURIComponent(t.name).replace(/'/g, '%27')}`,
        );
      return reply.send(stream);
    });
    try {
      await app.listen({ host: '0.0.0.0', port: this.store.settings.port });
      this.hub = app;
    } catch (e: any) {
      await app.close();
      if (e.code === 'EADDRINUSE')
        fail(`端口 ${this.store.settings.port} 已被占用，请关闭其他中转站或在设置中更换端口`, 409);
      throw e;
    }
  }
  async stopHub(force = false) {
    if (!this.hub) return;
    if (this.streams.size && !force) fail('当前有文件正在传输，请完成或取消后关闭', 409);
    for (const controller of this.streams.values()) controller.abort();
    const closing = [...this.clients.values()].map(
      (c) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(() => c.socket.terminate(), 500);
          c.socket.once('close', () => {
            clearTimeout(timer);
            resolve();
          });
          c.socket.close(4000, '中转站已关闭');
        }),
    );
    const app = this.hub;
    this.hub = null;
    await Promise.all(closing);
    await app.close();
  }
  async close() {
    if (this.closed) return;
    clearInterval(this.cleanTimer);
    clearInterval(this.heartbeat);
    await this.stopHub(true);
    await this.control?.close();
    this.closed = true;
    this.store.close();
  }
}
