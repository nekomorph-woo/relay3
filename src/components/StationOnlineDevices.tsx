import { useLayoutEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { AdminState } from '../api';
import { date } from '../api';
import { DeviceAvatar } from './DeviceAvatar';
import { Tooltip } from './Tooltip';

export function StationOnlineDevices({ devices }: { devices: AdminState['devices'] }) {
  const root = useRef<HTMLElement>(null);
  const [columns, setColumns] = useState(1);
  const [rows, setRows] = useState(2);
  const [page, setPage] = useState(0);
  useLayoutEffect(() => {
    const element = root.current!;
    const measure = () => {
      // 每个头像保留 44px 的焦点区域；窄栏减少列数，小窗口减少行数。
      setColumns(Math.max(1, Math.floor((element.clientWidth + 8) / 52)));
      setRows(innerHeight < 600 ? 1 : innerHeight < 760 ? 2 : 3);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener('resize', measure);
    measure();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);
  const online = devices
    .filter((d) => d.online)
    .sort((a, b) => b.lastSeen - a.lastSeen || a.id.localeCompare(b.id));
  const size = columns * rows;
  const pages = Math.max(1, Math.ceil(online.length / size));
  const current = Math.min(page, pages - 1);
  return (
    <section className="station-online-devices" ref={root} aria-label="当前在线设备">
      <div className="station-online-heading">
        <span>在线设备</span>
        <div>
          {pages > 1 && (
            <>
              <button
                type="button"
                className="station-avatar-page"
                aria-label="上一页在线设备"
                disabled={current === 0}
                onClick={() => setPage(current - 1)}
              >
                <ChevronLeft size={16} />
              </button>
              <small aria-live="polite">
                {current + 1} / {pages}
              </small>
              <button
                type="button"
                className="station-avatar-page"
                aria-label="下一页在线设备"
                disabled={current === pages - 1}
                onClick={() => setPage(current + 1)}
              >
                <ChevronRight size={16} />
              </button>
            </>
          )}
          <span aria-label="在线设备数量">{online.length}</span>
        </div>
      </div>
      {online.length > 0 && (
        <div
          className="station-avatar-grid"
          style={{ gridTemplateColumns: `repeat(${columns}, 44px)` }}
        >
          {online.slice(current * size, (current + 1) * size).map((d) => (
            <Tooltip
              key={d.id}
              className="station-avatar-cell"
              text={`${d.name} · 连接时间：${date(d.lastSeen)}`}
            >
              <DeviceAvatar id={d.id} name={d.name} avatar={d.avatar} size={36} />
            </Tooltip>
          ))}
        </div>
      )}
    </section>
  );
}
