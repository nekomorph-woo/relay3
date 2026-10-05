import { sha256 } from '@noble/hashes/sha2.js';
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
export async function fileHash(file: File) {
  const hash = sha256.create(),
    reader = file.stream().getReader();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    hash.update(chunk.value);
  }
  return Array.from(hash.digest(), (b) => b.toString(16).padStart(2, '0')).join('');
}
export async function uploadPackageFile(session: Session, file: File, original: SharedFile) {
  if (file.size !== original.size || (await fileHash(file)) !== original.expectedSha256)
    throw new Error('文件与原任务不一致，请选择原文件');
  await window.relay3?.rememberSource({ stationId: session.stationId, fileId: original.id, file });
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `${session.base}/api/files/${original.id}/upload`);
    xhr.setRequestHeader('Authorization', `Bearer ${session.token}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
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
  if (!files.length || files.length > 100) throw new Error('每个文件包可选择1至100个文件');
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
  if (!body) {
    const id = uuid(),
      remark = options.remark ?? '',
      remarkStyle = options.remarkStyle ?? 'note';
    const context = { stationId: session.stationId, senderId: session.id, remark, remarkStyle };
    const list = [];
    for (const file of files) {
      const fileId = uuid();
      list.push({
        id: fileId,
        size: file.size,
        expectedSha256: await fileHash(file),
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
  let result = await request<PackageView>(session.base, session.token, '/api/packages', body);
  if (result.state !== 'uploading') {
    await rememberPackages([result]);
    return result;
  }
  for (let i = 0; i < files.length; i++) {
    const original = result.files.find((f) => f.id === body.files[i].id);
    if (!original || !['waiting', 'failed'].includes(original.state)) continue;
    // 单个失败不丢弃已上传的缓存，也继续尝试其余成员；失败项在包详情恢复。
    await uploadPackageFile(session, files[i], original).catch(() => {});
  }
  result = await request<PackageView>(session.base, session.token, `/api/packages/${body.id}`);
  if (result.files.every((f) => f.state === 'staged'))
    result = await request<PackageView>(
      session.base,
      session.token,
      `/api/packages/${body.id}/publish`,
      {},
    );
  await rememberPackages([result]);
  return result;
}
