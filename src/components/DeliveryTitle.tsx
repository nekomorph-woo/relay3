import { useEffect, useState } from 'react';
import type { SharedFile } from '../../server/files';
import type { Session } from '../api';
import { hiddenFileName } from '../chat/phrases';
import { resolveFileName } from './FileTask';

// 标题只在终端内解密，不把明文名称写回中转站。
export function DeliveryTitle({
  files,
  session,
  stationId,
}: {
  files: SharedFile[];
  session?: Session;
  stationId?: string;
}) {
  const first = files[0];
  const hidden = first?.envelope
    ? hiddenFileName(stationId ?? session?.stationId ?? '', first.id)
    : '';
  const fallback = first ? (first.envelope ? hidden : first.name) : '文件';
  const [resolved, setResolved] = useState<{ key: string; name: string }>();
  const key = JSON.stringify([
    first?.id,
    first?.envelope,
    stationId,
    session?.stationId,
    session?.id,
    session?.token,
  ]);
  useEffect(() => {
    let dead = false;
    if (first?.envelope && session)
      void resolveFileName(first, session)
        .then((name) => {
          if (!dead) setResolved({ key, name: name ?? hidden });
        })
        .catch(() => {});
    return () => {
      dead = true;
    };
  }, [key]);
  const name = resolved?.key === key ? resolved.name : fallback;
  return (
    <>
      {name}
      {files.length > 1 ? ` 等 ${files.length} 个文件` : ''}
    </>
  );
}
