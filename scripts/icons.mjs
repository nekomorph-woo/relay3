import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
mkdirSync('build/icon.iconset', { recursive: true });
const source = 'design/branding/relay3-icon-v3.png';
// macOS rounded tile occupies 832/1024 pixels, with transparent Dock margins.
// Keep the selected monogram; only resize and mask its existing background.
const tileSize = 832;
const mask = Buffer.from(
  `<svg width="${tileSize}" height="${tileSize}" xmlns="http://www.w3.org/2000/svg"><rect width="${tileSize}" height="${tileSize}" rx="186" fill="white"/></svg>`,
);
const macIcon = await sharp(source)
  .resize(tileSize, tileSize)
  .ensureAlpha()
  .composite([{ input: mask, blend: 'dest-in' }])
  .png()
  .toBuffer();
const macCanvas = await sharp(macIcon)
  .extend({ top: 96, bottom: 96, left: 96, right: 96, background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toBuffer();
await sharp(macCanvas).resize(512, 512).png({ palette: true }).toFile('public/relay3-mac.png');
writeFileSync('build/icon-mac.png', macCanvas);
const buffers = [];
for (const size of [16, 32, 64, 128, 256, 512, 1024]) {
  const image = await sharp(source).resize(size, size).png().toBuffer();
  writeFileSync(`build/icon-${size}.png`, image);
  if (size <= 256) buffers.push(image);
}
writeFileSync('build/icon.ico', await pngToIco(buffers));
if (process.platform === 'darwin') {
  for (const size of [16, 32, 128, 256, 512])
    for (const scale of [1, 2])
      await sharp(macCanvas)
        .resize(size * scale, size * scale)
        .png()
        .toFile(`build/icon.iconset/icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`);
  execFileSync('iconutil', ['-c', 'icns', 'build/icon.iconset', '-o', 'build/icon.icns']);
}
