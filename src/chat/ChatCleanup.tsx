import { reportException } from '../diagnostics';
import { useEffect, useMemo, useState, useRef } from 'react';
import { X, Trash2 } from 'lucide-react';
import { date } from '../api';
import { DeviceTag } from '../components/DeviceTag';
import { DeviceSelect } from '../components/DeviceSelect';
import { ChatDialog } from './ChatDialog';
import type { ChatMessage, ChatFilter } from './types';
export function ChatCleanup({
  management,
  onClose,
  onCleared,
}: {
  management: (url: string, body?: unknown) => Promise<any>;
  onClose: () => void;
  onCleared: () => void;
}) {
  const [period, setPeriod] = useState('720'),
    [custom, setCustom] = useState(''),
    [sender, setSender] = useState(''),
    [mode, setMode] = useState('all');
  const [senders, setSenders] = useState<{ id: string; name: string; platform?: string | null }[]>(
      [],
    ),
    [selected, setSelected] = useState<number[]>([]),
    [page, setPage] = useState(0);
  const [result, setResult] = useState<{ items: ChatMessage[]; total: number }>({
      items: [],
      total: 0,
    }),
    [preview, setPreview] = useState<{ count: number; throughId: number } | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setErrorState] = useState('');
  function setError(message: string) {
    if (message) reportException('chat.cleanup-failed', new Error(message));
    setErrorState(message);
  }
  const before = useMemo(
    () =>
      period === 'all'
        ? undefined
        : period === 'custom'
          ? custom
            ? new Date(custom).getTime()
            : undefined
          : Date.now() - Number(period) * 3600000,
    [period, custom],
  );
  const filter: ChatFilter & { all: true } = {
    all: true,
    ...(before !== undefined ? { before } : {}),
    ...(sender ? { senderId: sender } : {}),
    ...(mode !== 'all' ? { mode } : {}),
  };
  const signature = JSON.stringify(filter);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void management('/chat/catalog')
      .then((r) => setSenders(r.senders))
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    setPreview(null);
    let dead = false;
    void management('/chat/list', { filter, page })
      .then((r) => {
        if (dead) return;
        setResult(r);
        requestAnimationFrame(() => {
          if (!dead && body.current) body.current.scrollTop = 0;
        });
      })
      .catch((e) => !dead && setError(e.message));
    return () => {
      dead = true;
    };
  }, [signature, page]);
  useEffect(() => {
    setPreview(null);
  }, [selected]);
  function change(fn: () => void) {
    fn();
    setPage(0);
    setPreview(null);
  }
  return (
    <ChatDialog
      label="清理大厅历史"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <section className="chat-modal panel chat-clean-modal">
        <div className="dialog-head">
          <h2>清理大厅历史</h2>
          <button aria-label="关闭清理弹窗" disabled={busy} onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="chat-modal-body" ref={body}>
          <div className="chat-clean-controls">
            <p>
              筛选条件同时生效（AND）。可叠加时间、发送设备、消息模式和多选消息。收发文件记录与磁盘文件保留。
            </p>
            {error && (
              <p role="alert" className="error-text">
                {error}
              </p>
            )}
            <div className="chat-clean-filters">
              <label>
                发送时间早于
                <select
                  aria-label="发送时间早于"
                  disabled={busy}
                  value={period}
                  onChange={(e) => change(() => setPeriod(e.target.value))}
                >
                  <option value="24">1 天前</option>
                  <option value="168">7 天前</option>
                  <option value="720">30 天前</option>
                  <option value="custom">指定日期</option>
                  <option value="all">全部时间</option>
                </select>
              </label>
              {period === 'custom' && (
                <label>
                  截止日期
                  <input
                    disabled={busy}
                    type="datetime-local"
                    value={custom}
                    onChange={(e) => change(() => setCustom(e.target.value))}
                  />
                </label>
              )}
              <DeviceSelect
                label="发送设备"
                value={sender}
                onChange={(id) => change(() => setSender(id))}
                devices={senders}
                placeholder="所有设备"
                disabled={busy}
              />
              <label>
                消息模式
                <select
                  aria-label="消息模式"
                  disabled={busy}
                  value={mode}
                  onChange={(e) => change(() => setMode(e.target.value))}
                >
                  <option value="all">所有模式</option>
                  <option value="plain">普通模式</option>
                  <option value="encrypted">密文模式</option>
                </select>
              </label>
            </div>
            <div className="chat-selection">
              <span>
                匹配 {result.total} 条，已选择 {selected.length} / 500
                条；不选择单条时按筛选范围清理。
              </span>
              <button
                disabled={
                  busy ||
                  !result.items.length ||
                  selected.length + result.items.filter((m) => !selected.includes(m.id)).length >
                    500
                }
                onClick={() =>
                  setSelected((ids) =>
                    Array.from(new Set([...ids, ...result.items.map((m) => m.id)])),
                  )
                }
              >
                选择本页
              </button>
              <button disabled={busy || !selected.length} onClick={() => setSelected([])}>
                取消选择
              </button>
            </div>
          </div>
          <div className="chat-modal-content">
            {result.items.map((m) => (
              <label className="chat-clean-row" key={m.id}>
                <input
                  type="checkbox"
                  disabled={busy || (!selected.includes(m.id) && selected.length >= 500)}
                  checked={selected.includes(m.id)}
                  onChange={(e) =>
                    setSelected((ids) =>
                      e.target.checked ? [...ids, m.id] : ids.filter((id) => id !== m.id),
                    )
                  }
                />
                <div>
                  <strong>
                    {m.senderName}
                    <DeviceTag platform={m.senderPlatform} />
                  </strong>
                  <small>
                    {date(m.createdAt)} · {m.mode === 'encrypted' ? '密文' : '普通'}
                  </small>
                  {m.mode === 'encrypted' ? (
                    <pre>[加密正文]</pre>
                  ) : (
                    <details className="chat-message-preview">
                      <summary>
                        {[...(m.content ?? '')].slice(0, 120).join('')}
                        {[...(m.content ?? '')].length > 120 ? '…' : ''}
                      </summary>
                      <pre>{m.content}</pre>
                    </details>
                  )}
                  {m.remark && <p>公开备注：{m.remark}</p>}
                </div>
              </label>
            ))}
            {!result.items.length && <p>当前条件没有匹配消息</p>}
          </div>
        </div>
        <div className="chat-modal-footer">
          <div className="chat-pagination">
            <button disabled={busy || page === 0} onClick={() => setPage((p) => p - 1)}>
              上一页
            </button>
            <span>
              {page + 1} / {Math.max(1, Math.ceil(result.total / 20))}
            </span>
            <button
              disabled={busy || (page + 1) * 20 >= result.total}
              onClick={() => setPage((p) => p + 1)}
            >
              下一页
            </button>
          </div>
          {preview && (
            <p className="chat-clean-preview">
              将永久删除 {preview.count} 条消息。预览后新发送的消息不会被删除。
            </p>
          )}
          <div className="dialog-actions">
            <button disabled={busy} onClick={onClose}>
              取消
            </button>
            <button
              disabled={busy || (period === 'custom' && !custom)}
              onClick={() => {
                setBusy(true);
                setError('');
                void management('/chat/preview', {
                  ...filter,
                  ...(selected.length ? { ids: selected } : {}),
                })
                  .then(setPreview)
                  .catch((e) => setError(e.message))
                  .finally(() => setBusy(false));
              }}
            >
              预览清理
            </button>
            <button
              className="danger"
              disabled={busy || !preview || preview.count === 0}
              onClick={() => {
                setBusy(true);
                setError('');
                void management('/chat/clear', {
                  ...filter,
                  ...(selected.length ? { ids: selected } : {}),
                  throughId: preview!.throughId,
                })
                  .then(() => {
                    onCleared();
                    onClose();
                  })
                  .catch((e) => setError(e.message))
                  .finally(() => setBusy(false));
              }}
            >
              <Trash2 size={16} />
              确认永久清理
            </button>
          </div>
        </div>
      </section>
    </ChatDialog>
  );
}
