import { useEffect, useState } from 'react';
import { X, LoaderCircle } from 'lucide-react';
import { preparationTasks, cancelPreparation } from '../preparation';
import { sizes } from '../api';
export function PreparationProgress({ stationId }: { stationId?: string }) {
  const [, refresh] = useState(0);
  useEffect(() => {
    const listener = () => refresh((n) => n + 1);
    window.addEventListener('relay3-preparation', listener);
    const timer = setInterval(listener, 1000);
    return () => {
      window.removeEventListener('relay3-preparation', listener);
      clearInterval(timer);
    };
  }, []);
  const tasks = preparationTasks().filter((t) => !stationId || t.stationId === stationId);
  if (!tasks.length) return null;
  return (
    <section className="preparation-tasks" aria-label="本机发送准备任务" aria-live="polite">
      {tasks.map((t) => (
        <article key={t.id}>
          <div>
            <strong>
              {t.state === 'running' && <LoaderCircle size={15} className="task-spinning" />}
              {t.name}
            </strong>
            <small>
              {t.stage} · {sizes(t.bytes)} / {sizes(t.total)}
            </small>
            {t.state === 'running' && <progress max={t.total || 1} value={t.bytes} />}
          </div>
          {t.state === 'running' && (
            <button type="button" aria-label="取消发送准备" onClick={() => cancelPreparation(t.id)}>
              <X size={16} />
            </button>
          )}
        </article>
      ))}
    </section>
  );
}
