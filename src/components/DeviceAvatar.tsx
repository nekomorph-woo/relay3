import { useMemo } from 'react';
import { createAvatar } from 'avatarka';

// 固定协议和设备种子，只在当前组件内存中生成 SVG；不保存图片或头像数据。
export function DeviceAvatar({
  id,
  name,
  size = 32,
  className = '',
}: {
  id: string;
  name: string;
  size?: number;
  className?: string;
}) {
  const svg = useMemo(
    () =>
      createAvatar('folks', id, {
        namespace: 'relay3-device-v1',
        palette: 'coast',
        backgroundShape: 'rounded',
      }).svg,
    [id],
  );
  return (
    <span
      className={`device-avatar ${className}`}
      role="img"
      aria-label={`${name}的头像`}
      title={name}
      style={{ width: size, height: size }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
