import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface SavedConnection {
  base: string;
  token: string;
  id: string;
  stationId: string;
  stationName: string;
}
export type Status =
  | 'pending'
  | 'accepted'
  | 'uploading'
  | 'ready'
  | 'downloading'
  | 'awaiting-confirm'
  | 'completed'
  | 'rejected'
  | 'cancelled'
  | 'failed';
export interface Device {
  id: string;
  name: string;
  platform: string;
  firstSeen: number;
  lastSeen: number;
  disconnectedAt: number | null;
  ip: string;
}
export interface Transfer {
  id: string;
  stationId: string;
  name: string;
  size: number;
  senderId: string;
  senderName: string;
  recipientId: string;
  recipientName: string;
  status: Status;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  duration: number | null;
  uploaded: number;
  downloaded: number;
  uploadDuration?: number;
  downloadDuration?: number;
  sha256: string | null;
  expiresAt: number | null;
  cleanedAt: number | null;
  error: string | null;
}
export interface Settings {
  stationId: string;
  deviceId: string;
  deviceName: string;
  stationName: string;
  cacheDir: string;
  receiveDir: string;
  port: number;
  retentionHours: number;
}
export const activeStatuses: Status[] = [
  'pending',
  'accepted',
  'uploading',
  'ready',
  'downloading',
  'awaiting-confirm',
];

