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
test('桌面开启中转站，手机客户端连接，双向传输并保留记录', async () => {
  await desktop.getByRole('button', { name: '本机中转站', exact: true }).click();
  await desktop.getByRole('button', { name: '开启中转站' }).click();
  await expect(desktop.getByRole('heading', { name: '中转站已开启' })).toBeVisible();
  await desktop.getByRole('button', { name: '本机加入' }).click();
  await expect(desktop.locator('main')).toHaveAttribute('data-connected', 'true');
  const status = await admin('/status');
  base = `http://127.0.0.1:${status.settings.port}`;
  await mobile.goto(`${base}/#pair=${status.pairingCode}`);
  await mobile.getByRole('button', { name: '连接中转站', exact: true }).click();
  await mobile.getByLabel('设备名称').fill('测试手机');
  await mobile.locator('dialog').getByRole('button', { name: '连接', exact: true }).click();
  await expect(mobile.locator('main')).toHaveAttribute('data-connected', 'true');
  await desktop.getByRole('button', { name: '文件传输', exact: true }).click();
  await desktop.getByRole('button', { name: '接收设备', exact: true }).click();
  await desktop.getByRole('option').filter({ hasText: '测试手机' }).click();
  const filename =
    '这是一份用于检查手机收到电脑文件时长文件名布局的测试报告_2026年10月_项目资料与附件说明.txt';
  const content = Buffer.from('relay3 桌面发给手机\n'.repeat(120000));
  await desktop
    .getByLabel('选择待发送文件')
    .setInputFiles({ name: filename, mimeType: 'text/plain', buffer: content });
  await desktop.getByRole('button', { name: '发送', exact: true }).click();
  const incoming = mobile.locator('.transfer-row').filter({ hasText: filename });
  for (const width of [320, 375, 414, 768]) {
    await mobile.setViewportSize({ width, height: 900 });
    const details = await incoming.locator('.transfer-details').boundingBox();
    expect(details!.width).toBeGreaterThan(200);
    const title = await incoming.locator('strong').boundingBox();
    expect(title!.height).toBeLessThan(150);
    expect(await mobile.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    await expect(incoming.getByRole('button', { name: '接收', exact: true })).toBeVisible();
  }
  await mobile.setViewportSize({ width: 375, height: 812 });
  await mobile.screenshot({ path: 'test-results/mobile-long-filename.png', fullPage: true });
  await incoming.getByRole('button', { name: '接收', exact: true }).click();
  await expect(incoming.getByRole('button', { name: '下载文件', exact: true })).toBeVisible();
  const downloadPromise = mobile.waitForEvent('download');
  await incoming.getByRole('button', { name: '下载文件', exact: true }).click();
  const download = await downloadPromise;
  await download.saveAs(path.join(dir, 'mobile-download.txt'));
  expect(readFileSync(path.join(dir, 'mobile-download.txt'))).toEqual(content);
  await incoming.getByRole('button', { name: '确认收到' }).click();
  await expect(incoming).toHaveCount(0);
  await mobile.getByRole('button', { name: '接收设备', exact: true }).click();
  await mobile.locator(`[role="option"][data-device-id="${boot.deviceId}"]`).click();
  const back = Buffer.from('手机发送到电脑的文件');
  await mobile
    .getByLabel('选择待发送文件')
    .setInputFiles({ name: '手机文件.txt', mimeType: 'text/plain', buffer: back });
  await mobile.getByRole('button', { name: '发送', exact: true }).click();
  const receive = desktop.locator('.transfer-row').filter({ hasText: '手机文件.txt' });
  await receive.getByRole('button', { name: '接收', exact: true }).click();
  await expect(receive.getByRole('button', { name: '下载文件', exact: true })).toBeVisible();
  await receive.getByRole('button', { name: '下载文件', exact: true }).click();
  await expect(receive).toHaveCount(0);
  expect(readFileSync(path.join(dir, 'received', '手机文件.txt'))).toEqual(back);
  await desktop.getByRole('button', { name: '收发记录', exact: true }).click();
  await expect(desktop.locator('.record-row')).toHaveCount(2);
  await expect(desktop.locator('.record-row').first()).toContainText('已完成');
  await desktop.getByRole('button', { name: '本机存储', exact: true }).click();
  await expect(desktop.locator('.cache-row:not(.received-row)')).toHaveCount(2);
  await desktop.getByLabel('选择所有可清理文件').check();
  await desktop.getByRole('button', { name: /清理所选/ }).click();
  await desktop.getByRole('button', { name: '确认清理' }).click();
  await expect(desktop.locator('.cache-row:not(.received-row)')).toHaveCount(0);
  await desktop.getByRole('button', { name: '收发记录', exact: true }).click();
  await expect(desktop.locator('.record-row')).toHaveCount(2);
  await expect(desktop.locator('.record-row').first()).toContainText('缓存已清理');
  expect(existsSync(path.join(dir, 'received', '手机文件.txt'))).toBeTruthy();
  await desktop.screenshot({ path: 'test-results/desktop-history.png', fullPage: true });
});
test('手机页面在 320、375、414、768 像素下无横向溢出，设置可保存', async () => {
  for (const width of [320, 375, 414, 768]) {
    await mobile.setViewportSize({ width, height: 900 });
    for (const name of ['文件传输', '收发记录', '设置']) {
      await mobile.getByRole('button', { name, exact: true }).click();
      const dimensions = await mobile.evaluate(() => ({
        width: innerWidth,
        scroll: document.documentElement.scrollWidth,
      }));
      expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width);
    }
  }
  await mobile.getByLabel('设备名称').fill('手机新名称');
  await mobile.getByRole('button', { name: '保存设置' }).click();
  await expect(mobile.getByRole('status')).toContainText('设置已保存');
  await mobile.setViewportSize({ width: 375, height: 812 });
  await mobile.getByRole('button', { name: '文件传输', exact: true }).click();
  await mobile.screenshot({ path: 'test-results/mobile-transfer.png', fullPage: true });
  expect(errors).toEqual([]);
});
test('断开历史保存，中转站与客户端可独立关闭，目录路径可见', async () => {
  await mobile.getByRole('button', { name: '断开中转站', exact: true }).click();
  await desktop.getByRole('button', { name: '连接设备', exact: true }).click();
  await expect(desktop.locator('.device-record').filter({ hasText: '手机新名称' })).toContainText(
    '已断开',
  );
  await expect(desktop.locator('.timeline')).toContainText('断开');
  await desktop.getByRole('button', { name: '本机中转站', exact: true }).click();
  await desktop.getByRole('button', { name: '关闭中转站', exact: true }).click();
  await desktop.locator('dialog').getByRole('button', { name: '关闭中转站', exact: true }).click();
  await expect(desktop.locator('dialog')).toHaveCount(0);
  await expect(desktop.getByRole('heading', { name: '开启这台电脑的中转站' })).toBeVisible();
  await desktop.getByRole('button', { name: '设置', exact: true }).click();
  await desktop.getByRole('spinbutton', { name: '完成后保留时间（小时）' }).fill('2');
  await desktop.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(desktop.getByRole('status')).toContainText('设置已保存');
  await desktop.getByRole('button', { name: '本机存储', exact: true }).click();
  await desktop.getByText('存储位置与数据库整理', { exact: true }).click();
  await expect(desktop.locator('.paths')).toContainText(path.join(dir, 'relay3.sqlite'));
  await expect(desktop.locator('.storage-location-card')).toHaveCount(3);
  const status = await admin('/status');
  for (const [title, fullPath] of [
    ['中转文件位置', status.settings.cacheDir],
    ['SQLite 数据库位置', status.databasePath],
    ['接收文件位置', status.settings.receiveDir],
  ]) {
    await desktop.getByRole('button', { name: `复制${title}`, exact: true }).click();
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(fullPath);
  }
  await desktop.screenshot({ path: 'test-results/storage-location-cards.png' });

  expect(errors).toEqual([]);
});

