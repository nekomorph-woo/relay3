import { deliverFile } from '../fileDelivery';
import { useEffect, useState } from 'react';
import {
  FileDown,
  FileCheck,
  FileQuestion,
  FileWarning,
  FileUp,
  FolderOpen,
  CircleHelp,
} from 'lucide-react';
import { request, date, labels, sizes, type Session, type Transfer } from '../api';
import { Tooltip } from './Tooltip';
import { decryptMessage } from '../chat/crypto';
import { stored } from '../api';
import type { SharedFile } from '../../server/files';
import type { ChatIdentity } from '../chat/types';
export interface LocalFile {
  id: string;
  transferId?: string;
  stationId?: string;
  name: string;
  path: string;
  exists: boolean;
  receivedAt: number;
}
const sharedRequests = new Map<string, Promise<SharedFile>>();
type FileNameSource = Pick<
  Transfer,
  'name' | 'fileId' | 'chatMessageId' | 'stationId' | 'packageId'
>;
export async function resolveFileName(f: SharedFile, session: Session) {
  if (!f.envelope) return f.name;
  const identity = window.relay3
    ? await window.relay3.chatIdentity()
    : stored<ChatIdentity | null>(`relay3-chat-key:${session.id}`, null);
  return identity
    ? decryptMessage(f.envelope, identity, session.id, {
        stationId: session.stationId,
        senderId: f.senderId,
        remark: f.remark,
        remarkStyle: f.remarkStyle,
        purpose: 'file-name',
        fileId: f.id,
        packageId: f.packageId,
      })
    : null;
}
export function useTransferName(t: FileNameSource, session?: Session) {
  const [name, setName] = useState(t.name);
  useEffect(() => {
    let dead = false;
    setName(t.name);
    if (!t.chatMessageId || !t.fileId || !session) return;
    const key = `${session.stationId}:${session.id}:${t.fileId}`;
    if (!sharedRequests.has(key))
      sharedRequests.set(
        key,
        request<SharedFile>(session.base, session.token, `/api/files/${t.fileId}`).catch((e) => {
          sharedRequests.delete(key);
          throw e;
        }),
      );
    void sharedRequests
      .get(key)!
      .then(async (f) => {
        const identity = window.relay3
          ? await window.relay3.chatIdentity()
          : stored<ChatIdentity | null>(`relay3-chat-key:${session.id}`, null);
        const value =
          identity && f.envelope
            ? decryptMessage(f.envelope, identity, session.id, {
                stationId: session.stationId,
                senderId: f.senderId,
                remark: f.remark,
                remarkStyle: f.remarkStyle,
                purpose: 'file-name',
                fileId: f.id,
                packageId: f.packageId,
              })
            : null;
        if (!dead) setName(value ?? '未知文件');
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [
    t.fileId,
    t.packageId,
    t.chatMessageId,
    t.name,
    t.stationId,
    session?.stationId,
    session?.id,
    session?.token,
  ]);
  return name;
}
export function FileTask({
  t,
  session,
  localFiles = [],
  name,
  onUpdated,
  onError,
  compact = false,
}: {
  t: Transfer;
  session?: Session;
  localFiles?: LocalFile[];
  name?: string;
  onUpdated: () => void;
  onError: (s: string) => void;
  compact?: boolean;
}) {
  const resolvedName = useTransferName(t, session),
    [busy, setBusy] = useState(false);
  const [sourceExists, setSourceExists] = useState(false);
  useEffect(() => {
    if (window.relay3 && t.fileId && session?.id === t.senderId)
      void window.relay3
        .canRevealFile({ kind: 'source', id: t.fileId, stationId: t.stationId })
        .then(setSourceExists)
        .catch(() => setSourceExists(false));
  }, [t.fileId, t.stationId, session?.id, localFiles]);
  const local = localFiles.find((f) => f.stationId === t.stationId && f.transferId === t.id);
  const incoming = session?.id === t.recipientId;
  const canRepeat =
    incoming &&
    !!t.lastDownloadedAt &&
    !t.cleanedAt &&
    Date.now() < (t.expiresAt ?? 0) &&
    t.status === 'completed' &&
    (!window.relay3 || !local?.exists);
  const status =
    t.fileId && t.status === 'completed' && !canRepeat
      ? '已接收'
      : session?.id === t.senderId && t.fileId && t.status === 'pending'
        ? '已上传 · 等待对方处理'
        : t.cleanedAt && t.status !== 'completed'
          ? '中转缓存已清理'
          : canRepeat
            ? '可重新下载'
            : (labels[t.status] ?? t.status);
  const Icon =
    t.cleanedAt && t.status !== 'completed'
      ? FileWarning
      : t.status === 'completed' && !canRepeat
        ? FileCheck
        : ['uploading', 'accepted'].includes(t.status)
          ? FileUp
          : ['expired', 'receive-expired', 'failed'].includes(t.status)
            ? FileWarning
            : FileDown;
  async function operate(action: string) {
    if (!session) return;
    setBusy(true);
    try {
      if (action === 'accept') {
        const ready = await request<Transfer>(
          session.base,
          session.token,
          `/api/transfers/${t.id}/accept`,
          {},
        );
        if (t.fileId) await download(ready);
      } else if (action === 'download') await download(t);
      else await request(session.base, session.token, `/api/transfers/${t.id}/${action}`, {});
      onUpdated();
    } catch (e: any) {
      onError(e.message);
    } finally {
      setBusy(false);
      onUpdated();
    }
  }
  async function download(task: Transfer) {
    if (!session) return;
    if (window.relay3)
      await window.relay3.download({
        base: session.base,
        token: session.token,
        id: t.id,
        packageId: t.packageId,
        name: name ?? resolvedName,
        size: t.size,
        sha256: task.sha256!,
        stationId: session.stationId,
        stationName: session.stationName,
      });
    else {
      const a = document.createElement('a');
      a.href = `${session.base}/api/transfers/${t.id}/download?token=${encodeURIComponent(session.token)}`;
      a.download = name ?? resolvedName;
      a.click();
    }
  }
  return (
    <div className={`file-task ${compact ? 'compact' : ''}`}>
      <span className="file-task-status">
        <Icon size={16} />
        {status}
        <Tooltip
          text={
            t.cleanedAt
              ? '中转站暂存文件已清理，不影响已下载的本机文件。'
              : canRepeat
                ? '本机保存路径已不存在，可以在缓存清理时间前重新下载。'
                : t.status === 'expired'
                  ? '接收缓冲时间已结束，不能再接收或拒绝。'
                  : '首次接收须在接收截止时间前完成；已接收设备可在缓存清理时间前重新下载。'
          }
        >
          <CircleHelp size={13} />
        </Tooltip>
      </span>
      {['uploading', 'downloading'].includes(t.status) && (
        <small>
          {sizes(t.status === 'uploading' ? t.uploaded : t.downloaded)} / {sizes(t.size)}
        </small>
      )}
      {t.lastDownloadedAt && <small>已下载过 · 最近下载于 {date(t.lastDownloadedAt)}</small>}
      {t.receiveDeadline && !compact && (
        <small>
          接收截止：{date(t.receiveDeadline)} · 缓存清理：{date(t.expiresAt)}
        </small>
      )}
      <div className="file-task-actions">
        {session?.id === t.senderId &&
          t.fileId &&
          !t.packageId &&
          ['failed', 'accepted'].includes(t.status) && (
            <label className="retry-file">
              重新选择原文件上传
              <input
                type="file"
                aria-label="重新选择原文件上传"
                disabled={busy}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (!file || !session) return;
                  setBusy(true);
                  void request<SharedFile & { transfers: Transfer[] }>(
                    session.base,
                    session.token,
                    `/api/files/${t.fileId}`,
                  )
                    .then((f) =>
                      deliverFile(
                        session,
                        file,
                        f.transfers.map((t) => t.recipientId),
                        f.bufferMinutes,
                        {
                          id: f.id,
                          envelope: f.envelope,
                          remark: f.remark,
                          remarkStyle: f.remarkStyle,
                        },
                      ),
                    )
                    .then(onUpdated)
                    .catch((e) => onError(e.message))
                    .finally(() => setBusy(false));
                }}
              />
            </label>
          )}

        {session &&
          !(t.packageId && session.id === t.senderId) &&
          incoming &&
          !t.cleanedAt &&
          t.status === 'pending' &&
          Date.now() < (t.receiveDeadline ?? Infinity) && (
            <>
              <button className="primary" disabled={busy} onClick={() => void operate('accept')}>
                接收
              </button>
              <button disabled={busy} onClick={() => void operate('reject')}>
                拒绝
              </button>
            </>
          )}
        {session &&
          incoming &&
          !t.cleanedAt &&
          ((['ready', 'awaiting-confirm'].includes(t.status) &&
            Date.now() < (t.receiveDeadline ?? Infinity)) ||
            canRepeat) && (
            <button disabled={busy} onClick={() => void operate('download')}>
              {canRepeat ? '重新下载' : '下载文件'}
            </button>
          )}
        {session && incoming && t.status === 'awaiting-confirm' && (
          <button disabled={busy} onClick={() => void operate('complete')}>
            确认收到
          </button>
        )}
        {window.relay3 && local?.exists && (
          <button
            aria-label="打开接收文件所在目录"
            onClick={() =>
              void window.relay3!.revealFile({ kind: 'received', id: local.id }).catch((e) => {
                onError(e.message);
                onUpdated();
              })
            }
          >
            <FolderOpen size={16} />
          </button>
        )}
        {window.relay3 && sourceExists && session?.id === t.senderId && t.fileId && (
          <button
            aria-label="打开发送文件所在目录"
            onClick={() =>
              void window
                .relay3!.revealFile({ kind: 'source', id: t.fileId!, stationId: t.stationId })
                .catch((e) => onError(e.message))
            }
          >
            <FolderOpen size={16} />
          </button>
        )}
        {session &&
          !(t.packageId && session.id === t.senderId) &&
          ['accepted', 'uploading', 'pending', 'ready', 'downloading'].includes(t.status) && (
            <button disabled={busy} onClick={() => void operate('cancel')}>
              取消
            </button>
          )}
      </div>
    </div>
  );
}
export function UnknownFile({ cleaned = false }: { cleaned?: boolean }) {
  return (
    <span className="file-task-status">
      {cleaned ? <FileWarning size={17} /> : <FileQuestion size={17} />}未知文件
      {cleaned ? ' · 中转缓存已清理' : ''}
    </span>
  );
}

export function TransferName({ t, session }: { t: FileNameSource; session?: Session }) {
  const name = useTransferName(t, session);
  return <>{name}</>;
}
