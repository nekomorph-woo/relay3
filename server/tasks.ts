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
    const cutoff = Date.now() - 5 * 60_000;
    for (const [id, task] of this.tasks)
      if (task.state !== 'running' && task.finishedAt !== undefined && task.finishedAt <= cutoff)
        this.tasks.delete(id);
  }
  list() {
    this.trim();
    return [...this.tasks.values()].sort(
      (a, b) =>
        Number(b.state === 'running') - Number(a.state === 'running') || b.startedAt - a.startedAt,
    );
  }
}