test('本机中转站与远端客户端角色同时运行，远端收发记录在本机保存', async () => {
  const { RelayService } = await import('../dist-electron/index.js');
  const remote = new RelayService(path.join(dir, 'remote-station'), path.resolve('dist'));
  remote.store.settings.port = 0;
  await remote.startHub();
  const remoteBase = `http://127.0.0.1:${remote.hub.server.address().port}`;
  const remotePage = await context.newPage();
  try {
    await admin('/station/start', {});
    await desktop.getByRole('button', { name: '连接中转站', exact: true }).click();
    await desktop
      .getByLabel('中转站地址或配对链接')
      .fill(`${remoteBase}/#pair=${remote.pairingToken}`);
    await desktop.locator('dialog').getByRole('button', { name: '连接', exact: true }).click();
    await expect(desktop.locator('main')).toHaveAttribute('data-connected', 'true');
    expect((await admin('/status')).running).toBeTruthy();
    await remotePage.goto(`${remoteBase}/#pair=${remote.pairingToken}`);
    await remotePage.getByRole('button', { name: '连接中转站', exact: true }).click();
    await remotePage.getByLabel('设备名称').fill('远端手机');
    await remotePage.locator('dialog').getByRole('button', { name: '连接', exact: true }).click();
    await expect(remotePage.locator('main')).toHaveAttribute('data-connected', 'true');
    await remotePage.getByRole('button', { name: '接收设备', exact: true }).click();
    await remotePage.locator(`[role="option"][data-device-id="${boot.deviceId}"]`).click();
    const data = Buffer.from('跨中转站客户端记录');
    await remotePage
      .getByLabel('选择待发送文件')
      .setInputFiles({ name: '跨站文件.txt', mimeType: 'text/plain', buffer: data });
    await remotePage.getByRole('button', { name: '发送', exact: true }).click();
    await desktop.getByRole('button', { name: '文件传输', exact: true }).click();
    const row = desktop.locator('.transfer-row').filter({ hasText: '跨站文件.txt' });
    await row.getByRole('button', { name: '接收', exact: true }).click();
    await row.getByRole('button', { name: '下载文件', exact: true }).click();
    await expect(row).toHaveCount(0);
    expect(readFileSync(path.join(dir, 'received', '跨站文件.txt'))).toEqual(data);
    await desktop.getByRole('button', { name: '收发记录', exact: true }).click();
    await expect(desktop.locator('.record-row')).toHaveCount(3);
    await expect(desktop.locator('.record-row').first()).toContainText('跨站文件.txt');
    expect((await admin('/status')).running).toBeTruthy();
    await desktop.getByRole('button', { name: '本机存储', exact: true }).click();
    await expect(desktop.locator('.received-row')).toHaveCount(2);
    await desktop
      .locator('.received-row')
      .filter({ hasText: '跨站文件.txt' })
      .locator('input')
      .check();
    await desktop.getByRole('button', { name: '删除所选文件' }).click();
    await desktop.locator('dialog').getByRole('button', { name: '确认清理' }).click();
    await expect(desktop.locator('.received-row')).toHaveCount(1);
    expect(existsSync(path.join(dir, 'received', '跨站文件.txt'))).toBeFalsy();
    await desktop.getByRole('button', { name: '收发记录', exact: true }).click();
    await expect(desktop.locator('.record-row')).toHaveCount(3);
    expect(errors).toEqual([]);
  } finally {
    await remotePage.close();
    await remote.close();
  }
});

