import { useEffect, useRef, useState } from 'react';
import { FileBox, ChevronDown, FolderOpen } from 'lucide-react';
import type { PackageView } from '../../server/packages';
import { sizes, date, type CacheState, type Session } from '../api';
import { TransferName } from './FileTask';
export function PackageCache({
  id,
  entries,
  selected,
  setSelected,
  management,
  session,
  onUpdated,
  onError,
  onClean,
}: {
  id: string;
  entries: CacheState['entries'];
  selected: string[];
  setSelected: (ids: string[]) => void;
  management: (path: string, body?: unknown) => Promise<any>;
  session?: Session;
  onUpdated: () => void;
  onError: (message: string) => void;
  onClean: (ids: string[]) => void;
}) {
  const [p, setPackage] = useState<PackageView | null>(null),
    [open, setOpen] = useState(false),
    [page, setPage] = useState(0);
  const manager = useRef(management);
  manager.current = management;
  useEffect(() => {
    let dead = false;
    void manager
      .current('/packages/' + id)
      .then((p) => {
        if (!dead) setPackage(p);
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [id, JSON.stringify(entries.map((e) => [e.id, e.bytes, e.status]))]);
  const ids = [...new Set(entries.map((e) => e.id))],
    chosen = ids.every((id) => selected.includes(id));
  return (
    <article className="file-package package-cache" data-scroll-id={'cache-package:' + id}>
      <div className="package-cache-heading">
        <input
          type="checkbox"
          aria-label="选择整个文件包缓存"
          checked={chosen}
          onChange={() =>
            setSelected(
              chosen
                ? selected.filter((id) => !ids.includes(id))
                : [...new Set([...selected, ...ids])],
            )
          }
        />
        <button className="package-summary" onClick={() => setOpen(!open)} aria-expanded={open}>
          <FileBox size={24} />
          <span>
            <strong>文件包 · {ids.length} 份缓存</strong>
            <small>
              {sizes(entries.reduce((sum, e) => sum + e.bytes, 0))}
              {p ? ` · ${p.senderName}` : ''}
              {p?.state === 'uploading' ? ' · 尚未成包' : ''}
            </small>
          </span>
          <ChevronDown size={16} className={open ? 'expanded' : ''} />
        </button>
        <button onClick={() => onClean(ids)}>清理文件包</button>
      </div>
      {open && (
        <div className="package-body">
          <small>{p?.expiresAt ? `自动清理：${date(p.expiresAt)}` : '成包后统一计时'}</small>
          {entries.slice(page * 8, (page + 1) * 8).map((e) => (
            <div className="package-file-row" key={e.folder + e.id}>
              <input
                type="checkbox"
                disabled={e.busy}
                checked={selected.includes(e.id)}
                onChange={(ev) =>
                  setSelected(
                    ev.target.checked
                      ? [...new Set([...selected, e.id])]
                      : selected.filter((id) => id !== e.id),
                  )
                }
              />
              <div className="package-file-main">
                <strong>
                  <TransferName
                    t={{
                      name: e.name,
                      fileId: e.id,
                      packageId: id,
                      chatMessageId: e.chatMessageId || (p?.chat ? -1 : undefined),
                      stationId: p?.stationId ?? '',
                    }}
                    session={session}
                  />
                </strong>
                <small>
                  {sizes(e.bytes)} ·{' '}
                  {e.folder === 'partial'
                    ? '上传未完成'
                    : p?.state === 'uploading'
                      ? '暂存 · 等待成包'
                      : '完整缓存'}
                  {e.busy ? ' · 正在传输' : ''}
                </small>
              </div>
              <button
                aria-label="打开中转缓存所在目录"
                onClick={() =>
                  void window
                    .relay3!.revealFile({ kind: 'cache', id: e.id })
                    .catch((e) => onError(e.message))
                }
              >
                <FolderOpen size={16} />
              </button>
            </div>
          ))}
          {entries.length > 8 && (
            <div className="package-pagination">
              <button disabled={!page} onClick={() => setPage(page - 1)}>
                上一页
              </button>
              <span>
                {page + 1}/{Math.ceil(entries.length / 8)}
              </span>
              <button disabled={(page + 1) * 8 >= entries.length} onClick={() => setPage(page + 1)}>
                下一页
              </button>
            </div>
          )}
        </div>
      )}
    </article>
  );
}
