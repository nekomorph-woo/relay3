import { useLayoutEffect, useRef, type HTMLAttributes } from 'react';

type Position = { top: number; anchor?: string; offset?: number };
const positions = new Map<string, Position>();
const limit = 200;

// 仅保存当前进程的浏览位置，不写入数据库、文件或浏览器存储。
export function ScrollArea({
  as: Tag = 'div',
  memoryKey,
  ready = true,
  resetOnKeyChange = false,
  children,
  onScroll,
  ...props
}: HTMLAttributes<HTMLElement> & {
  as?: 'div' | 'section' | 'aside' | 'main';
  memoryKey: string;
  ready?: boolean;
  resetOnKeyChange?: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  const previousKey = useRef(memoryKey);
  const restoring = useRef(false);
  const savePosition = () => {
    const node = ref.current;
    if (!node || !ready || restoring.current) return;
    const edge = node.getBoundingClientRect().top;
    const row = Array.from(node.querySelectorAll<HTMLElement>('[data-scroll-id]')).find(
      (row) => row.getBoundingClientRect().bottom > edge + 1,
    );
    positions.delete(memoryKey);
    positions.set(memoryKey, {
      top: node.scrollTop,
      ...(row
        ? { anchor: row.dataset.scrollId, offset: row.getBoundingClientRect().top - edge }
        : {}),
    });
    if (positions.size > limit) positions.delete(positions.keys().next().value!);
  };
  useLayoutEffect(() => {
    if (resetOnKeyChange && previousKey.current !== memoryKey) positions.delete(memoryKey);
    previousKey.current = memoryKey;
    const node = ref.current!;
    const saved = positions.get(memoryKey);
    restoring.current = true;
    let frame = 0;
    if (ready) {
      const row = saved?.anchor
        ? Array.from(node.querySelectorAll<HTMLElement>('[data-scroll-id]')).find(
            (row) => row.dataset.scrollId === saved.anchor,
          )
        : undefined;
      node.scrollTop = row
        ? node.scrollTop +
          row.getBoundingClientRect().top -
          node.getBoundingClientRect().top -
          (saved?.offset ?? 0)
        : (saved?.top ?? 0);
      frame = requestAnimationFrame(() => {
        restoring.current = false;
      });
    }
    return () => {
      cancelAnimationFrame(frame);
      restoring.current = false;
    };
  }, [memoryKey, ready]);
  return (
    <Tag
      {...props}
      ref={(node) => {
        ref.current = node;
      }}
      data-scroll-key={memoryKey}
      onScroll={(event) => {
        onScroll?.(event);
      }}
    >
      {children}
    </Tag>
  );
}