test('原生复制、各终端更换身份、按设备删除与离线清理选项', async () => {
  await desktop.getByRole('button', { name: '本机中转站', exact: true }).click();
  await desktop.getByRole('button', { name: '复制配对链接', exact: true }).click();
  await expect(desktop.getByRole('status')).toContainText('已复制');
  const clipboard = await app.evaluate(({ clipboard }) => clipboard.readText());
  expect(clipboard).toContain('/#pair=');
  const before = await admin('/status');
  await desktop.getByRole('button', { name: '生成新码', exact: true }).click();
  const after = await admin('/status');
  expect(after.pairingCode).not.toEqual(before.pairingCode);
  await mobile.getByRole('button', { name: '设置', exact: true }).click();
  const oldMobileId = await mobile.evaluate(() => localStorage.getItem('relay3-device-id'));
  await mobile.getByRole('button', { name: '更换设备身份', exact: true }).click();
  await mobile.getByRole('button', { name: '确认更换', exact: true }).click();
  await expect(mobile.getByRole('status')).toContainText('设备身份已更换');
  expect(await mobile.evaluate(() => localStorage.getItem('relay3-device-id'))).not.toEqual(
    oldMobileId,
  );
  await mobile.reload();
  await mobile.getByRole('button', { name: '连接中转站', exact: true }).click();
  await mobile.getByLabel('设备名称').fill('新身份手机');
  await mobile.getByLabel('配对码', { exact: true }).fill(after.pairingCode);
  await mobile.locator('dialog').getByRole('button', { name: '连接', exact: true }).click();
  await expect(mobile.locator('main')).toHaveAttribute('data-connected', 'true');
  await desktop.getByRole('button', { name: '连接设备', exact: true }).click();
  const row = desktop.locator('.device-record').filter({ hasText: '新身份手机' });
  await expect(row).toContainText('已连接');
  await row.getByRole('button', { name: '清除', exact: true }).click();
  await desktop.getByRole('button', { name: '确认清理', exact: true }).click();
  await expect(row).toHaveCount(0);
  await expect(mobile.locator('main')).not.toHaveAttribute('data-connected', 'true');
  await desktop.getByRole('button', { name: '清理离线历史', exact: true }).click();
  const select = desktop.getByLabel('最近连接时间早于');
  expect(await select.locator('option').allTextContents()).toEqual([
    '1 小时前',
    '24 小时前',
    '7 天前',
    '30 天前',
  ]);
  await select.selectOption('1');
  await desktop.getByRole('button', { name: '确认清理', exact: true }).click();
  await expect(desktop.getByRole('status')).toContainText('已清理');
  await desktop.getByRole('button', { name: '设置', exact: true }).click();
  const oldId = (await desktop.evaluate(() => window.relay3!.bootstrap())).deviceId;
  await desktop.getByRole('button', { name: '复制设备标识符' }).click();
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(oldId);
  await desktop.getByRole('button', { name: '更换设备身份', exact: true }).click();
  await desktop.getByRole('button', { name: '确认更换', exact: true }).click();
  await expect(desktop.getByRole('status')).toContainText('设备身份已更换');
  expect((await desktop.evaluate(() => window.relay3!.bootstrap())).deviceId).not.toEqual(oldId);
  expect((await admin('/records')).total).toEqual(3);
  expect(errors).toEqual([]);
});

