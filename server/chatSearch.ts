import { Worker } from 'node:worker_threads';
import type { DatabaseSync } from 'node:sqlite';
import type { TaskRegistry } from './tasks';
export interface SearchQuery {
  q: string;
  beforeId?: number;
  senderId?: string;
  mode?: string;
  kind?: string;
  from?: number;
  to?: number;
}
export function validateSearch(raw: any): SearchQuery {
  const q = String(raw?.q ?? '').trim();
  if (!q || [...q].length > 100)
    throw Object.assign(new Error('请输入1至100个字符'), { statusCode: 400 });
  const result: SearchQuery = { q };
  for (const key of ['beforeId', 'from', 'to'] as const)
    if (raw[key] !== undefined && raw[key] !== '') {
      const n = Number(raw[key]);
      if (!Number.isSafeInteger(n) || n < 0)
        throw Object.assign(new Error('搜索时间或分页无效'), { statusCode: 400 });
      result[key] = n;
    }
  for (const [key, allowed] of [
    ['mode', ['plain', 'encrypted']],
    ['kind', ['text', 'file', 'package']],
  ] as const)
    if (raw[key] && raw[key] !== 'all') {
      if (!(allowed as readonly string[]).includes(raw[key]))
        throw Object.assign(new Error('搜索筛选无效'), { statusCode: 400 });
      result[key] = raw[key];
    }
  if (raw.senderId) {
    if (typeof raw.senderId !== 'string' || raw.senderId.length > 80)
      throw Object.assign(new Error('发送者筛选无效'), { statusCode: 400 });
    result.senderId = raw.senderId;
  }
  return result;
}
export class ChatSearch {
  private workers = new Set<Worker>();
  private timer?: NodeJS.Immediate;
  private closed = false;
  ready = false;
  constructor(
    readonly path: string,
    readonly db: DatabaseSync,
    tasks: TaskRegistry,
  ) {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS chat_search USING fts5(content,remark,tokenize='trigram');
  CREATE TRIGGER IF NOT EXISTS chat_search_insert AFTER INSERT ON chat_messages BEGIN INSERT INTO chat_search(rowid,content,remark) VALUES(new.id,CASE WHEN new.mode='plain' AND new.kind='text' THEN new.content ELSE '' END,new.remark); END;
  CREATE TRIGGER IF NOT EXISTS chat_search_delete AFTER DELETE ON chat_messages BEGIN DELETE FROM chat_search WHERE rowid=old.id; END;`);
    db.exec(
      'CREATE TABLE IF NOT EXISTS chat_search_state (id INTEGER PRIMARY KEY,cursor INTEGER NOT NULL); INSERT OR IGNORE INTO chat_search_state VALUES(1,0)',
    );
    let cursor = Number(
        (db.prepare('SELECT cursor FROM chat_search_state WHERE id=1').get() as any).cursor,
      ),
      processed = 0;
    const total = Number(
      (db.prepare('SELECT COUNT(*) n FROM chat_messages WHERE id>?').get(cursor) as any).n,
    );
    const task = tasks.start('scan', '建立历史搜索索引', total);
    const backfill = () => {
      if (this.closed) {
        tasks.finish(task, '索引构建已停止');
        return;
      }
      try {
        const rows = db
          .prepare(
            'SELECT id,content,remark,mode,kind FROM chat_messages WHERE id>? ORDER BY id LIMIT 500',
          )
          .all(cursor) as any[];
        db.exec('BEGIN');
        try {
          for (const m of rows) {
            if (!db.prepare('SELECT rowid FROM chat_search WHERE rowid=?').get(m.id))
              db.prepare('INSERT INTO chat_search(rowid,content,remark) VALUES(?,?,?)').run(
                m.id,
                m.mode === 'plain' && m.kind === 'text' ? (m.content ?? '') : '',
                m.remark,
              );
            cursor = m.id;
          }
          db.prepare('UPDATE chat_search_state SET cursor=? WHERE id=1').run(cursor);
          db.exec('COMMIT');
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
        processed += rows.length;
        tasks.progress(task, processed);
        if (rows.length === 500) this.timer = setImmediate(backfill);
        else {
          this.ready = true;
          tasks.finish(task);
        }
      } catch (e: any) {
        tasks.finish(task, '搜索索引暂时不可用');
      }
    };
    this.timer = setImmediate(backfill);
  }
  async search(query: SearchQuery) {
    if (this.closed) throw new Error('中转站正在关闭');
    if (this.workers.size >= 2)
      throw Object.assign(new Error('搜索繁忙，请稍后重试'), { statusCode: 429 });
    const worker = new Worker(new URL('./chatSearchWorker.js', import.meta.url), {
      workerData: { path: this.path, query },
    });
    this.workers.add(worker);
    try {
      return await new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('搜索超时，请缩小时间范围'));
          void worker.terminate();
        }, 5000);
        worker.once('message', (data) => {
          clearTimeout(timeout);
          if (data.error) reject(new Error(data.error));
          else resolve({ ...data, indexReady: this.ready });
        });
        worker.once('error', (e) => {
          clearTimeout(timeout);
          reject(e);
        });
        worker.once('exit', (code) => {
          clearTimeout(timeout);
          if (code) reject(new Error('搜索已停止'));
        });
      });
    } finally {
      this.workers.delete(worker);
      await worker.terminate();
    }
  }
  async close() {
    this.closed = true;
    if (this.timer) clearImmediate(this.timer);
    await Promise.all([...this.workers].map((w) => w.terminate()));
    this.workers.clear();
  }
}
