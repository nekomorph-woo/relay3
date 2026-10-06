import { hiddenFileName } from '../chat/phrases';
import { useEffect, useState } from 'react';
import {
  FileBox,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Bell,
  Send,
  X,
  FolderOpen,
  CircleHelp,
} from 'lucide-react';
import type { PackageView } from '../../server/packages';
import type { SharedFile } from '../../server/files';
import { date, request, sizes, duration, type Session, type Transfer } from '../api';
import { uploadPackageFile } from '../packageDelivery';
import { FileTask, resolveFileName, type LocalFile } from './FileTask';
import { DeviceAvatar } from './DeviceAvatar';
import { DeviceTag } from './DeviceTag';
import { Tooltip } from './Tooltip';
import { DeliveryTitle } from './DeliveryTitle';
import { ChatDialog } from '../chat/ChatDialog';

const available = (t: Transfer, local?: LocalFile) =>
  !t.cleanedAt &&
  ((['pending', 'ready', 'awaiting-confirm'].includes(t.status) &&
    Date.now() < (t.receiveDeadline ?? 0)) ||
    (t.status === 'completed' &&
      !!t.lastDownloadedAt &&
      !local?.exists &&
      Date.now() < (t.expiresAt ?? 0)));
export function FilePackageCard({
  p,
  session,
  localFiles = [],
  onUpdated,
  onError,
  readOnly = false,
  devices = [],
  defaultOpen = false,
}: {
  p: PackageView;
  session?: Session;
  localFiles?: LocalFile[];
  onUpdated: () => void;
  onError: (message: string) => void;
  readOnly?: boolean;
  defaultOpen?: boolean;
  devices?: { id: string; online: boolean }[];
}) {
  const sender = !session || p.senderId === session.id,
    canOperate = !!session && !readOnly;
  const [open, setOpen] = useState(defaultOpen || p.state === 'uploading' || !sender),
    [tab, setTab] = useState<'files' | 'devices'>('files');
  const [page, setPage] = useState(0),
    [devicePage, setDevicePage] = useState(0),
    [query, setQuery] = useState(''),
    [recipientFilePages, setRecipientFilePages] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState(''),
    [confirmCancel, setConfirmCancel] = useState(false);
  const uploaded = p.files.filter((f) => ['staged', 'ready'].includes(f.state)).length;
  const packageApi = <T,>(action: string, body: unknown = {}) =>
    request<T>(session!.base, session!.token, `/api/packages/${p.id}/${action}`, body);
  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setResult('');
    try {
      await fn();
    } catch (e: any) {
      onError(e.message);
    } finally {
      setBusy(false);
      onUpdated();
    }
  }
  const rows = p.files.filter((f) => {
    const t = f.transfers.find((t) => t.recipientId === session?.id);
    const local = localFiles.find((l) => l.stationId === p.stationId && l.transferId === t?.id);
    return t && available(t, local);
  });
  async function batch(action: 'download' | 'reject', ids: string[]) {
    if (!session || p.state !== 'ready') return;
    let done = 0,
      failed = 0;
    const queue = [...ids];
    async function worker() {
      while (queue.length) {
        const id = queue.shift()!;
        try {
          // 每一项开始前再检查服务端D/T，不为排队下载预留超期权限。
          const fresh = await request<PackageView>(
            session!.base,
            session!.token,
            `/api/packages/${p.id}`,
          );
          if (fresh.state !== 'ready') throw new Error('发送已取消');
          const file = fresh.files.find((f) => f.id === id)!,
            task = file?.transfers.find((t) => t.recipientId === session!.id);
          if (!task) throw new Error('文件已不可用');
          if (action === 'reject')
            await request(session!.base, session!.token, `/api/transfers/${task.id}/reject`, {});
          else {
            const ready =
              task.status === 'pending'
                ? await request<Transfer>(
                    session!.base,
                    session!.token,
                    `/api/transfers/${task.id}/accept`,
                    {},
                  )
                : task;
            // 文件名在选择项挂载时本地解密；服务端始终保存密文。
            const name = await resolveFileName(file, session!);
            if (name === null) throw new Error('无法解密文件名，请保留原设备身份');
            if (window.relay3)
              await window.relay3.download({
                base: session!.base,
                token: session!.token,
                id: task.id,
                packageId: p.id,
                name,
                size: file.size,
                sha256: ready.sha256!,
                stationId: session!.stationId,
                stationName: session!.stationName,
              });
            else {
              const a = document.createElement('a');
              a.href = `${session!.base}/api/transfers/${task.id}/download?token=${encodeURIComponent(session!.token)}`;
              a.download = name;
              a.click();
            }
          }
          done++;
        } catch {
          failed++;
        }
        setResult(
          `${action === 'reject' ? '已拒绝' : window.relay3 ? '已下载' : '已开始下载'} ${done} 项${failed ? ` · ${failed} 项失败或已超时` : ''}`,
        );
        onUpdated();
      }
    }
    await Promise.all(
      Array.from({ length: window.relay3 ? Math.min(2, queue.length) : 1 }, worker),
    );
    setSelected([]);
  }
  const recipientRows = p.recipients
    .filter((d) => d.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    .sort(
      (a, b) =>
        Number(devices.find((d) => d.id === b.id)?.online) -
        Number(devices.find((d) => d.id === a.id)?.online),
    );
  return (
    <article
      className="file-package"
      data-package-id={p.id}
      data-scroll-id={`package:${p.stationId}:${p.id}`}
    >
      <button
        className="package-summary"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <FileBox size={24} />
        <span>
          <strong>
            <DeliveryTitle files={p.files} session={session} stationId={p.stationId} />
          </strong>
          <small>
            {sizes(p.files.reduce((n, f) => n + f.size, 0))} ·{' '}
            {p.senderId === session?.id ? '发送' : `来自 ${p.senderName}`} · {p.stationName}
          </small>
        </span>
        <span className="package-phase">
          {p.state === 'cancelled'
            ? '已取消'
            : p.state === 'uploading'
              ? `尚未发送 · 已上传 ${uploaded}/${p.files.length}`
              : p.files.every((f) => f.cleanedAt)
                ? '缓存已清理'
                : Date.now() >= (p.receiveDeadline ?? 0)
                  ? '接收期已结束'
                  : p.files.every((f) =>
                        f.transfers.every((t) =>
                          ['completed', 'rejected', 'cancelled'].includes(t.status),
                        ),
                      )
                    ? '全部已处理'
                    : '等待接收'}
        </span>
        <ChevronDown size={16} className={open ? 'expanded' : ''} />
      </button>
      {open && (
        <div className="package-body">
          <div className="package-meta">
            <span>{date(p.createdAt)}</span>
            {p.receiveDeadline ? (
              <span>
                接收截止 {date(p.receiveDeadline)} · 缓存清理 {date(p.expiresAt)}
              </span>
            ) : (
              <span>全部上传成功后统一开始接收计时</span>
            )}
          </div>
          {p.remark && (
            <blockquote>
              <strong>{{ note: '说明', hint: '提示', clue: '线索' }[p.remarkStyle]}：</strong>
              {p.remark}
            </blockquote>
          )}
          {sender && (
            <div className="package-tabs">
              <button aria-pressed={tab === 'files'} onClick={() => setTab('files')}>
                文件明细
              </button>
              <button aria-pressed={tab === 'devices'} onClick={() => setTab('devices')}>
                接收设备 · {p.recipients.length}
              </button>
            </div>
          )}
          {tab === 'files' ? (
            <>
              <div className="package-files">
                {p.files
                  .slice(
                    Math.min(page, Math.ceil(p.files.length / 8) - 1) * 8,
                    (Math.min(page, Math.ceil(p.files.length / 8) - 1) + 1) * 8,
                  )
                  .map((f) => (
                    <PackageFileRow
                      key={f.id}
                      f={f}
                      p={p}
                      session={session}
                      localFiles={localFiles}
                      sender={sender}
                      selected={selected.includes(f.id)}
                      selectable={
                        canOperate &&
                        !sender &&
                        p.state === 'ready' &&
                        rows.some((r) => r.id === f.id)
                      }
                      onSelect={(checked) =>
                        setSelected((old) =>
                          checked ? [...old, f.id] : old.filter((id) => id !== f.id),
                        )
                      }
                      busy={busy}
                      readOnly={readOnly || p.state === 'cancelled'}
                      onUpdated={onUpdated}
                      onError={onError}
                      retry={(file) =>
                        run(async () => {
                          await uploadPackageFile(session!, file, f);
                          const fresh = await request<PackageView>(
                            session!.base,
                            session!.token,
                            `/api/packages/${p.id}`,
                          );
                          if (fresh.files.every((f) => f.state === 'staged'))
                            await packageApi('publish');
                        })
                      }
                    />
                  ))}
              </div>
              {p.files.length > 8 && (
                <div className="package-pagination">
                  <button
                    aria-label="文件上一页"
                    disabled={!page}
                    onClick={() => setPage(page - 1)}
                  >
                    <ChevronLeft size={16} />
                  </button>
                  <span>
                    {Math.min(page + 1, Math.ceil(p.files.length / 8))}/
                    {Math.ceil(p.files.length / 8)}
                  </span>
                  <button
                    aria-label="文件下一页"
                    disabled={(page + 1) * 8 >= p.files.length}
                    onClick={() => setPage(page + 1)}
                  >
                    <ChevronRight size={16} />
                  </button>
                </div>
              )}
            </>
          ) : (
            <>
              <input
                aria-label="搜索接收设备"
                placeholder="搜索接收设备"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setDevicePage(0);
                }}
              />
              {recipientRows.slice(devicePage * 4, (devicePage + 1) * 4).map((d) => {
                const tasks = p.files.flatMap((f) =>
                  f.transfers.filter((t) => t.recipientId === d.id),
                );
                const received = tasks.filter((t) => t.lastDownloadedAt).length,
                  rejected = tasks.filter((t) => t.status === 'rejected').length,
                  pending = tasks.filter(
                    (t) =>
                      ['pending', 'ready', 'downloading', 'awaiting-confirm'].includes(t.status) &&
                      !t.cleanedAt &&
                      (t.status === 'downloading' || Date.now() < (t.receiveDeadline ?? 0)),
                  ).length,
                  expired = tasks.filter((t) =>
                    ['expired', 'receive-expired'].includes(t.status),
                  ).length,
                  cleaned = tasks.filter((t) => t.cleanedAt && !t.lastDownloadedAt).length,
                  filePage = Math.min(
                    recipientFilePages[d.id] ?? 0,
                    Math.max(0, Math.ceil(p.files.length / 8) - 1),
                  );
                return (
                  <details className="package-recipient-detail" key={d.id}>
                    <summary className="package-recipient">
                      <DeviceAvatar id={d.id} name={d.name} avatar={d.avatar} size={28} />
                      <span>
                        {d.name}
                        <DeviceTag platform={d.platform} />
                        <small>
                          {devices.find((x) => x.id === d.id)?.online ? '在线' : '离线'} · 已收到{' '}
                          {received}/{tasks.length}
                          {rejected ? ` · 已拒绝 ${rejected}` : ''} · 待处理 {pending}
                          {expired ? ` · 超时未处理 ${expired}` : ''}
                          {cleaned ? ` · 缓存已清理 ${cleaned}` : ''}
                        </small>
                      </span>
                      <ChevronDown size={15} />
                    </summary>
                    <div className="package-recipient-files">
                      {p.files.slice(filePage * 8, (filePage + 1) * 8).map((file) => (
                        <RecipientFile
                          key={file.id}
                          file={file}
                          stationId={p.stationId}
                          recipientId={d.id}
                          session={session}
                        />
                      ))}
                      {p.files.length > 8 && (
                        <div className="package-pagination">
                          <button
                            aria-label={`${d.name}文件上一页`}
                            disabled={!filePage}
                            onClick={() =>
                              setRecipientFilePages((old) => ({ ...old, [d.id]: filePage - 1 }))
                            }
                          >
                            <ChevronLeft size={16} />
                          </button>
                          <span>
                            {filePage + 1}/{Math.ceil(p.files.length / 8)}
                          </span>
                          <button
                            aria-label={`${d.name}文件下一页`}
                            disabled={(filePage + 1) * 8 >= p.files.length}
                            onClick={() =>
                              setRecipientFilePages((old) => ({ ...old, [d.id]: filePage + 1 }))
                            }
                          >
                            <ChevronRight size={16} />
                          </button>
                        </div>
                      )}
                    </div>
                  </details>
                );
              })}
              {recipientRows.length > 4 && (
                <div className="package-pagination">
                  <button
                    aria-label="接收设备上一页"
                    disabled={!devicePage}
                    onClick={() => setDevicePage(devicePage - 1)}
                  >
                    <ChevronLeft size={16} />
                  </button>
                  <span>
                    {devicePage + 1}/{Math.ceil(recipientRows.length / 4)}
                  </span>
                  <button
                    aria-label="接收设备下一页"
                    disabled={(devicePage + 1) * 4 >= recipientRows.length}
                    onClick={() => setDevicePage(devicePage + 1)}
                  >
                    <ChevronRight size={16} />
                  </button>
                </div>
              )}
            </>
          )}
          {p.removedCount > 0 && <small>发送前已移除 {p.removedCount} 个未成功上传的文件</small>}
          {canOperate && (
            <div className="package-actions">
              {sender && session && p.state !== 'uploading' && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    window.dispatchEvent(
                      new CustomEvent('relay3-resend', { detail: { p, session } }),
                    )
                  }
                >
                  <Send size={15} />
                  重新发送
                </button>
              )}
              {sender && p.state === 'uploading' && (
                <>
                  <button
                    className="primary"
                    disabled={busy || !uploaded || p.files.some((f) => f.state === 'uploading')}
                    onClick={() =>
                      void run(async () => {
                        const failed = p.files
                          .filter((f) => !['staged', 'uploading'].includes(f.state))
                          .map((f) => f.id);
                        if (failed.length) await packageApi('drop', { ids: failed });
                        await packageApi('publish');
                      })
                    }
                  >
                    {uploaded === p.files.length ? '完成发送' : '仅发送已上传文件'}
                  </button>
                  <Tooltip text="仅保留上传成功的文件，移除未成功文件；发送后清单无法修改。">
                    <CircleHelp size={14} />
                  </Tooltip>
                </>
              )}
              {sender && p.state === 'ready' && (
                <button
                  disabled={busy || Date.now() >= (p.receiveDeadline ?? 0)}
                  onClick={() =>
                    void run(async () => {
                      const r = await packageApi<{ notified: string[] }>('remind');
                      setResult(`已提醒 ${r.notified.length} 台在线未处理设备`);
                    })
                  }
                >
                  <Bell size={15} />
                  提醒未处理设备
                </button>
              )}
              {sender && p.state !== 'cancelled' && (
                <button disabled={busy} onClick={() => setConfirmCancel(true)}>
                  取消发送
                </button>
              )}
              {!sender && p.state === 'ready' && (
                <>
                  <button
                    disabled={busy || !rows.length}
                    onClick={() => setSelected(rows.map((f) => f.id))}
                  >
                    全选可下载文件
                  </button>
                  <button
                    className="primary"
                    disabled={busy || !selected.length}
                    onClick={() => void run(() => batch('download', selected))}
                  >
                    下载所选（{selected.length}）
                  </button>
                  <button
                    disabled={
                      busy ||
                      !p.files.some((f) =>
                        f.transfers.some(
                          (t) =>
                            t.recipientId === session?.id &&
                            t.status === 'pending' &&
                            !t.cleanedAt &&
                            Date.now() < (t.receiveDeadline ?? 0),
                        ),
                      )
                    }
                    onClick={() =>
                      void run(() =>
                        batch(
                          'reject',
                          p.files
                            .filter((f) =>
                              f.transfers.some(
                                (t) =>
                                  t.recipientId === session?.id &&
                                  t.status === 'pending' &&
                                  !t.cleanedAt &&
                                  Date.now() < (t.receiveDeadline ?? 0),
                              ),
                            )
                            .map((f) => f.id),
                        ),
                      )
                    }
                  >
                    拒绝剩余文件
                  </button>
                </>
              )}
            </div>
          )}
          {result && <p role="status">{result}</p>}
        </div>
      )}
      {confirmCancel && (
        <ChatDialog label="取消发送" dismissible={false} onClose={() => setConfirmCancel(false)}>
          <div className="chat-modal">
            <div className="section-head">
              <h2>取消发送</h2>
              <button aria-label="关闭取消发送" onClick={() => setConfirmCancel(false)}>
                <X size={18} />
              </button>
            </div>
            <p>停止本次发送的全部文件上传和下载。已收到的本地文件与历史记录保留。</p>
            <button
              className="danger"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await packageApi('cancel');
                  setConfirmCancel(false);
                })
              }
            >
              确认取消
            </button>
          </div>
        </ChatDialog>
      )}
    </article>
  );
}
function PackageFileRow({
  f,
  p,
  session,
  localFiles,
  sender,
  selected,
  selectable,
  onSelect,
  busy,
  readOnly,
  onUpdated,
  onError,
  retry,
}: {
  f: SharedFile & { transfers: Transfer[] };
  p: PackageView;
  session?: Session;
  localFiles: LocalFile[];
  sender: boolean;
  selected: boolean;
  selectable: boolean;
  onSelect: (value: boolean) => void;
  busy: boolean;
  readOnly: boolean;
  onUpdated: () => void;
  onError: (message: string) => void;
  retry: (file: File) => Promise<void>;
}) {
  const hidden = f.envelope ? hiddenFileName(p.stationId, f.id) : f.name;
  const [name, setName] = useState(f.envelope ? hidden : f.name);
  useEffect(() => {
    let dead = false;
    if (session)
      void resolveFileName(f, session)
        .then((value) => {
          if (!dead) setName(value ?? hidden);
        })
        .catch(() => {});
    return () => {
      dead = true;
    };
  }, [f.id, JSON.stringify(f.envelope), session?.id, session?.token]);
  const task = f.transfers.find((t) => sender || t.recipientId === session?.id);
  const [sourceExists, setSourceExists] = useState(false);
  useEffect(() => {
    if (sender && window.relay3)
      void window.relay3
        .canRevealFile({ kind: 'source', id: f.id, stationId: p.stationId })
        .then(setSourceExists)
        .catch(() => {});
  }, [f.id, sender]);
  return (
    <div className="package-file-row">
      {!sender && !readOnly && (
        <input
          type="checkbox"
          aria-label={`选择 ${name}`}
          checked={selected}
          disabled={!selectable || busy}
          onChange={(e) => onSelect(e.target.checked)}
        />
      )}
      <div className="package-file-main">
        <strong>{name}</strong>
        <small>
          {sizes(f.size)}
          {sender && task?.uploadDuration != null
            ? ` · 上传耗时 ${duration(task.uploadDuration)}`
            : ''}
          {sender
            ? ` · 已收到 ${f.transfers.filter((t) => t.lastDownloadedAt).length}/${f.transfers.length}`
            : ''}
        </small>
        {sender ? (
          <span className="package-file-state">
            {f.cleanedAt
              ? '中转缓存已清理'
              : {
                  waiting: '等待上传',
                  uploading: `上传中 ${sizes(f.uploaded)}/${sizes(f.size)}`,
                  staged: '已上传 · 等待发送',
                  ready: '已上传',
                  failed: '上传失败',
                  cleaned: '中转缓存已清理',
                }[f.state]}
          </span>
        ) : (
          task && (
            <FileTask
              t={task}
              session={!readOnly ? session : undefined}
              localFiles={localFiles}
              name={name}
              compact
              onUpdated={onUpdated}
              onError={onError}
            />
          )
        )}
      </div>
      {sender && (
        <div className="package-file-controls">
          {p.state === 'uploading' && ['waiting', 'failed'].includes(f.state) && !readOnly && (
            <label className="retry-file">
              重传
              <input
                type="file"
                aria-label={`重传 ${name}`}
                disabled={busy}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void retry(file);
                }}
              />
            </label>
          )}
          {sourceExists && (
            <button
              aria-label={`打开 ${name} 所在目录`}
              onClick={() =>
                void window
                  .relay3!.revealFile({ kind: 'source', id: f.id, stationId: p.stationId })
                  .catch((e) => onError(e.message))
              }
            >
              <FolderOpen size={16} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function RecipientFile({
  file,
  recipientId,
  stationId,
  session,
}: {
  file: SharedFile & { transfers: Transfer[] };
  recipientId: string;
  stationId: string;
  session?: Session;
}) {
  const hidden = file.envelope ? hiddenFileName(stationId, file.id) : file.name;
  const [name, setName] = useState(file.envelope ? hidden : file.name);
  useEffect(() => {
    let dead = false;
    if (session)
      void resolveFileName(file, session)
        .then((value) => {
          if (!dead) setName(value ?? hidden);
        })
        .catch(() => {});
    return () => {
      dead = true;
    };
  }, [file.id, session?.id, session?.token]);
  const task = file.transfers.find((t) => t.recipientId === recipientId);
  return (
    <div className="package-recipient-file">
      <strong>{name}</strong>
      {task?.duration != null && <small>传输耗时 {duration(task.duration)}</small>}
      {task && <FileTask t={task} compact onUpdated={() => {}} onError={() => {}} />}
    </div>
  );
}