test('各页面采用紧凑工作台布局，常用窗口尺寸下无整页滚动', async () => {
  await desktop.getByRole('button', { name: '本机中转站', exact: true }).click();
  await desktop.getByRole('button', { name: '本机加入', exact: true }).click();
  await expect(desktop.locator('main')).toHaveAttribute('data-connected', 'true');
  const dismiss = desktop.getByRole('button', { name: '关闭提示', exact: true });
  if (await dismiss.isVisible()) await dismiss.click();
  const pages = ['文件传输', '群聊大厅', '本机中转站', '连接设备', '收发记录', '本机存储', '设置'];
  for (const size of [
    { width: 1220, height: 840 },
    { width: 1080, height: 720 },
  ]) {
    await desktop.setViewportSize(size);
    for (const [index, name] of pages.entries()) {
      await desktop.getByRole('button', { name, exact: true }).click();
      await expect(desktop.locator('.topbar')).toHaveCount(0);
      const dimensions = await desktop.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
      }));
      expect(dimensions.scrollWidth, name).toBeLessThanOrEqual(dimensions.width);
      expect(dimensions.scrollHeight, name).toBeLessThanOrEqual(dimensions.height + 1);
      if (size.width === 1220)
        await desktop.screenshot({ path: `test-results/native-page-${index}.png` });
    }
  }
  await desktop.getByRole('button', { name: '本机存储', exact: true }).click();
  await desktop.getByText('存储位置与数据库整理', { exact: true }).click();
  await expect(desktop.locator('.paths')).toContainText(path.join(dir, 'relay3.sqlite'));
  expect(await desktop.title()).toBe('Relay3');
  expect(errors).toEqual([]);
});

