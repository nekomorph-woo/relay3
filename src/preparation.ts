export interface PreparationTask {
  id: string;
  stationId: string;
  name: string;
  stage: string;
  bytes: number;
  total: number;
  state: 'running' | 'completed' | 'failed';
  finishedAt?: number;
  error?: string;
  speed?: number;
  sampleAt?: number;
  sampleBytes?: number;
  controller: AbortController;
}
const tasks = new Map<string, PreparationTask>();
export function preparationTasks() {
  const now = Date.now();
  for (const [id, t] of tasks) if (t.finishedAt && now - t.finishedAt >= 300000) tasks.delete(id);
  return [...tasks.values()];
}
function announce() {
  window.dispatchEvent(new Event('relay3-preparation'));
}
export function startPreparation(stationId: string, name: string, total: number) {
  const t: PreparationTask = {
    id: crypto.randomUUID(),
    stationId,
    name,
    stage: '准备发送',
    bytes: 0,
    total,
    state: 'running',
    controller: new AbortController(),
  };
  tasks.set(t.id, t);
  void window.relay3?.clientActivity(t.id, true);
  announce();
  return t;
}
export function preparationProgress(t: PreparationTask, stage: string, bytes = 0, total = t.total) {
  const now = Date.now();
  if (stage !== t.stage) {
    t.speed = undefined;
    t.sampleAt = now;
    t.sampleBytes = bytes;
  } else if (stage.startsWith('上传 ') && t.sampleAt && now - t.sampleAt >= 300) {
    const speed = ((bytes - (t.sampleBytes ?? 0)) * 1000) / (now - t.sampleAt);
    t.speed = t.speed ? t.speed * 0.7 + speed * 0.3 : speed;
    t.sampleAt = now;
    t.sampleBytes = bytes;
  }
  Object.assign(t, { stage, bytes, total });
  announce();
}
export function finishPreparation(t: PreparationTask, error?: string) {
  void window.relay3?.clientActivity(t.id, false);
  Object.assign(t, {
    state: error ? 'failed' : 'completed',
    finishedAt: Date.now(),
    error,
    stage: error || '已完成上传与投递',
  });
  announce();
}
export function cancelPreparation(id: string) {
  tasks.get(id)?.controller.abort();
}
