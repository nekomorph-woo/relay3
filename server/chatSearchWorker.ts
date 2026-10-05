import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import type { SearchQuery } from './chatSearch';
const db = new DatabaseSync(workerData.path, { readOnly: true });
try {
  const q = workerData.query as SearchQuery,
    terms: string[] = [],
    args: (string | number)[] = [];
  if ([...q.q].length >= 3) {
    terms.push('id IN (SELECT rowid FROM chat_search WHERE chat_search MATCH ?)');
    args.push('"' + q.q.replaceAll('"', '""') + '"');
  } else {
    terms.push(
      "id IN (SELECT id FROM chat_messages ORDER BY id DESC LIMIT 10000) AND ((mode='plain' AND kind='text' AND content LIKE ? ESCAPE '\\') OR remark LIKE ? ESCAPE '\\')",
    );
    const pattern = '%' + q.q.replace(/[\\%_]/g, '\\$&') + '%';
    args.push(pattern, pattern);
  }
  for (const [key, col, op] of [
    ['beforeId', 'id', '<'],
    ['from', 'createdAt', '>='],
    ['to', 'createdAt', '<='],
  ] as const)
    if (q[key] !== undefined) {
      terms.push(`${col}${op}?`);
      args.push(q[key]!);
    }
  for (const key of ['senderId', 'mode', 'kind'] as const)
    if (q[key]) {
      terms.push(`${key}=?`);
      args.push(q[key]!);
    }
  const rows = db
    .prepare(`SELECT * FROM chat_messages WHERE ${terms.join(' AND ')} ORDER BY id DESC LIMIT 31`)
    .all(...args) as any[];
  const more = rows.length > 30;
  const items = rows.slice(0, 30);
  parentPort?.postMessage({
    items,
    more,
    nextBeforeId: more ? items.at(-1)?.id : undefined,
    limited: [...q.q].length < 3,
  });
} catch (e: any) {
  parentPort?.postMessage({ error: e.message });
} finally {
  db.close();
}