test('独立中转站名称、历史实时探测、侧栏用户与系统关于入口', async () => {
  await desktop.setViewportSize({ width: 1220, height: 840 });
  await desktop.getByRole('button', { name: '设置', exact: true }).click();
  const device = (await desktop.evaluate(() => window.relay3!.bootstrap())).deviceName;
  await desktop.getByLabel('中转站名称', { exact: true }).fill('客厅中转站');
  await desktop.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(desktop.getByRole('status')).toContainText('设置已保存');
  expect((await admin('/status')).settings.stationName).toBe('客厅中转站');
  expect((await admin('/status')).settings.deviceName).toBe(device);
  await expect(desktop.locator('.sidebar > .device-self')).toContainText(device);
  await expect(desktop.locator('.brand')).toHaveCount(0);
  await app.evaluate(({ app, shell }) => {
    (globalThis as any).aboutCalls = 0;
    (globalThis as any).githubUrl = '';
    app.showAboutPanel = () => {
      (globalThis as any).aboutCalls++;
    };
    shell.openExternal = async (url) => {
      (globalThis as any).githubUrl = url;
    };
  });
  await desktop.getByRole('button', { name: '关于 Relay3', exact: true }).click();
  await expect.poll(() => app.evaluate(() => (globalThis as any).aboutCalls)).toBe(1);
  await desktop.getByRole('button', { name: '项目 GitHub', exact: true }).click();
  await expect
    .poll(() => app.evaluate(() => (globalThis as any).githubUrl))
    .toBe('https://github.com/nekomorph-woo/relay3');
  await desktop.getByRole('button', { name: '本机中转站', exact: true }).click();
  await expect(desktop.locator('.station-name')).toHaveText('客厅中转站');
  await expect(desktop.getByLabel('选择局域网地址').locator('option').first()).toContainText(
    '客厅中转站',
  );
  await desktop.getByRole('button', { name: '断开中转站', exact: true }).click();
  await desktop.getByRole('button', { name: '连接中转站', exact: true }).click();
  const station = desktop.locator('.remembered-station').first();
  await expect(station).toContainText('客厅中转站');
  await expect(station).toContainText('可连接 · 0 台在线');
  const dismiss = desktop.getByRole('button', { name: '关闭提示', exact: true });
  await expect(dismiss).toHaveCount(0);
  await desktop.screenshot({ path: 'test-results/v035-station-probe.png' });
  // 同地址变成另一台站点时不能使用旧凭证自动重连。
  await desktop.route('**/api/info', (route) =>
    route.fulfill({
      json: {
        name: '另一台中转站',
        stationId: 'different-station',
        running: true,
        onlineDevices: 2,
      },
    }),
  );
  await desktop.getByRole('button', { name: '重新探测中转站' }).click();
  await expect(station).toContainText('地址已更换中转站');
  await expect(station).toBeDisabled();
  await desktop.unroute('**/api/info');
  await desktop.getByRole('button', { name: '关闭', exact: true }).click();
  await desktop.getByRole('button', { name: '关闭中转站', exact: true }).click();
  await desktop.locator('dialog').getByRole('button', { name: '关闭中转站', exact: true }).click();
  await desktop.getByRole('button', { name: '连接中转站', exact: true }).click();
  await expect(station).toContainText('未响应');
  await desktop.getByRole('button', { name: '关闭', exact: true }).click();
  await desktop.getByRole('button', { name: '设置', exact: true }).click();
  await desktop.screenshot({ path: 'test-results/v035-settings.png' });
  expect(errors).toEqual([]);
});

