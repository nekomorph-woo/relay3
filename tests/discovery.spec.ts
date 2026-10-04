import { test, expect, _electron } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

test('桌面自动发现可选择并配对，更换地址复用凭证，名称更新及关闭移除', async () => {
  const { RelayService } = await import('../dist-electron/index.js');
  const { StationDiscovery } = await import('../dist-electron/discovery.js');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'relay3-discovery-ui-'));
  const remote = new RelayService(path.join(dir, 'station'), path.resolve('dist'));
  const publisher = new StationDiscovery();
  remote.store.settings.port = 0;
  remote.store.saveSettings({ ...remote.store.settings, stationName: '书房自动发现中转站' });
  remote.onHubChanged = () =>
    publisher.publish(
      remote.hub
        ? {
            stationId: remote.store.settings.stationId,
            name: remote.store.settings.stationName,
            port: remote.hub.server.address().port,
            platform: 'PC',
          }
        : undefined,
    );
  await remote.startHub();
  const testPort = remote.hub.server.address().port;
  const application = await _electron.launch({
    args: ['.'],
    cwd: process.cwd(),
    env: { ...process.env, RELAY3_DATA_DIR: path.join(dir, 'client') },
  });
  const page = await application.firstWindow();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.getByRole('button', { name: '连接中转站', exact: true }).click();
    const nearby = page.getByRole('region', { name: '附近的中转站' });
    const station = nearby.getByRole('button', { name: /书房自动发现中转站/ });
    await expect(station).toBeEnabled({ timeout: 20000 });
    await expect(nearby.getByRole('button', { name: /书房自动发现中转站/ })).toHaveCount(1);
    const code = remote.pairingCode;
    await page.getByRole('button', { name: '刷新附近中转站' }).click();
    await expect(station).toBeEnabled();
    expect(remote.pairingCode).toBe(code);
    await station.click();
    await expect(page.getByPlaceholder('http://192.168.1.8:42830')).not.toHaveValue('');
    await expect(page.getByPlaceholder('http://192.168.1.8:42830')).not.toBeVisible();
    await page.getByLabel('配对码', { exact: true }).fill(code);
    await page.getByRole('button', { name: '连接', exact: true }).click();
    await expect(page.locator('main')).toHaveAttribute('data-connected', 'true');
    const connection = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('relay3-session')!),
    );
    expect(remote.pairingCode).not.toBe(code);
    await page.getByRole('button', { name: '断开中转站', exact: true }).click();

    // 仅保留旧地址的凭证，验证新发现地址按 stationId 找回凭证。
    await page.evaluate(async (connection) => {
      const boot = await window.relay3!.bootstrap();
      const old = { ...connection, base: 'http://192.168.250.250:42830', autoConnect: false };
      localStorage.setItem('relay3-hubs', JSON.stringify({ [old.base]: old }));
      const response = await fetch(boot.controlUrl + '/admin/client/session', {
        method: 'POST',
        headers: { Authorization: `Bearer ${boot.adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(old),
      });
      if (!response.ok) throw new Error(await response.text());
    }, connection);
    // bootstrap 还存有第一次的真实地址；用数据库删除该项模拟 DHCP 地址变化。
    const db = new DatabaseSync(path.join(dir, 'client', 'relay3.sqlite'));
    db.prepare('DELETE FROM client_sessions WHERE base=?').run(connection.base);
    db.close();
    await page.reload();
    await page.getByRole('button', { name: '连接中转站', exact: true }).click();
    await expect(station).toBeEnabled({ timeout: 20000 });
    await station.click();
    await expect(page.getByLabel('配对码', { exact: true })).toHaveValue('');
    await page.getByRole('button', { name: '连接', exact: true }).click();
    await expect(page.locator('main')).toHaveAttribute('data-connected', 'true');
    expect(
      await page.evaluate(() => JSON.parse(localStorage.getItem('relay3-session')!).token),
    ).toBe(connection.token);
    await page.getByRole('button', { name: '断开中转站', exact: true }).click();
    await page.getByRole('button', { name: '连接中转站', exact: true }).click();
    remote.store.saveSettings({ ...remote.store.settings, stationName: '更名后的书房中转站' });
    remote.notifyHubChanged();
    await page.getByRole('button', { name: '刷新附近中转站' }).click();
    await expect(nearby.getByRole('button', { name: /更名后的书房中转站/ })).toBeEnabled({
      timeout: 20000,
    });
    await page.screenshot({ path: 'design/qa/desktop-station-discovery.png' });
    await remote.stopHub(true);
    await expect(nearby.locator('.nearby-station')).toHaveCount(0, { timeout: 15000 });
    await page.evaluate(async (port) => {
      const boot = await window.relay3!.bootstrap();
      for (const [route, body] of [
        ['/settings', { port, stationName: '本机自动发现中转站' }],
        ['/station/start', {}],
      ] as const) {
        const response = await fetch(boot.controlUrl + '/admin' + route, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${boot.adminToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error(await response.text());
      }
    }, testPort);
    await page.getByRole('button', { name: '刷新附近中转站' }).click();
    await expect(nearby.getByRole('button', { name: /本机自动发现中转站/ })).toBeEnabled({
      timeout: 20000,
    });
    expect(errors).toEqual([]);
  } finally {
    await application.close();
    await remote.close();
    await publisher.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
