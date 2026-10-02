import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPlatform } from '../dist-electron/devicePlatform.js';
test('平台识别优先浏览器平台信息，并区分 Android/Linux 与 iPadOS/Mac', () => {
  for (const [input, expected] of [
    [{ userAgentDataPlatform: 'Windows', userAgent: 'Mozilla/5.0' }, 'PC'],
    [{ userAgentDataPlatform: 'macOS' }, 'Mac'],
    [{ userAgentDataPlatform: 'Android', userAgent: 'Mozilla/5.0 (X11; Linux)' }, 'Android'],
    [{ userAgent: 'Mozilla/5.0 (Linux; Android 15)' }, 'Android'],
    [{ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' }, 'iOS'],
    [
      {
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)',
        platform: 'MacIntel',
        maxTouchPoints: 5,
      },
      'iOS',
    ],
    [
      {
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)',
        platform: 'MacIntel',
        maxTouchPoints: 0,
      },
      'Mac',
    ],
    [{ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, 'PC'],
    [{ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' }, 'PC'],
    [{ userAgent: 'Mozilla/5.0' }, 'Unknown'],
  ])
    assert.equal(detectPlatform(input).platform, expected, JSON.stringify(input));
});
