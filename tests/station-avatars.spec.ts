import { test, expect, _electron } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('在线头像在左右分栏内自适应分页，悬停展示连接时间且离线后移除', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'relay3-online-avatars-'));
  const app = await _electron.launch({
    args: ['.'],
    cwd: process.cwd(),
    env: { ...process.env, RELAY3_DATA_DIR: dir },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    const status = await page.evaluate(async () => {
      const b = await window.relay3!.bootstrap();
      return (
        await fetch(b.controlUrl + '/admin/status', {
          headers: { Authorization: 'Bearer ' + b.adminToken },
        })
      ).json();
    });
    const connectedAt = Date.now() - 60000;
    status.running = true;
    status.addresses = ['http://192.168.1.8:42830'];
    status.devices = Array.from({ length: 88 }, (_, i) => ({
      id: `test-device-${i}`,
      name: `在线设备${i}`,
      online: true,
      lastSeen: connectedAt,
      firstSeen: connectedAt,
      disconnectedAt: null,
      ip: '192.168.1.8',
      platform: 'Mac',
      loginCount: 1,
      avatar: { theme: 'bots', palette: 'sky' },
    }));
    await page.route('**/admin/status', (route) => route.fulfill({ json: status }));
    await page.getByRole('button', { name: '本机中转站', exact: true }).click();
    const online = page.getByRole('region', { name: '当前在线设备' });
    await expect(online.getByLabel('在线设备数量')).toHaveText('88');
    for (const [width, height] of [
      [1400, 920],
      [1000, 700],
      [900, 600],
    ]) {
      await app.evaluate(
        ({ BrowserWindow }, { width, height }) =>
          BrowserWindow.getAllWindows()[0].setSize(width, height),
        { width, height },
      );
      await expect
        .poll(async () => page.locator('.station-avatar-cell').count())
        .toBeGreaterThan(0);
      const metrics = await page.evaluate(() => {
        const grid = document.querySelector<HTMLElement>('.station-avatar-grid')!;
        const left = document.querySelector<HTMLElement>('.station-main')!;
        const panel = document.querySelector<HTMLElement>('.station-panel')!;
        const settings = [...document.querySelectorAll('button')].find(
          (b) => b.textContent?.trim() === '中转站设置',
        )!;
        const heading = document.querySelector('.station-online-heading')!;
        return {
          gridRight: grid.getBoundingClientRect().right,
          leftRight: left.getBoundingClientRect().right,
          scroll: panel.scrollHeight - panel.clientHeight,
          gridScroll: grid.scrollHeight - grid.clientHeight,
          settingsBottom: settings.getBoundingClientRect().bottom,
          headingTop: heading.getBoundingClientRect().top,
        };
      });
      expect(metrics.gridRight).toBeLessThanOrEqual(metrics.leftRight);
      expect(metrics.gridScroll).toBe(0);
      await expect
        .poll(() =>
          page
            .locator('.station-panel')
            .evaluate((panel) => panel.scrollHeight - panel.clientHeight),
        )
        .toBeLessThanOrEqual(1);
      expect(metrics.settingsBottom).toBeLessThan(metrics.headingTop);
    }
    await page.locator('.station-avatar-cell').first().hover();
    await expect(page.getByRole('tooltip')).toContainText('连接时间：');
    await expect(page.getByRole('tooltip')).toContainText('在线设备');
    await online.getByRole('button', { name: '下一页在线设备' }).click();
    await expect(online.getByRole('button', { name: '上一页在线设备' })).toBeEnabled();
    await page.screenshot({ path: 'test-results/station-online-avatars.png' });
    status.devices = [];
    await expect(online.getByLabel('在线设备数量')).toHaveText('0');
    await expect(page.locator('.station-avatar-cell')).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
