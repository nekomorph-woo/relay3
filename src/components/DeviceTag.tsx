import { Monitor, Smartphone, Apple, Airplay, HelpCircle } from 'lucide-react';
export function deviceKind(platform?: string | null) {
  if (/iPhone|iPad|iPod|iOS/i.test(platform ?? '')) return { label: 'iOS手机', Icon: Apple };
  if (/Android/i.test(platform ?? '')) return { label: '安卓手机', Icon: Smartphone };
  if (/Mac|darwin/i.test(platform ?? '')) return { label: 'Mac', Icon: Airplay };
  if (/^PC$|Windows|Win32|Linux/i.test(platform ?? '')) return { label: 'PC', Icon: Monitor };
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
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1))
    return 'iOS';
  if (/Android/.test(ua)) return 'Android';
  return /Macintosh|Mac OS X/.test(ua) ? 'Mac' : 'PC';
}