export class Store {
  db: DatabaseSync;
  settings: Settings;
  readonly dbPath: string;
  constructor(
    readonly dataDir: string,
    receiveDir?: string,
  ) {
    mkdirSync(dataDir, { recursive: true });
    this.dbPath = path.join(dataDir, 'relay3.sqlite');
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS client_sessions (base TEXT PRIMARY KEY, deviceId TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, secret TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS transfers (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS received_files (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS remote_records (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS connections (id INTEGER PRIMARY KEY, deviceId TEXT NOT NULL, name TEXT NOT NULL, ip TEXT NOT NULL, connectedAt INTEGER NOT NULL, disconnectedAt INTEGER);
      CREATE INDEX IF NOT EXISTS connections_device ON connections(deviceId);
      CREATE INDEX IF NOT EXISTS transfer_time ON transfers(json_extract(data, '$.createdAt'));
      PRAGMA user_version=1;`);
    const saved = this.db.prepare('SELECT value FROM settings WHERE key=?').get('main') as
      { value: string } | undefined;
    this.settings = saved
      ? JSON.parse(saved.value)
      : {
          stationId: randomUUID(),
          deviceId: randomUUID(),
          deviceName: os.hostname().split('.')[0],
          stationName: os.hostname().split('.')[0],
          cacheDir: path.join(dataDir, 'relay-cache'),
          receiveDir: receiveDir ?? path.join(os.homedir(), 'Downloads', 'relay3'),
          port: 42830,
          retentionHours: 1,
        };
    // 老版本使用设备名称作为中转站名称，升级时沿用，之后独立保存。
    if (!this.settings.stationName?.trim()) this.settings.stationName = this.settings.deviceName;
    this.saveSettings(this.settings);
    this.db
      .prepare('UPDATE connections SET disconnectedAt=? WHERE disconnectedAt IS NULL')
      .run(Date.now());
    for (const d of this.devices())
      if (d.disconnectedAt === null) this.saveDevice({ ...d, disconnectedAt: Date.now() });
    for (const t of this.transfers()) {
      if (t.status === 'uploading')
        this.saveTransfer({ ...t, status: 'failed', error: '中转站重启，上传中断，请重新发送' });
      if (t.status === 'downloading')
        this.saveTransfer({ ...t, status: 'ready', downloaded: 0, error: '下载中断，可重新接收' });
    }
  }
  saveSettings(s: Settings) {
    this.settings = s;
    this.db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run('main', JSON.stringify(s));
  }
  clientSessions(): Record<string, SavedConnection> {
    const rows = this.db
      .prepare('SELECT base,data FROM client_sessions WHERE deviceId=?')
      .all(this.settings.deviceId) as { base: string; data: string }[];
    return Object.fromEntries(rows.map((row) => [row.base, JSON.parse(row.data)]));
  }
  saveClientSession(session: SavedConnection) {
    this.db
      .prepare('INSERT OR REPLACE INTO client_sessions VALUES (?,?,?)')
      .run(session.base, session.id, JSON.stringify(session));
  }
  clearClientSessions() {
    this.db.exec('DELETE FROM client_sessions');
  }
  devices(): Device[] {
    return (this.db.prepare('SELECT data FROM devices').all() as { data: string }[]).map((r) =>
      JSON.parse(r.data),
    );
  }
  device(id: string): Device | undefined {
    const r = this.db.prepare('SELECT data FROM devices WHERE id=?').get(id) as
      { data: string } | undefined;
    return r && JSON.parse(r.data);
  }
  saveDevice(d: Device, secret?: string) {
    if (secret)
      this.db
        .prepare('INSERT OR REPLACE INTO devices VALUES (?,?,?)')
        .run(d.id, secret, JSON.stringify(d));
    else this.db.prepare('UPDATE devices SET data=? WHERE id=?').run(JSON.stringify(d), d.id);
  }
  auth(secret: string): Device | undefined {
    const r = this.db.prepare('SELECT data FROM devices WHERE secret=?').get(secret) as
      { data: string } | undefined;
    return r && JSON.parse(r.data);
  }
  transfer(id: string): Transfer | undefined {
    const r = this.db.prepare('SELECT data FROM transfers WHERE id=?').get(id) as
      { data: string } | undefined;
    return r && JSON.parse(r.data);
  }
  transfers(): Transfer[] {
    return (
      this.db
        .prepare("SELECT data FROM transfers ORDER BY json_extract(data,'$.createdAt') DESC")
        .all() as { data: string }[]
    ).map((r) => JSON.parse(r.data));
  }
  saveTransfer(t: Transfer) {
    this.db.prepare('INSERT OR REPLACE INTO transfers VALUES (?,?)').run(t.id, JSON.stringify(t));
  }
  remember(records: Transfer[]) {
    const stmt = this.db.prepare('INSERT OR REPLACE INTO remote_records VALUES (?,?)');
    this.db.exec('BEGIN');
    try {
      for (const t of records)
        if (
          t.stationId !== this.settings.stationId &&
          (t.senderId === this.settings.deviceId || t.recipientId === this.settings.deviceId)
        )
          stmt.run(`${t.stationId}:${t.id}`, JSON.stringify(t));
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  received(): { id: string; name: string; path: string; size: number; receivedAt: number }[] {
    return (this.db.prepare('SELECT data FROM received_files').all() as { data: string }[])
      .map((r) => JSON.parse(r.data))
      .sort((a, b) => b.receivedAt - a.receivedAt);
  }
  saveReceived(file: { id: string; name: string; path: string; size: number; receivedAt: number }) {
    this.db
      .prepare('INSERT OR REPLACE INTO received_files VALUES (?,?)')
      .run(file.id, JSON.stringify(file));
  }
  records(): Transfer[] {
    return [
      ...this.transfers(),
      ...(this.db.prepare('SELECT data FROM remote_records').all() as { data: string }[]).map((r) =>
        JSON.parse(r.data),
      ),
    ].sort((a, b) => b.createdAt - a.createdAt);
  }
  connection(d: Device) {
    return Number(
      this.db
        .prepare('INSERT INTO connections(deviceId,name,ip,connectedAt) VALUES (?,?,?,?)')
        .run(d.id, d.name, d.ip, Date.now()).lastInsertRowid,
    );
  }
  disconnect(connection: number) {
    this.db
      .prepare('UPDATE connections SET disconnectedAt=? WHERE id=?')
      .run(Date.now(), connection);
  }
  connections() {
    return this.db.prepare('SELECT * FROM connections ORDER BY connectedAt DESC LIMIT 500').all();
  }
  clearRecords() {
    let deleted = 0;
    for (const t of this.transfers())
      if (!activeStatuses.includes(t.status) && (t.cleanedAt || t.uploaded === 0)) {
        this.db.prepare('DELETE FROM transfers WHERE id=?').run(t.id);
        deleted++;
      }
    for (const r of this.db.prepare('SELECT id,data FROM remote_records').all() as {
      id: string;
      data: string;
    }[])
      if (!activeStatuses.includes(JSON.parse(r.data).status)) {
        this.db.prepare('DELETE FROM remote_records WHERE id=?').run(r.id);
        deleted++;
      }
    return deleted;
  }
  sizes() {
    const size = (p: string) => {
      try {
        return statSync(p).size;
      } catch {
        return 0;
      }
    };
    return {
      database: size(this.dbPath),
      wal: size(this.dbPath + '-wal'),
      shm: size(this.dbPath + '-shm'),
    };
  }
  close() {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    this.db.close();
  }
}
