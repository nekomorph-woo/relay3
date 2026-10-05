import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import { Tooltip } from './Tooltip';
import type { Session } from '../api';
export function StationSwitcher({
  connections,
  activeId,
  onSelect,
}: {
  connections: { session: Session; status: string; hub?: { chatUnread?: number } | null }[];
  activeId: string;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false),
    anchor = useRef<HTMLButtonElement>(null),
    pop = useRef<HTMLDivElement>(null);
  const current = connections.find((c) => c.session.stationId === activeId);
  const status = (s: string) =>
    s === 'connected' ? '已连接' : s === 'connecting' ? '连接中' : '已断开';
  useEffect(() => {
    if (!open || !pop.current || !anchor.current) return;
    pop.current.showPopover();
    const r = anchor.current.getBoundingClientRect();
    pop.current.style.left = `${Math.max(8, Math.min(r.left, innerWidth - 336))}px`;
    pop.current.style.top = `${Math.min(r.bottom + 6, innerHeight - pop.current.offsetHeight - 8)}px`;
  }, [open]);
  return (
    <>
      <span className="station-switch-label">当前中转站</span>
      <button
        ref={anchor}
        data-station-id={activeId}
        className="station-switch-trigger"
        aria-label="切换中转站"
        aria-expanded={open}
        disabled={!connections.length}
        onClick={() => setOpen(!open)}
      >
        <span>
          <Tooltip text={current?.session.stationName ?? '选择中转站'}>
            <strong>{current?.session.stationName ?? '选择中转站'}</strong>
          </Tooltip>
          <small>
            {current ? status(current.status) : '尚未连接'}
            {current?.hub?.chatUnread ? ` · ${current.hub.chatUnread} 未读` : ''}
          </small>
        </span>
        <ChevronDown size={16} />
      </button>
      {open && (
        <div
          role="listbox"
          aria-label="中转站列表"
          className="station-switch-popover"
          ref={pop}
          popover="auto"
          onToggle={(e) => {
            if (e.newState === 'closed') setOpen(false);
          }}
        >
          {connections.map((c) => (
            <button
              role="option"
              data-station-id={c.session.stationId}
              aria-selected={c.session.stationId === activeId}
              key={c.session.stationId}
              onClick={() => {
                onSelect(c.session.stationId);
                setOpen(false);
              }}
            >
              <span>
                <strong>{c.session.stationName}</strong>
                <small>{c.session.base}</small>
                <small>
                  {status(c.status)}
                  {c.hub?.chatUnread ? ` · ${c.hub.chatUnread} 未读` : ''}
                </small>
              </span>
              {c.session.stationId === activeId && <Check size={17} />}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
