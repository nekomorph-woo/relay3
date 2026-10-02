import {
  test,
  expect,
  _electron,
  chromium,
  type ElectronApplication,
  type Browser,
  type Page,
  type BrowserContext,
} from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
let app: ElectronApplication,
  browser: Browser,
  desktop: Page,
  mobile: Page,
  context: BrowserContext,
  dir: string,
  boot: any,
  base: string;
const errors: string[] = [];
async function admin(route: string, body?: unknown) {
  return desktop.evaluate(
    async ({ route, body }) => {
      const boot = await window.relay3!.bootstrap();
      const response = await fetch(boot.controlUrl + '/admin' + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${boot.adminToken}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      return data;
    },
    { route, body },
  );
}
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'relay3-ui-'));
  app = await _electron.launch({
    ...(process.env.RELAY3_PACKAGED_PATH
      ? { executablePath: process.env.RELAY3_PACKAGED_PATH, args: [] }
      : { args: ['.'] }),
    cwd: process.cwd(),
    env: { ...process.env, RELAY3_DATA_DIR: dir },
  });
  desktop = await app.firstWindow();
  desktop.on('pageerror', (e) => errors.push(e.message));
  await desktop.waitForLoadState('domcontentloaded');
  boot = await desktop.evaluate(() => window.relay3!.bootstrap());
  const portServer = net.createServer();
  await new Promise<void>((resolve) => portServer.listen(0, '127.0.0.1', resolve));
  const testPort = (portServer.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => portServer.close(() => resolve()));
  await admin('/settings', { receiveDir: path.join(dir, 'received'), port: testPort });
  browser = await chromium.launch({ args: ['--no-proxy-server'] });
  context = await browser.newContext({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
    acceptDownloads: true,
  });
  mobile = await context.newPage();
  mobile.on('pageerror', (e) => errors.push(e.message));
});
test.afterAll(async () => {
  await context?.close();
  await browser?.close();
  await app?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});
