import { preparationTasks } from '../preparation';
import { PreparationProgress } from './PreparationProgress';
import { TransferName } from './FileTask';
import type { Session } from '../api';
import { useEffect, useRef, useState } from 'react';
import {
  LoaderCircle,
  ListTodo,
  Upload,
  Download,
  ScanLine,
  Trash2,
  X,
  AlertCircle,
} from 'lucide-react';
import { sizes } from '../api';
import type { BackgroundTask } from '../../server/tasks';
export function BackgroundTasks({
  management,
  session,
}: {
  management: (path: string) => Promise<any>;
  session?: Session;
}) {
  const [tasks, setTasks] = useState<BackgroundTask[]>([]),
    [open, setOpen] = useState(false);
  const manager = useRef(management);
  manager.current = management;
  const pop = useRef<HTMLDivElement>(null),
    anchor = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let dead = false;
    const refresh = () =>
      void manager
        .current('/tasks')
        .then((r) => !dead && setTasks(r.tasks))
        .catch(() => {});
    refresh();
    const timer = setInterval(refresh, 1000);
    return () => {
      dead = true;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (!open || !pop.current || !anchor.current) return;
    pop.current.showPopover();
    const r = anchor.current.getBoundingClientRect();
    pop.current.style.left = `${Math.min(r.left, innerWidth - 370)}px`;
    pop.current.style.bottom = `${innerHeight - r.top + 8}px`;
  }, [open]);
  const failed = tasks.some((t) => t.state === 'failed');
  const count =
    tasks.filter((t) => t.state === 'running').length +
    preparationTasks().filter((t) => t.state === 'running').length;
  const icons = { upload: Upload, download: Download, scan: ScanLine, cleanup: Trash2 };
  return (
    <div className="background-task-control">
      <button
        ref={anchor}
        aria-expanded={open}
        aria-label="本机中转站后台任务"
        onClick={() => setOpen(!open)}
      >
        {count ? <LoaderCircle size={17} className="task-spinning" /> : <ListTodo size={17} />}
        <span>后台任务{count ? `(${count})` : ''}</span>
        {failed && <AlertCircle size={13} aria-label="有任务失败" />}
      </button>
      {open && (
        <div
          className="background-task-popover"
          popover="auto"
          ref={pop}
          onToggle={(e) => {
            if (e.newState === 'closed') setOpen(false);
          }}
        >
          <header>
            <strong>本机中转站后台任务</strong>
            <button aria-label="关闭后台任务" onClick={() => setOpen(false)}>
              <X size={16} />
            </button>
          </header>
          <div className="background-task-list">
            <PreparationProgress history />
            {tasks.length ? (
              tasks.map((t) => {
                const Icon = icons[t.kind];
                return (
                  <article key={t.id}>
                    <Icon size={16} />
                    <div>
                      <strong>
                        {session && t.fileId ? (
                          <TransferName
                            t={{
                              name: t.name,
                              fileId: t.fileId,
                              chatMessageId: t.name === '未知文件' ? 1 : undefined,
                              stationId: session.stationId,
                            }}
                            session={session}
                          />
                        ) : (
                          t.name
                        )}
                      </strong>
                      <small>
                        {t.deviceName ? `${t.deviceName} · ` : ''}
                        {t.state === 'running'
                          ? '执行中'
                          : t.state === 'completed'
                            ? '已完成'
                            : '失败'}
                      </small>
                      {t.state === 'running' && <progress value={t.bytes} max={t.total || 1} />}
                      <small>
                        {['upload', 'download'].includes(t.kind)
                          ? `${sizes(t.bytes)} / ${sizes(t.total)}`
                          : `已处理 ${t.bytes} / ${t.total}`}
                        {t.kind === 'cleanup' ? ` · 已释放 ${sizes(t.releasedBytes ?? 0)}` : ''}
                        {t.error ? ` · ${t.error}` : ''}
                      </small>
                    </div>
                  </article>
                );
              })
            ) : (
              <p className="subtle">当前没有后台任务</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
