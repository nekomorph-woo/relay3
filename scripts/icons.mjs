import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
mkdirSync('build/icon.iconset', { recursive: true });
const source = 'design/branding/relay3-icon-v3.png';
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
      await sharp(source)
        .resize(size * scale, size * scale)
        .png()
        .toFile(`build/icon.iconset/icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`);
  execFileSync('iconutil', ['-c', 'icns', 'build/icon.iconset', '-o', 'build/icon.icns']);
}
