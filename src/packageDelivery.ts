import { startPreparation, preparationProgress, finishPreparation } from './preparation';
import { request, uuid, type Session } from './api';
import { encryptMessage } from './chat/crypto';
import type { ChatRecipient } from './chat/types';
import type { PackageView } from '../server/packages';
import type { SharedFile } from '../server/files';
const drafts = new WeakMap<File[], Map<string, any>>();
export async function rememberPackages(packages: PackageView[]) {
  if (!window.relay3 || !packages.length) return;
  const boot = await window.relay3.bootstrap();
  await request(boot.controlUrl, boot.adminToken, '/admin/remember', { records: [], packages });
}
export async function fileHash(
  file: File,
  signal?: AbortSignal,
  progress?: (bytes: number) => void,
): Promise<string> {
  signal?.throwIfAborted();
  const nativeId = (file as File & { nativeId?: string }).nativeId;
  if (nativeId) return window.relay3!.nativeHash(nativeId);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./hash.worker.ts', import.meta.url), { type: 'module' });
    const finish = () => {
      worker.terminate();
      signal?.removeEventListener('abort', cancel);
    };
    const cancel = () => {
      finish();
      reject(new Error('发送准备已取消'));
    };
    signal?.addEventListener('abort', cancel, { once: true });
    worker.onerror = () => {
      finish();
      reject(new Error('文件读取失败'));
    };
    worker.onmessage = ({ data }) => {
      progress?.(data.bytes ?? 0);
      if (data.error) {
        finish();
        reject(new Error(data.error));
      } else if (data.hash) {
        finish();
        resolve(data.hash);
      }
    };
    worker.postMessage(file);
  });
}
export async function uploadPackageFile(
  session: Session,
  file: File,
  original: SharedFile,
  options: { hash?: string; signal?: AbortSignal; progress?: (bytes: number) => void } = {},
) {
  if (
    file.size !== original.size ||
    (options.hash ?? (await fileHash(file, options.signal))) !== original.expectedSha256
  )
    throw new Error('文件与原任务不一致，请选择原文件');
  options.signal?.throwIfAborted();
  const nativeId = (file as File & { nativeId?: string }).nativeId;
  if (nativeId) {
    const cancel = () => void window.relay3!.cancelNative(nativeId);
    const stop = window.relay3!.onNativeProgress((e) => {
      if (e.id === nativeId) options.progress?.(e.bytes);
    });
    options.signal?.addEventListener('abort', cancel, { once: true });
    try {
      return await window.relay3!.uploadNative({
        nativeId,
        base: session.base,
        token: session.token,
        fileId: original.id,
        size: original.size,
        hash: original.expectedSha256!,
        stationId: session.stationId,
      });
    } finally {
      stop();
      options.signal?.removeEventListener('abort', cancel);
    }
  }
  await window.relay3?.rememberSource({ stationId: session.stationId, fileId: original.id, file });
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `${session.base}/api/files/${original.id}/upload`);
    xhr.setRequestHeader('Authorization', `Bearer ${session.token}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    const cancel = () => xhr.abort();
    options.signal?.addEventListener('abort', cancel, { once: true });
    xhr.onloadend = () => options.signal?.removeEventListener('abort', cancel);
    xhr.upload.onprogress = (e) => options.progress?.(e.loaded);
    xhr.onload = () => {
      if (xhr.status < 400) resolve();
      else {
        try {
          reject(new Error(JSON.parse(xhr.responseText).error));
        } catch {
          reject(new Error('上传失败，请重试'));
        }
      }
    };
    xhr.onerror = () => reject(new Error('上传连接中断，请重试'));
    xhr.onabort = () => reject(new Error('上传已中断'));
    xhr.send(file);
  });
}
export async function deliverPackage(
  session: Session,
  files: File[],
  recipientIds: string[],
  bufferMinutes: number,
  options: { keys?: ChatRecipient[]; remark?: string; remarkStyle?: string } = {},
) {
  if (!files.length || files.length > 100) throw new Error('每次发送可选择1至100个文件');
  const task = startPreparation(
    session.stationId,
    files.length === 1 ? files[0].name : `${files.length} 个文件`,
    files.reduce((n, f) => n + f.size, 0),
  );
  const signal = task.controller.signal;
  try {
    const signature = JSON.stringify([
      session.stationId,
      [...recipientIds].sort(),
      bufferMinutes,
      options.remark,
      options.remarkStyle,
      options.keys,
    ]);
    const cached = drafts.get(files) ?? new Map<string, any>();
    drafts.set(files, cached);
    let body = cached.get(signature);
    const freshHashes = new Map<File, string>();
    preparationProgress(task, '检查中转站容量');
    const info = await request<any>(session.base, session.token, '/api/info');
    signal.throwIfAborted();
    if (!body && info.capacityPreflight)
      await request(session.base, session.token, '/api/capacity', { bytes: task.total });
    signal.throwIfAborted();
    if (!body) {
      const id = uuid(),
        remark = options.remark ?? '',
        remarkStyle = options.remarkStyle ?? 'note';
      const context = { stationId: session.stationId, senderId: session.id, remark, remarkStyle };
      const list = [];
      let hashed = 0;
      for (const file of files) {
        const checksum = await fileHash(file, signal, (bytes) =>
          preparationProgress(task, `校验 ${file.name}`, hashed + bytes),
        );
        freshHashes.set(file, checksum);
        hashed += file.size;
        const fileId = uuid();
        list.push({
          id: fileId,
          size: file.size,
          expectedSha256: checksum,
          ...(options.keys
            ? {
                envelope: encryptMessage(
                  file.name,
                  options.keys,
                  { ...context, purpose: 'file-name', fileId, packageId: id },
                  fileId,
                ),
              }
            : { name: file.name }),
        });
      }
      body = {
        id,
        files: list,
        recipientIds,
        bufferMinutes,
        remark,
        remarkStyle,
        ...(options.keys
          ? {
              chat: true,
              envelope: encryptMessage(
                '文件包',
                options.keys,
                { ...context, purpose: 'file-package', fileId: id },
                id,
              ),
            }
          : {}),
      };
      cached.set(signature, body);
    }
    signal.throwIfAborted();
    preparationProgress(task, '创建发送任务');
    let result = await request<PackageView>(session.base, session.token, '/api/packages', body);
    if (result.state !== 'uploading') {
      await rememberPackages([result]);
      finishPreparation(task);
      return result;
    }
    let uploaded = 0;
    for (let i = 0; i < files.length; i++) {
      const original = result.files.find((f) => f.id === body.files[i].id);
      if (!original || !['waiting', 'failed'].includes(original.state)) continue;
      // 单个失败不丢弃已上传的缓存，也继续尝试其余成员；失败项在包详情恢复。
      signal.throwIfAborted();
      await uploadPackageFile(session, files[i], original, {
        hash: freshHashes.get(files[i]),
        signal,
        progress: (bytes) => preparationProgress(task, `上传 ${files[i].name}`, uploaded + bytes),
      }).catch((e) => {
        if (signal.aborted) throw e;
      });
      uploaded += files[i].size;
    }
    signal.throwIfAborted();
    preparationProgress(task, '确认投递', task.total);
    result = await request<PackageView>(session.base, session.token, `/api/packages/${body.id}`);
    if (result.files.every((f) => f.state === 'staged'))
      result = await request<PackageView>(
        session.base,
        session.token,
        `/api/packages/${body.id}/publish`,
        {},
      );
    await rememberPackages([result]);
    if (result.state === 'ready')
      for (const f of files) {
        const id = (f as File & { nativeId?: string }).nativeId;
        if (id) await window.relay3!.releaseNative(id);
      }
    finishPreparation(
      task,
      result.state === 'uploading' ? '部分文件上传失败，请在详情中重试' : undefined,
    );
    return result;
  } catch (e: any) {
    finishPreparation(task, signal.aborted ? '发送准备已取消' : e.message);
    throw e;
  }
}
