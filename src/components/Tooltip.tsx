import { useId, useLayoutEffect, useRef, useState, type HTMLAttributes } from 'react';
import { createPortal } from 'react-dom';

// 提示挂到页面顶层，避免被列表的滚动容器裁切。
export function Tooltip({
  text,
  children,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { text: string }) {
  const id = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const tip = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  useLayoutEffect(() => {
    if (!open || !anchor.current || !tip.current) return;
    tip.current.showPopover?.();
    const target = anchor.current.getBoundingClientRect();
    const bounds = tip.current.getBoundingClientRect();
    const gap = 8;
    setPosition({
      left: Math.max(
        gap,
        Math.min(target.left + (target.width - bounds.width) / 2, innerWidth - bounds.width - gap),
      ),
      top:
        target.top >= bounds.height + gap * 2
          ? target.top - bounds.height - gap
          : Math.min(target.bottom + gap, innerHeight - bounds.height - gap),
    });
    const close = () => setOpen(false);
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', key);
    };
  }, [open, text]);
  return (
    <span
      {...props}
      ref={anchor}
      tabIndex={props.tabIndex ?? 0}
      aria-describedby={open ? id : undefined}
      onPointerEnter={(event) => {
        if (event.pointerType !== 'touch') setOpen(true);
      }}
      onPointerLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      {open &&
        createPortal(
          <span
            ref={tip}
            id={id}
            role="tooltip"
            popover="manual"
            className="app-tooltip"
            style={position}
          >
            {text}
          </span>,
          document.body,
        )}
    </span>
  );
}
