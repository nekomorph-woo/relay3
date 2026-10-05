import { test, expect, _electron } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('设备弹窗更名更新统一头像，服务端设置独立保存并恢复旧页面', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'relay3-identity-ui-'));
  const app = await _electron.launch({
    args: ['.'],
    cwd: process.cwd(),
    env: { ...process.env, RELAY3_DATA_DIR: dir },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByRole('button', { name: '设备身份', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '设备', exact: true })).toHaveCount(0);
    await expect(page.getByText('本机管理', { exact: true })).toHaveCount(0);
    const initial = await page.evaluate(() => window.relay3!.bootstrap());
    const initialSettings = await page.evaluate(async () => {
      const b = await window.relay3!.bootstrap();
      return (
        await (
          await fetch(b.controlUrl + '/admin/status', {
            headers: { Authorization: `Bearer ${b.adminToken}` },
          })
        ).json()
      ).settings;
    });
    const oldAvatar = await page.locator('.device-self .device-avatar').innerHTML();
    await page.getByRole('button', { name: '设备身份', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '设备身份', exact: true });
    await dialog.getByLabel('设备名称').fill('名称生成头像测试');
    const draftAvatar = await dialog.locator('.device-avatar').innerHTML();
    expect(draftAvatar).not.toBe(oldAvatar);
    await page.keyboard.press('Escape');
    await page.mouse.click(2, 2);
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: '保存设备名称' }).click();
    await expect(page.locator('.device-self')).toContainText('名称生成头像测试');
    expect(await page.locator('.device-self .device-avatar').innerHTML()).toBe(draftAvatar);
    expect((await page.evaluate(() => window.relay3!.bootstrap())).deviceId).toBe(initial.deviceId);
    await dialog.getByRole('button', { name: '复制设备标识符' }).click();
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(initial.deviceId);
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '本机中转站', exact: true }).click();
    await page.getByLabel('中转站名称', { exact: true }).fill('独立服务端名称');
    await page.getByRole('spinbutton', { name: '接收缓冲结束后保留时间（小时）' }).fill('3');
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(page.locator('.station-name')).toHaveText('独立服务端名称');
    const settings = await page.evaluate(async () => {
      const b = await window.relay3!.bootstrap();
      return (
        await (
          await fetch(b.controlUrl + '/admin/status', {
            headers: { Authorization: `Bearer ${b.adminToken}` },
          })
        ).json()
      ).settings;
    });
    expect(settings.deviceName).toBe('名称生成头像测试');
    expect(settings.retentionHours).toBe(3);
    expect(settings.receiveDir).toBe(initialSettings.receiveDir);
    expect(settings.cacheDir).toBe(initialSettings.cacheDir);
    await page.screenshot({ path: 'test-results/settings-station.png' });
    await page.getByRole('button', { name: '设备身份', exact: true }).click();
    await page.screenshot({ path: 'test-results/settings-identity.png' });
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '诊断日志', exact: true }).click();
    const logs = page.getByRole('dialog', { name: '诊断日志', exact: true });
    await expect(logs.locator('details')).toHaveCount(0);
    await expect(logs.getByRole('button', { name: '导出诊断日志' })).toBeVisible();
    await page.screenshot({ path: 'test-results/settings-diagnostics.png' });
    await logs.getByRole('button', { name: '关闭', exact: true }).click();
    await page.evaluate(async () => {
      const b = await window.relay3!.bootstrap();
      await fetch(b.controlUrl + '/admin/client/view', {
        method: 'POST',
        headers: { Authorization: `Bearer ${b.adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ stationId: '', page: 'settings' }),
      });
    });
    await page.reload();
    await expect(page.getByRole('heading', { name: '文件传输', exact: true })).toBeVisible();
    await expect(page.locator('.device-self')).toContainText('名称生成头像测试');
    expect(await page.locator('.device-self .device-avatar').innerHTML()).toBe(draftAvatar);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
