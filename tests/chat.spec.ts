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
async function enter(page: Page) {
  const tab = page.getByRole('button', { name: '群聊大厅', exact: true });
  if ((await tab.getAttribute('aria-current')) !== 'page') await tab.click();
}
async function chat(page: Page, route: string, body?: unknown) {
  return page.evaluate(
    async ({ route, body }) => {
      const session = JSON.parse(localStorage.getItem('relay3-session')!);
      const r = await fetch(session.base + '/api/chat' + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: 'Bearer ' + session.token, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data = await r.json();
      if (!r.ok) throw Error(data.error);
      return data;
    },
    { route, body },
  );
}
test('群聊原文展示、端侧密文、离线授权与手机布局', async () => {
  await desktop.getByRole('button', { name: '开启本机中转站' }).click();
  await desktop.getByRole('button', { name: '本机加入' }).click();
  await expect(desktop.locator('.connection-label')).toContainText('已连接');
  const status = await admin('/status');
  base = `http://127.0.0.1:${status.settings.port}`;
  await mobile.goto(`${base}/#pair=${status.pairingCode}`);
  await mobile.getByRole('button', { name: '连接设备', exact: true }).click();
  await mobile.getByLabel('设备名称').fill('授权手机');
  await mobile.locator('dialog').getByRole('button', { name: '连接', exact: true }).click();
  await expect(mobile.locator('.connection-label')).toContainText('已连接');
  await enter(desktop);
  await enter(mobile);
  await expect
    .poll(async () => (await chat(desktop, '/info')).devices.filter((d: any) => d.publicKey).length)
    .toBe(2);
  const raw = '<script>window.bad=1</script>\n# 原样 Markdown\n' + '长文本'.repeat(120);
  await desktop.getByLabel('文字消息', { exact: true }).fill(raw);
  await desktop.getByRole('button', { name: '发送文字', exact: true }).click();
  await expect(mobile.locator('.chat-feed pre')).toHaveText(raw);
  expect(await mobile.evaluate(() => (window as any).bad)).toBeUndefined();
  await mobile.getByRole('button', { name: '断开', exact: true }).click();
  await desktop.getByRole('button', { name: '刷新设备信息' }).click();
  await expect(desktop.locator('.chat-device-group').last()).toContainText('授权手机');
  await desktop.getByRole('button', { name: '发送密文', exact: true }).click();
  await desktop
    .locator('.chat-recipients label')
    .filter({ hasText: '授权手机' })
    .locator('input')
    .check();
  await desktop.getByLabel('公开备注', { exact: true }).fill('公开线索：下次上线阅读');
  await desktop
    .getByRole('dialog', { name: '发送密文', exact: true })
    .getByLabel('文字消息', { exact: true })
    .fill('离线设备的秘密消息');
  await desktop.getByRole('button', { name: '发送密文消息', exact: true }).click();
  await expect(desktop.locator('.chat-feed').getByLabel('已解密')).toBeVisible();
  await mobile.getByRole('button', { name: '连接', exact: true }).click();
  await mobile.getByLabel('配对码', { exact: true }).fill((await admin('/status')).pairingCode);
  await mobile.locator('dialog').getByRole('button', { name: '连接', exact: true }).click();
  await expect(mobile.locator('.connection-label')).toContainText('已连接');
  await enter(mobile);
  await expect(mobile.getByRole('dialog', { name: '密文消息汇总' })).toBeVisible();
  await expect(mobile.locator('.chat-modal-content')).toContainText('离线设备的秘密消息');
  await mobile.getByRole('button', { name: '关闭密文汇总' }).click();
  await expect(mobile.locator('.chat-feed')).toContainText('离线设备的秘密消息');
  await expect(mobile.getByRole('button', { name: /跳转上次未读/ })).toBeEnabled();
  await mobile.getByRole('button', { name: /跳转上次未读/ }).click();
  await expect(mobile.locator('.chat-feed .bbs-message').first()).toContainText(
    '离线设备的秘密消息',
  );
  for (const width of [320, 375, 414, 768]) {
    await mobile.setViewportSize({ width, height: 900 });
    await mobile.getByRole('button', { name: '发送密文', exact: true }).click();
    const composeDialog = mobile.getByRole('dialog', { name: '发送密文', exact: true });
    expect((await composeDialog.boundingBox())!.width).toBeLessThanOrEqual(width);
    await composeDialog.getByLabel('文字消息', { exact: true }).fill('密文草稿');
    await mobile.getByRole('button', { name: '关闭密文输入', exact: true }).click();
    expect(await mobile.getByLabel('文字消息', { exact: true }).inputValue()).toBe('');
    expect(await mobile.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    expect((await mobile.locator('.chat-feed').boundingBox())!.width).toBeGreaterThan(250);
    const sendBox = (await mobile
      .getByRole('button', { name: '发送文字', exact: true })
      .boundingBox())!;
    expect(sendBox.y + sendBox.height).toBeLessThanOrEqual(width <= 600 ? 900 - 72 : 900);
  }
  await mobile.setViewportSize({ width: 375, height: 812 });
  await mobile.screenshot({ path: 'test-results/mobile-chat.png', fullPage: true });
  await desktop.screenshot({ path: 'test-results/desktop-chat.png', fullPage: true });
  await mobile.getByRole('button', { name: '发送密文', exact: true }).click();
  await mobile.screenshot({ path: 'test-results/mobile-chat-encrypted.png', fullPage: true });
  await mobile.getByRole('button', { name: '关闭密文输入' }).click();
  expect(await app.evaluate(({ Menu }) => Menu.getApplicationMenu())).toBeNull();
  const k1 = await desktop.evaluate(() => window.relay3!.chatIdentity());
  expect(await desktop.evaluate(() => window.relay3!.chatIdentity())).toEqual(k1);
  expect(errors).toEqual([]);
});
test('未授权展示、密文汇总分页、组合清理与复制', async () => {
  const otherContext = await browser.newContext();
  const other = await otherContext.newPage();
  try {
    const status = await admin('/status');
    await other.goto(`${base}/#pair=${status.pairingCode}`);
    await other.getByRole('button', { name: '连接设备', exact: true }).click();
    await other.getByLabel('设备名称').fill('未授权设备');
    await other.locator('dialog').getByRole('button', { name: '连接', exact: true }).click();
    await enter(other);
    await expect(other.getByRole('dialog', { name: '密文消息汇总' })).toBeVisible();
    await expect(other.locator('.chat-modal-content').getByLabel('密文锁定')).toBeVisible();
    await expect(other.locator('.chat-modal-content')).not.toContainText('离线设备的秘密消息');
    await expect(other.locator('.chat-modal-content')).toContainText('公开线索：下次上线阅读');
    await other.getByRole('button', { name: '关闭密文汇总' }).click();
    const { encryptMessage } = await import('../dist-electron/chatCrypto.js');
    const key = await desktop.evaluate(() => window.relay3!.chatIdentity());
    const session = await desktop.evaluate(() =>
      JSON.parse(localStorage.getItem('relay3-session')!),
    );
    for (let i = 0; i < 21; i++) {
      const clientId = crypto.randomUUID();
      const remark = '批量备注';
      const remarkStyle = 'note';
      const envelope = encryptMessage(
        `分页秘密 ${i}`,
        [{ id: session.id, publicKey: key.publicKey }],
        { stationId: session.stationId, senderId: session.id, remark, remarkStyle },
        clientId,
      );
      await chat(desktop, '/messages', {
        clientId,
        mode: 'encrypted',
        remark,
        remarkStyle,
        envelope,
      });
    }
    await desktop.getByRole('button', { name: '密文消息', exact: true }).click();
    await expect(desktop.locator('.chat-modal-content .bbs-message')).toHaveCount(20);
    const cursor = (await chat(desktop, '/info')).cursor;
    await desktop.locator('dialog').getByRole('button', { name: '下一页', exact: true }).click();
    await expect(desktop.locator('.chat-modal-content .bbs-message')).toHaveCount(2);
    expect((await chat(desktop, '/info')).cursor).toBe(cursor);
    await desktop
      .locator('.chat-modal-content')
      .getByRole('button', { name: '复制消息内容' })
      .last()
      .click();
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
      .toContain('分页秘密');
    await desktop.getByRole('button', { name: '关闭密文汇总' }).click();
    await desktop.getByRole('button', { name: '清理大厅历史', exact: true }).click();
    await desktop.getByLabel('发送时间早于').selectOption('all');
    await desktop.getByLabel('消息模式', { exact: true }).selectOption('encrypted');
    await expect(desktop.locator('.chat-clean-row')).toHaveCount(20);
    await desktop.locator('.chat-clean-row').first().locator('input').check();
    await desktop.getByRole('button', { name: '预览清理', exact: true }).click();
    await expect(desktop.locator('.chat-clean-preview')).toContainText('1 条');
    await desktop.getByRole('button', { name: '确认永久清理', exact: true }).click();
    await expect(desktop.getByRole('dialog')).toHaveCount(0);
    expect((await chat(desktop, '/messages?mode=encrypted')).total).toBe(21);
    expect((await chat(desktop, '/messages?mode=plain')).total).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    await otherContext.close();
  }
});
