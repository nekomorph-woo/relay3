import { browserPlatformInfo, normalizePlatform } from '../devicePlatform';
import { Monitor, Smartphone, Apple, Airplay, HelpCircle } from 'lucide-react';
export function deviceKind(platform?: string | null) {
  const kind = normalizePlatform(platform);
  if (kind === 'iOS') return { label: 'iOS手机', Icon: Apple };
  if (kind === 'Android') return { label: '安卓手机', Icon: Smartphone };
  if (kind === 'Mac') return { label: 'Mac', Icon: Airplay };
  if (kind === 'PC') return { label: 'PC', Icon: Monitor };
  return { label: '未知设备', Icon: HelpCircle };
}
export function DeviceTag({ platform }: { platform?: string | null }) {
  const { label, Icon } = deviceKind(platform);
  return (
    <span className="device-platform-tag" title={label} aria-label={label} role="img">
      <Icon size={13} aria-hidden="true" />
    </span>
  );
}

export function browserPlatform() {
  return browserPlatformInfo().platform;
}
