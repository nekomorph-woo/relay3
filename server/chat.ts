import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import type { RelayService } from './service';
import type { Device } from './store';
import type { ChatMessage, ChatFilter, Envelope } from '../src/chat/types';
function fail(message: string, statusCode = 400): never {
  throw Object.assign(new Error(message), { statusCode });
}
const b64 = (value: unknown, bytes: number) =>
  typeof value === 'string' &&
  /^[A-Za-z0-9+/]*={0,2}$/.test(value) &&
  Buffer.from(value, 'base64').length === bytes &&
  Buffer.from(value, 'base64').toString('base64') === value;
const chars = (s: string) => [...s].length;
export class ChatStore {
  constructor(readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS chat_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, clientId TEXT NOT NULL, senderId TEXT NOT NULL, senderName TEXT NOT NULL, createdAt INTEGER NOT NULL, mode TEXT NOT NULL, content TEXT, envelope TEXT, remark TEXT NOT NULL, remarkStyle TEXT NOT NULL, UNIQUE(senderId,clientId));
    CREATE INDEX IF NOT EXISTS chat_message_sender ON chat_messages(senderId,id);
    CREATE INDEX IF NOT EXISTS chat_message_mode ON chat_messages(mode,id);
    CREATE TABLE IF NOT EXISTS chat_keys (deviceId TEXT PRIMARY KEY, publicKey TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS chat_cursors (deviceId TEXT PRIMARY KEY, messageId INTEGER NOT NULL DEFAULT 0);`);
  }
  latest() {
    return Number(
      (this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='chat_messages'").get() as any)
        ?.seq ?? 0,
    );
  }
  key(id: string): string | null {
    return (
      (this.db.prepare('SELECT publicKey FROM chat_keys WHERE deviceId=?').get(id) as any)
        ?.publicKey ?? null
    );
  }
  cursor(id: string) {
    return Number(
      (this.db.prepare('SELECT messageId FROM chat_cursors WHERE deviceId=?').get(id) as any)
        ?.messageId ?? 0,
    );
  }
  unread(id: string) {
    return Number(
      (
        this.db
          .prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE id>?')
          .get(this.cursor(id)) as any
      ).n,
    );
  }
  ack(id: string, messageId: number) {
    if (!Number.isSafeInteger(messageId) || messageId < 0 || messageId > this.latest())
      fail('消息游标无效');
    this.db
      .prepare(
        'INSERT INTO chat_cursors VALUES (?,?) ON CONFLICT(deviceId) DO UPDATE SET messageId=MAX(messageId,excluded.messageId)',
      )
      .run(id, messageId);
  }
  forget(id: string) {
    this.db.prepare('DELETE FROM chat_keys WHERE deviceId=?').run(id);
    this.db.prepare('DELETE FROM chat_cursors WHERE deviceId=?').run(id);
  }
  read(row: any): ChatMessage {
    return { ...row, envelope: row.envelope ? JSON.parse(row.envelope) : null };
  }
  filter(filter: ChatFilter & { throughId?: number; all?: boolean }) {
    const terms: string[] = [],
      args: (string | number)[] = [];
    if (filter.before !== undefined) {
      if (!Number.isSafeInteger(filter.before) || filter.before < 0) fail('时间范围无效');
      terms.push('createdAt<?');
      args.push(filter.before);
    }
    if (filter.senderId) {
      if (typeof filter.senderId !== 'string') fail('发送设备无效');
      terms.push('senderId=?');
      args.push(filter.senderId);
    }
    if (filter.mode && filter.mode !== 'all') {
      if (!['plain', 'encrypted'].includes(filter.mode)) fail('消息模式无效');
      terms.push('mode=?');
      args.push(filter.mode);
    }
    if (filter.ids !== undefined) {
      if (
        !Array.isArray(filter.ids) ||
        !filter.ids.length ||
        filter.ids.length > 500 ||
        filter.ids.some((id) => !Number.isSafeInteger(id) || id < 1)
      )
        fail('消息选择无效');
      terms.push(`id IN (${filter.ids.map(() => '?').join(',')})`);
      args.push(...filter.ids);
    }
    if (!terms.length && filter.all !== true) fail('请选择清理范围');
    if (filter.throughId !== undefined) {
      if (
        !Number.isSafeInteger(filter.throughId) ||
        filter.throughId < 0 ||
        filter.throughId > this.latest()
      )
        fail('清理快照无效');
      terms.push('id<=?');
      args.push(filter.throughId);
    }
    return { sql: terms.length ? terms.join(' AND ') : '1=1', args };
  }
}
export function registerChat(app: FastifyInstance, service: RelayService, admin: boolean) {
  const chat = service.chat;
  if (admin) {
    app.get('/admin/chat/catalog', async () => ({
      senders: chat.db
        .prepare(
          'SELECT senderId AS id, MAX(senderName) AS name FROM chat_messages GROUP BY senderId',
        )
        .all(),
    }));
    app.post('/admin/chat/list', async (r) => {
      const b = (r.body ?? {}) as any;
      const { sql, args } = chat.filter({ ...b.filter, all: true });
      const page = Number(b.page ?? 0);
      if (!Number.isSafeInteger(page) || page < 0) fail('分页参数无效');
      return {
        total: (
          chat.db
            .prepare(`SELECT COUNT(*) AS n FROM chat_messages WHERE ${sql}`)
            .get(...args) as any
        ).n,
        items: chat.db
          .prepare(`SELECT * FROM chat_messages WHERE ${sql} ORDER BY id DESC LIMIT 20 OFFSET ?`)
          .all(...args, page * 20)
          .map((row) => chat.read(row)),
      };
    });
    app.post('/admin/chat/preview', async (r) => {
      const filter = (r.body ?? {}) as ChatFilter;
      const { sql, args } = chat.filter(filter);
      return {
        count: (
          chat.db
            .prepare(`SELECT COUNT(*) AS n FROM chat_messages WHERE ${sql}`)
            .get(...args) as any
        ).n,
        throughId: chat.latest(),
        sample: chat.db
          .prepare(`SELECT * FROM chat_messages WHERE ${sql} ORDER BY id DESC LIMIT 10`)
          .all(...args)
          .map((row) => chat.read(row)),
      };
    });
    app.post('/admin/chat/clear', async (r) => {
      const filter = (r.body ?? {}) as ChatFilter & { throughId?: number };
      if (filter.throughId === undefined) fail('请先预览清理范围');
      const { sql, args } = chat.filter(filter);
      const deleted = Number(
        chat.db.prepare(`DELETE FROM chat_messages WHERE ${sql}`).run(...args).changes,
      );
      service.broadcast();
      return { deleted };
    });
    return;
  }
  app.post('/api/chat/key', async (r) => {
    const d = service.device(r),
      key = (r.body as any)?.publicKey;
    if (!b64(key, 32)) fail('公钥无效');
    const old = chat.key(d.id);
    if (old && old !== key) fail('当前身份已绑定其他密钥，请更换设备身份', 409);
    chat.db.prepare('INSERT OR IGNORE INTO chat_keys VALUES (?,?)').run(d.id, key);
    service.broadcast();
    return { ok: true };
  });
  app.get('/api/chat/info', async (r) => {
    const d = service.device(r);
    return {
      stationId: service.store.settings.stationId,
      stationName: service.store.settings.deviceName,
      latestId: chat.latest(),
      cursor: chat.cursor(d.id),
      unread: chat.unread(d.id),
      devices: service.store
        .devices()
        .map((x) => ({ ...x, online: service.clients.has(x.id), publicKey: chat.key(x.id) })),
    };
  });
  app.post('/api/chat/read', async (r) => {
    const d = service.device(r);
    chat.ack(d.id, (r.body as any)?.messageId);
    return { ok: true };
  });
  app.get('/api/chat/messages', async (r) => {
    service.device(r);
    const q = r.query as any,
      terms: string[] = [],
      args: (string | number)[] = [];
    for (const [name, comparison] of [
      ['before', '<'],
      ['after', '>'],
      ['upper', '<='],
    ] as const)
      if (q[name] !== undefined) {
        const value = Number(q[name]);
        if (!Number.isSafeInteger(value) || value < 0) fail('消息分页参数无效');
        terms.push(`id${comparison}?`);
        args.push(value);
      }
    if (q.mode) {
      if (!['plain', 'encrypted'].includes(q.mode)) fail('消息模式无效');
      terms.push('mode=?');
      args.push(q.mode);
    }
    const where = terms.length ? terms.join(' AND ') : '1=1';
    const limit = Math.min(50, Math.max(1, Number(q.limit) || 50)),
      page = Math.max(0, Math.floor(Number(q.page) || 0));
    if (!Number.isSafeInteger(limit) || !Number.isSafeInteger(page)) fail('分页参数无效');
    const total = (
      chat.db.prepare(`SELECT COUNT(*) AS n FROM chat_messages WHERE ${where}`).get(...args) as any
    ).n;
    const order = q.after !== undefined ? 'ASC' : 'DESC';
    const rows = chat.db
      .prepare(`SELECT * FROM chat_messages WHERE ${where} ORDER BY id ${order} LIMIT ? OFFSET ?`)
      .all(...args, limit, page * limit)
      .map((row) => chat.read(row));
    return { items: order === 'DESC' ? rows.reverse() : rows, total, latestId: chat.latest() };
  });
  app.post('/api/chat/messages', async (r) => {
    const d: Device = service.device(r),
      b = r.body as any;
    if (!service.clients.has(d.id)) fail('请连接中转站后发送消息', 409);
    if (!b || typeof b.clientId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(b.clientId))
      fail('消息标识无效');
    const existing = chat.db
      .prepare('SELECT * FROM chat_messages WHERE senderId=? AND clientId=?')
      .get(d.id, b.clientId);
    if (existing) return chat.read(existing);
    if (!['plain', 'encrypted'].includes(b.mode)) fail('消息模式无效');
    const remark = b.remark ?? '',
      remarkStyle = b.remarkStyle ?? 'note';
    if (
      typeof remark !== 'string' ||
      chars(remark) > 1000 ||
      !['hint', 'note', 'clue'].includes(remarkStyle)
    )
      fail('公开备注无效，最多 1000 个字符');
    let content: string | null = null,
      envelope: Envelope | null = null;
    if (b.mode === 'plain') {
      if (typeof b.content !== 'string' || !b.content.trim() || chars(b.content) > 10000)
        fail('正文不能为空且最多 10000 个字符');
      content = b.content;
    } else {
      if (b.content !== undefined && b.content !== null) fail('密文消息不能提交明文正文');
      const e = b.envelope as Envelope;
      if (
        !e ||
        e.version !== 1 ||
        e.clientId !== b.clientId ||
        !b64(e.ephemeral, 32) ||
        !b64(e.salt, 32) ||
        !b64(e.nonce, 12) ||
        typeof e.body !== 'string' ||
        !b64(e.body, Buffer.from(e.body, 'base64').length) ||
        Buffer.from(e.body, 'base64').length < 17 ||
        Buffer.from(e.body, 'base64').length > 40016 ||
        !Array.isArray(e.recipients) ||
        !e.recipients.length ||
        e.recipients.length > 256
      )
        fail('密文格式无效');
      const seen = new Set<string>();
      for (const recipient of e.recipients) {
        if (
          !recipient ||
          typeof recipient.id !== 'string' ||
          seen.has(recipient.id) ||
          !service.store.device(recipient.id) ||
          chat.key(recipient.id) !== recipient.publicKey ||
          !b64(recipient.publicKey, 32) ||
          !b64(recipient.nonce, 12) ||
          !b64(recipient.key, 48)
        )
          fail('密文接收设备或公钥已变化，请刷新列表');
        seen.add(recipient.id);
      }
      if (!seen.has(d.id)) fail('密文必须包含发送者设备');
      envelope = e;
    }
    const inserted = chat.db
      .prepare(
        'INSERT INTO chat_messages(clientId,senderId,senderName,createdAt,mode,content,envelope,remark,remarkStyle) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .run(
        b.clientId,
        d.id,
        d.name,
        Date.now(),
        b.mode,
        content,
        envelope ? JSON.stringify(envelope) : null,
        remark,
        remarkStyle,
      );
    service.broadcast();
    return chat.read(
      chat.db.prepare('SELECT * FROM chat_messages WHERE id=?').get(inserted.lastInsertRowid),
    );
  });
}
