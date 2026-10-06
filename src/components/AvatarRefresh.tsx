import { RefreshCw } from 'lucide-react';
import { DeviceAvatar } from './DeviceAvatar';
import { Tooltip } from './Tooltip';
import type { AvatarStyle } from '../avatar';

export function AvatarRefresh({
  id,
  name,
  avatar,
  busy,
  onRefresh,
}: {
  id: string;
  name: string;
  avatar?: AvatarStyle;
  busy: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="identity-avatar-editor">
      <DeviceAvatar id={id} name={name} avatar={avatar} size={64} />
      <Tooltip
        className="avatar-refresh-anchor"
        tabIndex={-1}
        text="刷新头像：切换风格与配色，保留设备身份"
      >
        <button
          type="button"
          className="avatar-refresh-button"
          aria-label="刷新头像"
          disabled={busy}
          onClick={onRefresh}
        >
          <RefreshCw size={16} />
        </button>
      </Tooltip>
    </div>
  );
}
