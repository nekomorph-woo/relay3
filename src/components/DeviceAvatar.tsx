import { useMemo } from 'react';
import { createAvatar } from 'avatarka';
import { avatarStyle, type AvatarStyle } from '../avatar';

// 固定协议和设备名称种子，只在当前组件内存中生成 SVG；不保存图片或头像数据。
export function DeviceAvatar({
  name,
  avatar,
  size = 32,
  className = '',
}: {
  id: string;
  name: string;
  avatar?: AvatarStyle;
  size?: number;
  className?: string;
}) {
  const style = avatarStyle(avatar);
  const svg = useMemo(
    () =>
      createAvatar(style.theme, name, {
        namespace: 'relay3-device-v1',
        palette: style.palette,
        backgroundShape: 'rounded',
      }).svg,
    [name, style.theme, style.palette],
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
