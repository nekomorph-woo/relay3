import { sha256 } from '@noble/hashes/sha2.js';
import { request, uuid, type Session, type Transfer } from './api';
import type { SharedFile } from '../server/files';
import type { Envelope } from './chat/types';
const draftIds = new WeakMap<File, Map<string, string>>();
export async function deliverFile(
  session: Session,
  file: File,
  recipients: string[],
  bufferMinutes: number,
  options: { id?: string; envelope?: Envelope; remark?: string; remarkStyle?: string } = {},
  progress?: (bytes: number) => void,
) {
  const signature = JSON.stringify([session.stationId, [...recipients].sort(), bufferMinutes]);
  const ids = draftIds.get(file) ?? new Map<string, string>();
  draftIds.set(file, ids);
  const id = options.id ?? ids.get(signature) ?? uuid();
  ids.set(signature, id);
  const hash = sha256.create();
  const reader = file.stream().getReader();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    hash.update(chunk.value);
  }
  const expectedSha256 = Array.from(hash.digest(), (b) => b.toString(16).padStart(2, '0')).join('');
  const result = await request<SharedFile & { transfers: Transfer[] }>(
    session.base,
    session.token,
    '/api/files',
    {
      id,
      expectedSha256,
      size: file.size,
      recipientIds: recipients,
      bufferMinutes,
      remark: options.remark ?? '',
      remarkStyle: options.remarkStyle ?? 'note',
      ...(options.envelope ? { chat: true, envelope: options.envelope } : { name: file.name }),
    },
  );
  await window.relay3?.rememberSource({ stationId: session.stationId, fileId: id, file });
  if (
    result.size !== file.size ||
    (result.expectedSha256 && result.expectedSha256 !== expectedSha256)
  )
    throw new Error('文件与原任务不一致，请重新选择原文件');
  if (result.state === 'ready') return result;
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `${session.base}/api/files/${id}/upload`);
    xhr.setRequestHeader('Authorization', `Bearer ${session.token}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => progress?.(e.loaded);
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
  return result;
}
