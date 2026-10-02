import { useEffect, useId, useRef, useState } from 'react';
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
  const id = useId();
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
          className="device-select-options"
          role="listbox"
          aria-label={label}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              setOpen(false);
              trigger.current?.focus();
            }
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const options = Array.from(
                e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]'),
              );
              const current = options.indexOf(document.activeElement as HTMLButtonElement);
              options[
                (current + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
              ]?.focus();
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
