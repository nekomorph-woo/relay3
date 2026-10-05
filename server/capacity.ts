import { statfsSync } from 'node:fs';
export const diskMargin = 64 * 1024 * 1024;
export function capacitySnapshot(directory: string, committedBytes = 0, stat = statfsSync) {
  const disk = stat(directory),
    freeBytes = Number(disk.bavail) * Number(disk.bsize);
  return {
    freeBytes,
    committedBytes,
    marginBytes: diskMargin,
    availableBytes: Math.max(0, freeBytes - committedBytes - diskMargin),
  };
}
export function assertCapacity(bytes: number, availableBytes: number, label = '中转站') {
  if (!Number.isSafeInteger(bytes) || bytes < 0)
    throw Object.assign(new Error('文件总大小无效'), { statusCode: 400 });
  if (bytes > availableBytes)
    throw Object.assign(
      new Error(`${label}磁盘空间不足（已计入其他任务预留和安全余量），请清理空间后重试`),
      { statusCode: 507 },
    );
}
