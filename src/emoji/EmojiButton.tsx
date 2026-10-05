import { useEffect, useRef, useState } from 'react';
import { Smile, X } from 'lucide-react';
export function EmojiButton({ onSelect }: { onSelect: (text: string) => void }) {
  const [open, setOpen] = useState(false),
    [error, setError] = useState('');
  const target = useRef<HTMLDivElement>(null),
    pop = useRef<HTMLDivElement>(null),
    anchor = useRef<HTMLButtonElement>(null);
  const callback = useRef(onSelect);
  callback.current = onSelect;
  useEffect(() => {
    if (!open || !target.current || !pop.current || !anchor.current) return;
    let dead = false;
    pop.current.showPopover();
    const r = anchor.current.getBoundingClientRect();
    pop.current.style.left = `${Math.max(8, Math.min(r.left, innerWidth - 360))}px`;
    if (innerWidth <= 600) {
      pop.current.style.left = '8px';
      pop.current.style.top = 'auto';
      pop.current.style.bottom = '8px';
    } else pop.current.style.top = `${Math.max(8, r.top - 420)}px`;
    void Promise.all([
      import('emoji-mart'),
      import('@emoji-mart/data/sets/15/twitter.json'),
      import('@emoji-mart/data/i18n/zh.json'),
    ])
      .then(([{ Picker }, data, i18n]) => {
        if (dead || !target.current) return;
        const picker = new Picker({
          data: data.default,
          i18n: i18n.default,
          locale: 'zh',
          set: 'twitter',
          emojiVersion: 15,
          getSpritesheetURL: () => '/emoji/twitter.png',
          theme: 'light',
          autoFocus: true,
          previewPosition: 'none',
          onEmojiSelect: (emoji: { native: string }) => {
            callback.current(emoji.native);
            setOpen(false);
          },
        });
        target.current.replaceChildren(picker);
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            if (pop.current && anchor.current && innerWidth > 600) {
              const r = anchor.current.getBoundingClientRect();
              const h = pop.current.offsetHeight;
              pop.current.style.top = `${Math.max(8, Math.min(r.top - h - 8, innerHeight - h - 8))}px`;
            }
          }),
        );
      })
      .catch(() => setError('表情面板加载失败，请重试'));
    return () => {
      dead = true;
    };
  }, [open]);
  return (
    <>
      <button
        type="button"
        className="emoji-trigger"
        aria-label="选择表情"
        ref={anchor}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Smile size={17} />
      </button>
      {open && (
        <div
          ref={pop}
          popover="auto"
          className="emoji-popover"
          onToggle={(e) => {
            if (e.newState === 'closed') setOpen(false);
          }}
        >
          <button
            type="button"
            className="emoji-close"
            aria-label="关闭表情"
            onClick={() => setOpen(false)}
          >
            <X size={16} />
          </button>
          {error && <p role="alert">{error}</p>}
          <div ref={target} />
        </div>
      )}
    </>
  );
}