test('四类平台标签覆盖设备与群聊，清除设备后历史消息仍有标记', async () => {
  await desktop.getByRole('button', { name: '本机中转站', exact: true }).click();
  await desktop.getByRole('button', { name: '开启中转站', exact: true }).click();
  await desktop.getByRole('button', { name: '本机加入', exact: true }).click();
  await expect(desktop.locator('main')).toHaveAttribute('data-connected', 'true');
  const peers = await desktop.evaluate(async () => {
    const boot = await window.relay3!.bootstrap();
    const status = await (
      await fetch(boot.controlUrl + '/admin/status', {
        headers: { Authorization: 'Bearer ' + boot.adminToken },
      })
    ).json();
    const base = 'http://127.0.0.1:' + status.settings.port;
    const peers = [];
    for (const platform of ['PC', 'Android', 'iPhone']) {
      const state = await (
        await fetch(base + '/api/join', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: crypto.randomUUID(),
            name: platform + '测试终端',
            platform,
            pairingToken: status.pairingToken,
          }),
        })
      ).json();
      const socket = new WebSocket(base.replace('http', 'ws') + '/api/ws?token=' + state.token);
      await new Promise<void>((resolve) =>
        socket.addEventListener('open', () => resolve(), { once: true }),
      );
      ((window as any).platformSockets ??= []).push(socket);
      await fetch(base + '/api/chat/messages', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + state.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: crypto.randomUUID(),
          mode: 'plain',
          content: platform + '平台消息',
        }),
      });
      peers.push(state);
    }
    return peers;
  });
  await desktop.getByRole('button', { name: '连接设备', exact: true }).click();
  for (const [name, title, icon] of [
    ['PC', 'PC', 'monitor'],
    ['Android', '安卓手机', 'smartphone'],
    ['iPhone', 'iOS手机', 'apple'],
  ]) {
    const row = desktop.locator('.device-record').filter({ hasText: name + '测试终端' });
    await expect(row.locator('.device-platform-tag')).toHaveAttribute('title', title);
    await expect(row.locator('svg.lucide-' + icon)).toBeVisible();
  }
  await expect(desktop.locator('.device-self .device-platform-tag')).toHaveAttribute(
    'title',
    'Mac',
  );
  await expect(desktop.locator('.device-self svg.lucide-airplay')).toBeVisible();
  await desktop.screenshot({ path: 'test-results/v035-platform-devices.png' });
  await desktop.getByRole('button', { name: '文件传输', exact: true }).click();
  await desktop.getByRole('button', { name: '接收设备', exact: true }).press('ArrowDown');
  await expect(desktop.getByRole('listbox')).toBeVisible();
  await expect(
    desktop
      .getByRole('option')
      .filter({ hasText: 'Android测试终端' })
      .locator('.device-platform-tag'),
  ).toHaveAttribute('title', '安卓手机');
  await desktop.getByRole('option').filter({ hasText: 'Android测试终端' }).click();
  await expect(desktop.locator('.device-select-trigger .device-platform-tag')).toHaveAttribute(
    'title',
    '安卓手机',
  );
  await desktop.getByRole('button', { name: '群聊大厅', exact: true }).click();
  for (const [name, title] of [
    ['PC', 'PC'],
    ['Android', '安卓手机'],
    ['iPhone', 'iOS手机'],
  ]) {
    await expect(
      desktop
        .locator('.bbs-message')
        .filter({ hasText: name + '平台消息' })
        .locator('header .device-platform-tag'),
    ).toHaveAttribute('title', title);
  }
  await desktop.screenshot({ path: 'test-results/v035-platform-chat.png' });
  await admin('/device/delete', { id: peers[0].self.id });
  await expect(
    desktop
      .locator('.bbs-message')
      .filter({ hasText: 'PC平台消息' })
      .locator('header .device-platform-tag'),
  ).toHaveAttribute('title', 'PC');
  expect(errors).toEqual([]);
});
