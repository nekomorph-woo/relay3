export type Platform = 'PC' | 'Mac' | 'Android' | 'iOS' | 'Unknown';
export type PlatformSource = 'native' | 'browser-platform' | 'user-agent' | 'unknown';
export function normalizePlatform(value?: string | null): Platform {
  if (/iPhone|iPad|iPod|iOS/i.test(value ?? '')) return 'iOS';
  if (/Android/i.test(value ?? '')) return 'Android';
  if (/Mac|darwin/i.test(value ?? '')) return 'Mac';
  if (/^PC$|Windows|Win32|Win64|Linux|CrOS/i.test(value ?? '')) return 'PC';
  return 'Unknown';
}
export function detectPlatform({
  userAgent = '',
  platform = '',
  userAgentDataPlatform = '',
  maxTouchPoints = 0,
}: {
  userAgent?: string;
  platform?: string;
  userAgentDataPlatform?: string;
  maxTouchPoints?: number;
}): { platform: Platform; source: PlatformSource } {
  // iPadOS 的桌面 UA 与 Mac 相似，先结合触控能力判断；Android 先于 Linux。
  if (
    /iPhone|iPad|iPod/.test(userAgent) ||
    (/Mac/i.test(platform + userAgent) && maxTouchPoints > 1)
  )
    return { platform: 'iOS', source: 'user-agent' };
  const hinted = normalizePlatform(userAgentDataPlatform);
  if (hinted !== 'Unknown') return { platform: hinted, source: 'browser-platform' };
  if (/Android/i.test(userAgent)) return { platform: 'Android', source: 'user-agent' };
  const detected =
    normalizePlatform(platform) !== 'Unknown'
      ? normalizePlatform(platform)
      : normalizePlatform(userAgent);
  return { platform: detected, source: detected === 'Unknown' ? 'unknown' : 'user-agent' };
}
export function browserPlatformInfo() {
  const hints = navigator as Navigator & { userAgentData?: { platform?: string } };
  return detectPlatform({
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints,
    userAgentDataPlatform: hints.userAgentData?.platform,
  });
}
