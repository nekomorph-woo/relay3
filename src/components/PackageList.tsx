import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { PackageView } from '../../server/packages';
import { request, type Session } from '../api';
import { FilePackageCard } from './FilePackage';
import type { LocalFile } from './FileTask';
export function PackageList({
  session,
  connected,
  localFiles,
  devices = [],
  management,
  onError,
  onUpdated,
  focusId,
}: {
  session: Session;
  connected: boolean;
  localFiles: LocalFile[];
  devices?: { id: string; online: boolean }[];
  management?: (path: string, body?: unknown) => Promise<any>;
  onError: (message: string) => void;
  onUpdated: () => void;
  focusId?: string;
}) {
  const [items, setItems] = useState<PackageView[]>([]),
    [offset, setOffset] = useState(0),
    [total, setTotal] = useState(0),
    [revision, setRevision] = useState(0),
    [loaded, setLoaded] = useState(false),
    [error, setError] = useState('');
  const callbacks = useRef({ management, onUpdated });
  callbacks.current = { management, onUpdated };
  useEffect(() => {
    if (!connected) return;
    let dead = false,
      loading = false;
    async function poll() {
      if (loading) return;
      loading = true;
      try {
        const result = await request<{ items: PackageView[]; total: number }>(
          session.base,
          session.token,
          `/api/packages?active=1&offset=${offset}`,
        );
        if (focusId && !result.items.some((p) => p.id === focusId)) {
          const focused = await request<PackageView>(
            session.base,
            session.token,
            `/api/packages/${focusId}`,
          ).catch(() => null);
          if (focused) result.items.unshift(focused);
        }
        if (!dead) {
          setItems(result.items);
          setTotal(result.total);
          setLoaded(true);
          setError('');
          if (offset && offset >= result.total)
            setOffset(Math.max(0, Math.floor((result.total - 1) / 30) * 30));
        }
        if (!dead && callbacks.current.management)
          await callbacks.current.management('/remember', { records: [], packages: result.items });
      } catch (e: any) {
        if (!dead) setError(e.message);
      } finally {
        loading = false;
      }
    }
    void poll();
    const timer = setInterval(poll, 2000);
    return () => {
      dead = true;
      clearInterval(timer);
    };
  }, [session.stationId, session.base, session.token, connected, offset, revision, focusId]);
  useEffect(() => {
    if (focusId)
      document
        .querySelector(`[data-package-id="${CSS.escape(focusId)}"]`)
        ?.scrollIntoView({ block: 'nearest' });
  }, [focusId, items.some((p) => p.id === focusId)]);
  const refresh = () => {
    setRevision((n) => n + 1);
    callbacks.current.onUpdated();
  };
  const visible = items.filter(
    (p) =>
      p.state === 'uploading' ||
      p.files.some((f) =>
        f.transfers.some(
          (t) =>
            !t.cleanedAt &&
            ([
              'pending',
              'ready',
              'uploading',
              'downloading',
              'awaiting-confirm',
              'accepted',
            ].includes(t.status) ||
              (t.recipientId === session.id &&
                !!t.lastDownloadedAt &&
                Date.now() < (t.expiresAt ?? 0) &&
                !localFiles.some(
                  (l) => l.stationId === p.stationId && l.transferId === t.id && l.exists,
                ))),
        ),
      ),
  );
  return (
    <div className="package-list" aria-label="文件包列表">
      {error && <p role="alert">{error}</p>}
      {!visible.length && (
        <p className="package-empty">
          {loaded ? '暂无待处理文件包' : connected ? '正在读取文件包…' : '中转站已断开'}
        </p>
      )}
      {visible.map((p) => (
        <FilePackageCard
          key={p.id}
          p={p}
          session={session}
          readOnly={!connected}
          localFiles={localFiles}
          devices={devices}
          onUpdated={refresh}
          onError={onError}
        />
      ))}
      {total > 30 && (
        <div className="package-pagination">
          <button
            aria-label="文件包列表上一页"
            disabled={!offset}
            onClick={() => setOffset(offset - 30)}
          >
            <ChevronLeft size={16} />
          </button>
          <span>
            {Math.floor(offset / 30) + 1}/{Math.ceil(total / 30)}
          </span>
          <button
            aria-label="文件包列表下一页"
            disabled={offset + 30 >= total}
            onClick={() => setOffset(offset + 30)}
          >
            <ChevronRight size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
