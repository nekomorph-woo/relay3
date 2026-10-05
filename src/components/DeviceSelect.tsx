import { useEffect, useLayoutEffect, useId, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { DeviceTag } from './DeviceTag';
export function DeviceSelect({
  label,
  value,
  onChange,
  devices,
  placeholder,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (id: string) => void;
  devices: { id: string; name: string; platform?: string | null }[];
  placeholder: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const optionsRef = useRef<HTMLDivElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    if (!open || !optionsRef.current || !trigger.current) return;
    const list = optionsRef.current;
    // 顶层原生 popover 避免被弹窗正文或面板滚动边界裁切。
    list.showPopover();
    const place = () => {
      const rect = trigger.current!.getBoundingClientRect();
      const below = innerHeight - rect.bottom - 12;
      const above = rect.top - 12;
      const upwards = below < 160 && above > below;
      const height = Math.min(240, upwards ? above : below);
      Object.assign(list.style, {
        position: 'fixed',
        inset: 'auto',
        margin: '0',
        left: `${rect.left}px`,
        width: `${rect.width}px`,
        maxHeight: `${Math.max(40, height)}px`,
        top: upwards ? 'auto' : `${rect.bottom + 4}px`,
        bottom: upwards ? `${innerHeight - rect.top + 4}px` : 'auto',
      });
    };
    place();
    window.addEventListener('resize', place);
    const reposition = (event: Event) => {
      if (!list.contains(event.target as Node)) place();
    };
    document.addEventListener('scroll', reposition, true);
    return () => {
      list.hidePopover();
      window.removeEventListener('resize', place);
      document.removeEventListener('scroll', reposition, true);
    };
  }, [open]);
  const selected = devices.find((d) => d.id === value);
  useEffect(() => {
    const close = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  function focusOption() {
    requestAnimationFrame(() => {
      const option =
        root.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]') ??
        root.current?.querySelector<HTMLButtonElement>('[role="option"]');
      option?.focus();
    });
  }
  return (
    <div
      className="device-select-field"
      ref={root}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      <span>{label}</span>
      <button
        ref={trigger}
        type="button"
        className="device-select-trigger"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={id}
        disabled={disabled}
        onClick={() => {
          setOpen(!open);
          if (!open) focusOption();
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setOpen(true);
            focusOption();
          }
        }}
      >
        <span>
          {selected ? (
            <>
              {selected.name}
              <DeviceTag platform={selected.platform} />
            </>
          ) : (
            placeholder
          )}
        </span>
        <ChevronDown size={16} />
      </button>
      {open && (
        <div
          id={id}
          ref={optionsRef}
          popover="manual"
          className="device-select-options"
          role="listbox"
          aria-label={label}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
              trigger.current?.focus();
            }
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const options = Array.from(
                e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]'),
              );
              const current = options.indexOf(document.activeElement as HTMLButtonElement);
              const next =
                options[
                  (current + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
                ];
              next?.focus({ preventScroll: true });
              next?.scrollIntoView({ block: 'nearest' });
            }
          }}
        >
          {[{ id: '', name: placeholder, platform: null }, ...devices].map((d) => (
            <button
              key={d.id}
              type="button"
              role="option"
              aria-selected={d.id === value}
              data-device-id={d.id}
              onClick={() => {
                onChange(d.id);
                setOpen(false);
                trigger.current?.focus();
              }}
            >
              <span>{d.name}</span>
              {d.id && <DeviceTag platform={d.platform} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