async function restart() {
  await app.close();
  app = await _electron.launch({
    ...(process.env.RELAY3_PACKAGED_PATH
      ? { executablePath: process.env.RELAY3_PACKAGED_PATH, args: [] }
      : { args: ['.'] }),
    cwd: process.cwd(),
    env: { ...process.env, RELAY3_DATA_DIR: dir },
  });
  desktop = await app.firstWindow();
  desktop.on('pageerror', (e) => errors.push(e.message));
  boot = await desktop.evaluate(() => window.relay3!.bootstrap());
}
test('本机加入支持断开后重连、应用重启、旧版丢失凭证恢复', async () => {
  await desktop.getByRole('button', { name: '开启本机中转站' }).click();
  await desktop.getByRole('button', { name: '本机加入' }).click();
  await expect(desktop.locator('.connection-label')).toContainText('已连接');
  const original = await desktop.evaluate(() =>
    JSON.parse(localStorage.getItem('relay3-session')!),
  );
  await desktop.getByRole('button', { name: '断开', exact: true }).click();
  await desktop.getByRole('button', { name: '本机加入' }).click();
  await expect(desktop.locator('.connection-label')).toContainText('已连接');
  expect(
    await desktop.evaluate(() => JSON.parse(localStorage.getItem('relay3-session')!).token),
  ).toBe(original.token);
  await restart();
  expect(Object.values(boot.savedHubs).some((s: any) => s.token === original.token)).toBeTruthy();
  await desktop.getByRole('button', { name: '开启本机中转站' }).click();
  await desktop.getByRole('button', { name: '本机加入' }).click();
  await expect(desktop.locator('.connection-label')).toContainText('已连接');
  expect(await desktop.evaluate(() => JSON.parse(localStorage.getItem('relay3-session')!).id)).toBe(
    original.id,
  );
  await app.close();
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dir, 'relay3.sqlite'));
  db.exec('DELETE FROM client_sessions');
  db.close();
  app = await _electron.launch({
    ...(process.env.RELAY3_PACKAGED_PATH
      ? { executablePath: process.env.RELAY3_PACKAGED_PATH, args: [] }
      : { args: ['.'] }),
    cwd: process.cwd(),
    env: { ...process.env, RELAY3_DATA_DIR: dir },
  });
  desktop = await app.firstWindow();
  await desktop.getByRole('button', { name: '开启本机中转站' }).click();
  await desktop.getByRole('button', { name: '本机加入' }).click();
  await expect(desktop.locator('.connection-label')).toContainText('已连接');
  const recovered = await desktop.evaluate(() =>
    JSON.parse(localStorage.getItem('relay3-session')!),
  );
  expect(recovered.id).toBe(original.id);
  expect((await admin('/status')).devices.filter((d: any) => d.id === original.id)).toHaveLength(1);
});
test('桌面连接远端后跨重启重连，手机重连不消费数字配对码', async () => {
  const { RelayService } = await import('../dist-electron/index.js');
  const remote = new RelayService(path.join(dir, 'remote'), path.resolve('dist'));
  remote.store.settings.port = 0;
  await remote.startHub();
  const remoteBase = `http://127.0.0.1:${remote.hub.server.address().port}`;
  try {
    await desktop.getByRole('button', { name: '断开', exact: true }).click();
    await desktop.getByRole('button', { name: '连接', exact: true }).click();
    await desktop
      .getByLabel('中转站地址或配对链接')
      .fill(`${remoteBase}/#pair=${remote.pairingToken}`);
    await desktop.locator('dialog').getByRole('button', { name: '连接', exact: true }).click();
    await expect(desktop.locator('.connection-label')).toContainText('已连接');
    const original = await desktop.evaluate(() =>
      JSON.parse(localStorage.getItem('relay3-session')!),
    );
    await restart();
    expect(boot.savedHubs[remoteBase].token).toBe(original.token);
    await desktop.getByRole('button', { name: '连接', exact: true }).click();
    await desktop
      .locator('.remembered')
      .getByRole('button')
      .filter({ hasText: remoteBase })
      .click();
    await expect(desktop.locator('.connection-label')).toContainText('已连接');
    expect(
      await desktop.evaluate(() => JSON.parse(localStorage.getItem('relay3-session')!).token),
    ).toBe(original.token);
    await mobile.goto(`${remoteBase}/#pair=${remote.pairingCode}`);
    await mobile.getByRole('button', { name: '连接设备', exact: true }).click();
    await mobile.getByLabel('设备名称').fill('重连手机');
    await mobile.locator('dialog').getByRole('button', { name: '连接', exact: true }).click();
    await expect(mobile.locator('.connection-label')).toContainText('已连接');
    const code = remote.pairingCode;
    await mobile.getByRole('button', { name: '断开', exact: true }).click();
    await mobile.getByRole('button', { name: '连接', exact: true }).click();
    await mobile.getByLabel('配对码', { exact: true }).fill('000000');
    await mobile.locator('dialog').getByRole('button', { name: '连接', exact: true }).click();
    await expect(mobile.locator('.connection-label')).toContainText('已连接');
    expect(remote.pairingCode).toBe(code);
    const mobileId = await mobile.evaluate(
      () => JSON.parse(localStorage.getItem('relay3-session')!).id,
    );
    remote.forgetDevice(mobileId);
    await expect(mobile.locator('.connection-label')).not.toContainText('已连接');
    await mobile.getByRole('button', { name: '断开', exact: true }).click();
    await mobile.getByRole('button', { name: '连接', exact: true }).click();
    await mobile.getByLabel('配对码', { exact: true }).fill(remote.pairingCode);
    await mobile.locator('dialog').getByRole('button', { name: '连接', exact: true }).click();
    await expect(mobile.locator('.connection-label')).toContainText('已连接');

    expect(errors).toEqual([]);
  } finally {
    await remote.close();
  }
});
