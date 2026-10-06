// 仅保存外观选项，SVG 始终由设备名称在内存中生成。
export const avatarThemes = [
  'folks',
  'adventurers',
  'critters',
  'oddlings',
  'bots',
  'snacks',
  'nooks',
  'orbs',
] as const;
export const avatarPalettes = ['coast', 'orchid', 'clay', 'grove', 'sky', 'mono'] as const;
export interface AvatarStyle {
  theme: (typeof avatarThemes)[number];
  palette: (typeof avatarPalettes)[number];
}
export const defaultAvatar: AvatarStyle = { theme: 'folks', palette: 'coast' };
export function validAvatar(value: unknown): value is AvatarStyle {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as AvatarStyle;
  return avatarThemes.includes(v.theme) && avatarPalettes.includes(v.palette);
}
export function avatarStyle(value: unknown): AvatarStyle {
  return validAvatar(value) ? { theme: value.theme, palette: value.palette } : defaultAvatar;
}
export function nextAvatar(value: unknown): AvatarStyle {
  const current = avatarStyle(value);
  const themes = avatarThemes.filter((v) => v !== current.theme);
  const palettes = avatarPalettes.filter((v) => v !== current.palette);
  return {
    theme: themes[Math.floor(Math.random() * themes.length)],
    palette: palettes[Math.floor(Math.random() * palettes.length)],
  };
}
