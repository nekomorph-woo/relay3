import { useEffect, useState } from 'react';
import { FileBox, X } from 'lucide-react';
import { ChatDialog } from '../chat/ChatDialog';
import { FilePackageCard } from './FilePackage';
import { request, type Session } from '../api';
import { rememberPackages } from '../packageDelivery';
import type { PackageView } from '../../server/packages';
import type { LocalFile } from './FileTask';
export function PackageDialog({
  id,
  session,
  connected,
  devices,
  localFiles,
  onUpdated,
  onClose,
  onError,
}: {
  id: string;
  session: Session;
  connected: boolean;
  devices: { id: string; online: boolean }[];
  localFiles: LocalFile[];
  onUpdated: () => void;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const [p, setPackage] = useState<PackageView | null>(null),
    [error, setError] = useState(''),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!connected) return;
    let dead = false;
    const poll = () =>
      request<PackageView>(session.base, session.token, `/api/packages/${id}`)
        .then((next) => {
          if (!dead) {
            setPackage(next);
            setError('');
            void rememberPackages([next]).catch(() => {});
          }
        })
        .catch((e) => {
          if (!dead) setError(e.message);
        });
    void poll();
    const timer = setInterval(poll, 2000);
    return () => {
      dead = true;
      clearInterval(timer);
    };
  }, [id, session.stationId, connected, revision]);
  return (
    <ChatDialog label="文件详情" dismissible={false} onClose={onClose}>
      <section className="package-dialog panel">
        <header className="dialog-head">
          <h2>
            <FileBox size={20} />
            文件详情
          </h2>
          <button aria-label="关闭文件详情" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className="package-dialog-body">
          {error ? (
            <p role="alert">{error}</p>
          ) : p ? (
            <FilePackageCard
              p={p}
              session={session}
              readOnly={!connected}
              defaultOpen
              localFiles={localFiles}
              devices={devices}
              onUpdated={() => {
                setRevision((n) => n + 1);
                onUpdated();
              }}
              onError={onError}
            />
          ) : (
            <p>{connected ? '正在读取文件…' : '中转站已断开'}</p>
          )}
        </div>
      </section>
    </ChatDialog>
  );
}
