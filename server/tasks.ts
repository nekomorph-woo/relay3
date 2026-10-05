import { randomUUID } from 'node:crypto';
export interface BackgroundTask {
  id: string;
  kind: 'upload' | 'download' | 'scan' | 'cleanup';
  name: string;
  deviceName?: string;
  fileId?: string;
  releasedBytes?: number;
  bytes: number;
  total: number;
  startedAt: number;
  finishedAt?: number;
  state: 'running' | 'completed' | 'failed';
  error?: string;
}
export class TaskRegistry {
  private tasks = new Map<string, BackgroundTask>();
  start(
    kind: BackgroundTask['kind'],
    name: string,
    total = 0,
    deviceName?: string,
    fileId?: string,
  ) {
    const id = randomUUID();
    this.tasks.set(id, {
      id,
      kind,
      name,
      deviceName,
      fileId,
      total,
      bytes: 0,
      startedAt: Date.now(),
      state: 'running',
    });
    this.trim();
    return id;
  }
  progress(id: string, bytes: number) {
    const task = this.tasks.get(id);
    if (task) task.bytes = bytes;
  }
  released(id: string, bytes: number) {
    const t = this.tasks.get(id);
    if (t) t.releasedBytes = (t.releasedBytes ?? 0) + bytes;
  }
  finish(id: string, error?: string) {
    const task = this.tasks.get(id);
    if (task)
      Object.assign(task, { state: error ? 'failed' : 'completed', error, finishedAt: Date.now() });
    this.trim();
  }
  private trim() {
    const done = [...this.tasks.values()]
      .filter((t) => t.state !== 'running')
      .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
    for (const t of done.slice(20)) this.tasks.delete(t.id);
  }
  list() {
    return [...this.tasks.values()].sort(
      (a, b) =>
        Number(b.state === 'running') - Number(a.state === 'running') || b.startedAt - a.startedAt,
    );
  }
}
