import {
  test,
  expect,
  _electron,
  chromium,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
let app: ElectronApplication, page: Page, dir: string;
const errors: string[] = [];
async function admin(route: string, body?: unknown) {
  return page.evaluate(
    async ({ route, body }) => {
      const boot = await window.relay3!.bootstrap();
      const response = await fetch(boot.controlUrl + '/admin' + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${boot.adminToken}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    },
    { route, body },
  );
}
const tab = (name: string) => page.getByRole('button', { name, exact: true }).click();
const top = (selector: string) => page.locator(selector).evaluate((e) => e.scrollTop);
async function scroll(selector: string, amount = 360) {
  const node = page.locator(selector);
  await expect
    .poll(() => node.evaluate((e) => e.scrollHeight - e.clientHeight))
    .toBeGreaterThan(amount);
  await node.evaluate((e, n) => {
    e.scrollTop = n;
  }, amount);
  await expect.poll(() => top(selector)).toBeCloseTo(amount, 0);
}
async function fixedWhileScrolling(selector: string, controls: string) {
  const before = await page.locator(controls).boundingBox();
  await scroll(selector);
  const after = await page.locator(controls).boundingBox();
  expect(after!.y).toBeCloseTo(before!.y, 0);
  expect(after!.y + after!.height).toBeLessThanOrEqual(await page.evaluate(() => innerHeight));
}
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'relay3-scroll-'));
  const { Store } = await import('../dist-electron/index.js');
  const store = new Store(dir, path.join(dir, 'received'));
  store.saveSettings({ ...store.settings, port: 0 });
  mkdirSync(path.join(store.settings.cacheDir, 'ready'), { recursive: true });
  mkdirSync(store.settings.receiveDir, { recursive: true });
  const now = Date.now();
  for (let i = 0; i < 70; i++) {
    const id = `scroll-${i}`;
    const filename = `完整文件名-${String(i).padStart(2, '0')}-长文件名用于检查列表可读性.txt`;
    const device = {
      id,
      name: `设备 ${i}`,
      platform: 'win32',
      firstSeen: now - i * 1000,
      lastSeen: now - i * 1000,
      disconnectedAt: now,
      ip: '192.168.1.10',
    };
    store.saveDevice(device, id);
    store.disconnect(store.connection(device));
    store.saveTransfer({
      id,
      stationId: store.settings.stationId,
      stationName: '滚动验收站',
      name: filename,
      size: 4,
      senderId: store.settings.deviceId,
      senderName: 'Mac',
      recipientId: id,
      recipientName: device.name,
      status: i < 30 ? 'ready' : 'completed',
      createdAt: now - i * 1000,
      startedAt: now - i * 1000,
      completedAt: now,
      duration: 1000,
      uploaded: 4,
      downloaded: 4,
      sha256: null,
      expiresAt: null,
      cleanedAt: null,
      error: null,
    });
    writeFileSync(path.join(store.settings.cacheDir, 'ready', id), 'test');
    const filePath = path.join(store.settings.receiveDir, filename);
    writeFileSync(filePath, 'test');
    store.saveReceived({
      id,
      name: filename,
      path: filePath,
      size: 4,
      receivedAt: now - i * 1000,
      stationId: i % 2 ? 'station-a' : 'station-b',
      stationName: i % 2 ? '站点 A' : '站点 B',
    });
    if (i < 30)
      store.saveClientSession({
        id: store.settings.deviceId,
        stationId: id,
        stationName: `历史中转站 ${i}`,
        base: `http://127.0.0.1:${50000 + i}`,
        token: id,
        autoConnect: false,
      });
  }
  store.db.close();
  app = await _electron.launch({
    args: ['.'],
    cwd: process.cwd(),
    env: { ...process.env, RELAY3_DATA_DIR: dir },
  });
  page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByRole('button', { name: '本机中转站', exact: true })).toBeVisible();
  await admin('/station/start', {});
  await tab('本机中转站');
  await page.getByRole('button', { name: '本机加入', exact: true }).click();
  await expect(page.locator('main')).toHaveAttribute('data-connected', 'true');
});
test.afterAll(async () => {
  await app?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('长列表固定操作，切页恢复位置，刷新与筛选定位正确', async () => {
  await page.setViewportSize({ width: 1404, height: 942 });
  await tab('连接设备');
  const deviceList = await page.locator('.device-list').boundingBox();
  const remove = await page.locator('.device-record-actions .button').first().boundingBox();
  expect(deviceList!.x + deviceList!.width - remove!.x - remove!.width).toBeGreaterThanOrEqual(12);
  await fixedWhileScrolling('.device-list', '.devices-layout > .panel:first-child .section-head');
  await scroll('.timeline', 420);
  await tab('设备');
  await tab('连接设备');
  await expect.poll(() => top('.device-list')).toBeCloseTo(360, 0);
  await expect.poll(() => top('.timeline')).toBeCloseTo(420, 0);
  await tab('收发记录');
  await fixedWhileScrolling('.records-panel', '.history-toolbar');
  await tab('设备');
  await tab('收发记录');
  await expect.poll(() => top('.records-panel')).toBeCloseTo(360, 0);
  await page.getByRole('button', { name: '我发送的', exact: true }).click();
  await expect.poll(() => top('.records-panel')).toBe(0);
  await scroll('.records-panel');
  await page.locator('.pagination').getByRole('button').last().click();
  await expect.poll(() => top('.records-panel')).toBe(0);
  await tab('中转缓存');
  await expect(page.locator('.storage-list[data-scroll-key^="cache:"] .cache-row')).toHaveCount(70);
  await fixedWhileScrolling(
    '.storage-list[data-scroll-key^="cache:"]',
    '.storage-files > .panel:first-child .section-head',
  );
  await tab('接收文件');
  await expect(page.locator('.cache-row:not(.received-row)')).toHaveCount(0);
  const row = page.locator('.received-row').first();
  const content = await row.locator('div').first().boundingBox();
  const badge = await row.locator('.badge').boundingBox();
  expect(badge!.x).toBeGreaterThan(content!.x + content!.width);
  const directory = page.getByRole('button', { name: '接收文件位置', exact: true });
  await expect(page.locator('.received-panel .section-head')).toContainText('接收文件位置');
  await expect(directory).toBeVisible();
  await row.locator('.received-path').hover();
  await expect(page.getByRole('tooltip')).toContainText('/received/');
  await page.mouse.move(400, 80);
  await scroll('.storage-list[data-scroll-key^="received:"]', 460);
  await tab('设备');
  await tab('中转缓存');
  await expect.poll(() => top('.storage-list[data-scroll-key^="cache:"]')).toBeCloseTo(360, 0);
  await tab('接收文件');
  await expect.poll(() => top('.storage-list[data-scroll-key^="received:"]')).toBeCloseTo(460, 0);
  await tab('中转缓存');
  const refresh = page.waitForResponse((r) => r.url().endsWith('/admin/cache'));
  await refresh;
  await expect.poll(() => top('.storage-list[data-scroll-key^="cache:"]')).toBeCloseTo(360, 0);
  await tab('接收文件');
  await page.getByLabel('按中转站筛选已接收文件').selectOption('station-a');
  await expect.poll(() => top('.storage-list[data-scroll-key^="received:"]')).toBe(0);
  await scroll('.storage-list[data-scroll-key^="received:"]');
  await page.screenshot({ path: 'test-results/scroll-storage.png' });
  await tab('连接的中转站');
  await scroll('.connected-stations');
  await tab('设备');
  await tab('连接的中转站');
  await expect.poll(() => top('.connected-stations')).toBeCloseTo(360, 0);
  expect(errors).toEqual([]);
});

test('小窗口发送与保存固定，路径弹窗正文滚动、Esc返回焦点', async () => {
  await page.setViewportSize({ width: 800, height: 600 });
  await tab('文件传输');
  await page.locator('input[type=file]').setInputFiles(
    Array.from({ length: 40 }, (_, i) => ({
      name: `待发送-${i}.txt`,
      mimeType: 'text/plain',
      buffer: Buffer.from('test'),
    })),
  );
  await fixedWhileScrolling('.selected-files', '.send-footer');
  await fixedWhileScrolling('.transfer-items', '.transfer-queue .section-head');
  await page.screenshot({ path: 'test-results/scroll-small-transfer.png' });
  await tab('设备');
  await page.getByText('诊断日志', { exact: true }).click();
  await fixedWhileScrolling('.settings-body', '.settings-actions');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('设置已保存');
  const toast = await page.locator('.notice').boundingBox();
  const save = await page.locator('.settings-actions .button').boundingBox();
  expect(
    toast!.x + toast!.width <= save!.x ||
      toast!.x >= save!.x + save!.width ||
      toast!.y >= save!.y + save!.height ||
      toast!.y + toast!.height <= save!.y,
  ).toBeTruthy();
  await page.screenshot({ path: 'test-results/scroll-small-settings.png' });
  await tab('中转缓存');
  const trigger = page.getByRole('button', { name: '缓存位置与数据库整理', exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: '缓存位置与数据库整理' });
  const header = await dialog.locator('.dialog-head').boundingBox();
  const overflow = await dialog
    .locator('.dialog-body')
    .evaluate((node) => node.scrollHeight - node.clientHeight);
  if (overflow > 1) await scroll('.dialog-body', Math.min(20, overflow - 1));
  expect((await dialog.locator('.dialog-head').boundingBox())!.y).toBeCloseTo(header!.y, 0);
  await dialog.getByRole('button', { name: '复制中转文件位置', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(errors).toEqual([]);
});

test('群聊历史不抢位置、密文分页回顶、清理长正文和下拉键盘可用', async () => {
  await page.setViewportSize({ width: 1404, height: 942 });
  async function chat(route: string, body?: unknown) {
    return page.evaluate(
      async ({ route, body }) => {
        const session = JSON.parse(localStorage.getItem('relay3-session')!);
        const r = await fetch(session.base + '/api/chat' + route, {
          method: body ? 'POST' : 'GET',
          headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        if (!r.ok) throw Error(await r.text());
        return r.json();
      },
      { route, body },
    );
  }
  await tab('群聊大厅');
  await expect(page.getByLabel('文字消息', { exact: true })).toBeVisible();
  const stationInfo = page.locator('.chat-info-desktop > .panel').first();
  const infoBefore = await stationInfo.boundingBox();
  await scroll('.chat-info-desktop .chat-devices-list', 280);
  expect((await stationInfo.boundingBox())!.y).toBeCloseTo(infoBefore!.y, 0);
  for (let i = 0; i < 65; i++)
    await chat('/messages', {
      clientId: crypto.randomUUID(),
      mode: 'plain',
      content: `消息-${i}\n${'长正文\n'.repeat(80)}`,
    });
  await expect(page.locator('.bbs-message').last()).toContainText('消息-64');
  await page.getByRole('button', { name: '更早消息', exact: true }).click();
  const feed = '.chat-feed';
  await expect(page.locator('.bbs-message').last()).toContainText('消息-14');
  await expect
    .poll(() => page.locator(feed).evaluate((e) => e.scrollHeight - e.clientHeight - e.scrollTop))
    .toBeLessThan(2);
  await scroll(feed, 600);
  await chat('/messages', {
    clientId: crypto.randomUUID(),
    mode: 'plain',
    content: '新的消息不抢历史',
  });
  await expect.poll(() => top(feed)).toBeCloseTo(600, 0);
  await tab('设备');
  await tab('群聊大厅');
  await expect.poll(() => top(feed)).toBeCloseTo(600, 0);
  await page.getByRole('button', { name: '回到最新', exact: true }).click();
  await expect(page.locator('.bbs-message').last()).toContainText('新的消息不抢历史');
  await page.route('**/admin/chat/catalog', (route) =>
    route.fulfill({
      json: {
        senders: Array.from({ length: 70 }, (_, i) => ({
          id: `scroll-${i}`,
          name: `历史发送设备 ${i}`,
          platform: 'win32',
        })),
      },
    }),
  );
  await page.getByRole('button', { name: '清理大厅历史', exact: true }).click();
  await page.getByLabel('发送时间早于').selectOption('all');
  const clean = page.getByRole('dialog', { name: '清理大厅历史' });
  await expect(clean.locator('.chat-clean-row')).toHaveCount(20);
  await clean.locator('details').first().locator('summary').click();
  const footer = await clean.locator('.chat-modal-footer').boundingBox();
  await clean.locator('.chat-modal-body').evaluate((e) => {
    e.scrollTop = 900;
  });
  expect((await clean.locator('.chat-modal-footer').boundingBox())!.y).toBeCloseTo(footer!.y, 0);
  expect(
    await clean
      .locator('pre')
      .first()
      .evaluate((e) => e.clientHeight),
  ).toBe(
    await clean
      .locator('pre')
      .first()
      .evaluate((e) => e.scrollHeight),
  );
  await clean.locator('.chat-modal-body').evaluate((e) => {
    e.scrollTop = 0;
  });
  await page.getByRole('button', { name: '发送设备', exact: true }).click();
  for (let i = 0; i < 25; i++) await page.keyboard.press('ArrowDown');
  const visibleOption = await page.evaluate(() => {
    const e = document.activeElement!,
      r = e.getBoundingClientRect(),
      p = e.parentElement!.getBoundingClientRect();
    return r.top >= p.top && r.bottom <= p.bottom && r.bottom <= innerHeight;
  });
  expect(visibleOption).toBe(true);
  await page.keyboard.press('Escape');
  await expect(clean).toBeVisible();
  await expect(page.getByRole('button', { name: '发送设备', exact: true })).toBeFocused();
  await page.screenshot({ path: 'test-results/scroll-cleanup.png' });
  await page.keyboard.press('Escape');
  await expect(clean).toHaveCount(0);
  const { encryptMessage } = await import('../dist-electron/chatCrypto.js');
  const key = await page.evaluate(() => window.relay3!.chatIdentity());
  const session = await page.evaluate(() => JSON.parse(localStorage.getItem('relay3-session')!));
  for (let i = 0; i < 22; i++) {
    const clientId = crypto.randomUUID();
    const remark = '滚动验收备注';
    const remarkStyle = 'note';
    const envelope = encryptMessage(
      `密文分页-${i}\n${'正文\n'.repeat(60)}`,
      [{ id: session.id, publicKey: key.publicKey }],
      { stationId: session.stationId, senderId: session.id, remark, remarkStyle },
      clientId,
    );
    await chat('/messages', { clientId, mode: 'encrypted', remark, remarkStyle, envelope });
  }
  await page.getByRole('button', { name: '密文消息', exact: true }).click();
  const cipher = page.getByRole('dialog', { name: '密文消息汇总' });
  await expect(cipher.locator('.bbs-message')).toHaveCount(20);
  await fixedWhileScrolling('.chat-modal-content.chat-modal-body', '.chat-modal-footer');
  await cipher.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(cipher.locator('.bbs-message')).toHaveCount(2);
  await expect.poll(() => top('.chat-modal-content.chat-modal-body')).toBe(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '密文消息', exact: true })).toBeFocused();
  await page.setViewportSize({ width: 800, height: 600 });
  await page.getByRole('button', { name: '发送密文', exact: true }).click();
  await page.locator('.chat-remark-editor summary').click();
  const encrypted = page.getByRole('dialog', { name: '发送密文' });
  await expect(encrypted).toBeVisible();
  const send = await encrypted.locator('.chat-send-row').boundingBox();
  await encrypted.locator('.chat-compose-body').evaluate((e) => {
    e.scrollTop = e.scrollHeight;
  });
  expect((await encrypted.locator('.chat-send-row').boundingBox())!.y).toBeCloseTo(send!.y, 0);
  expect(send!.y + send!.height).toBeLessThanOrEqual(600);
  await page.screenshot({ path: 'test-results/scroll-small-encrypted.png' });
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('手机窄屏自然滚动，群聊与设置操作不会被裁切', async () => {
  const status = await admin('/status');
  const base = await page.evaluate(() => JSON.parse(localStorage.getItem('relay3-session')!).base);
  const browser = await chromium.launch({ args: ['--no-proxy-server'] });
  try {
    const mobile = await browser.newPage({
      viewport: { width: 375, height: 812 },
      isMobile: true,
      hasTouch: true,
    });
    mobile.on('pageerror', (e) => errors.push(e.message));
    await mobile.goto(`${base}/#pair=${status.pairingToken}`);
    await mobile.getByRole('button', { name: '连接中转站', exact: true }).click();
    await mobile.getByLabel('设备名称').fill('滚动测试手机');
    await mobile.getByRole('dialog').getByRole('button', { name: '连接', exact: true }).click();
    let firstChat = true;
    for (const size of [
      { width: 320, height: 640 },
      { width: 375, height: 812 },
      { width: 414, height: 896 },
      { width: 768, height: 1024 },
    ]) {
      await mobile.setViewportSize(size);
      for (const name of ['文件传输', '群聊大厅', '收发记录', '设置']) {
        await mobile.getByRole('button', { name, exact: true }).click();
        const popup = mobile.getByRole('button', { name: '关闭密文汇总', exact: true });
        if (name === '群聊大厅' && firstChat) {
          await expect(popup).toBeVisible();
          firstChat = false;
          await popup.click();
        } else if (await popup.isVisible()) await popup.click();
        expect(
          await mobile.evaluate(() => document.documentElement.scrollWidth),
        ).toBeLessThanOrEqual(size.width);
        if (name === '设置') {
          await mobile.getByLabel('设备名称').fill(`手机-${size.width}`);
          await mobile.getByRole('button', { name: '保存设置', exact: true }).click();
          await expect(mobile.getByRole('status')).toContainText('设置已保存');
        }
      }
    }
    await mobile.setViewportSize({ width: 320, height: 640 });
    await mobile.getByRole('button', { name: '群聊大厅', exact: true }).click();
    const popup = mobile.getByRole('button', { name: '关闭密文汇总', exact: true });
    if (await popup.isVisible()) await popup.click();
    await mobile.screenshot({ path: 'test-results/scroll-mobile-chat.png' });
    await mobile.getByRole('button', { name: '大厅信息', exact: true }).click();
    await expect(mobile.getByRole('dialog', { name: '大厅信息' })).toBeVisible();
    await mobile.getByRole('button', { name: '关闭大厅信息', exact: true }).click();
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

test('两个中转站的传输列表各自恢复位置，连接弹窗固定提交按钮', async () => {
  await page.setViewportSize({ width: 800, height: 600 });
  await tab('文件传输');
  const localId = await page.evaluate(
    () => JSON.parse(localStorage.getItem('relay3-session')!).stationId,
  );
  await scroll('.transfer-items', 360);
  const { RelayService } = await import('../dist-electron/index.js');
  const remote = new RelayService(path.join(dir, 'remote'), path.resolve('dist'));
  remote.store.saveSettings({ ...remote.store.settings, port: 0, stationName: '滚动远端站' });
  const status = await admin('/status');
  for (let i = 0; i < 35; i++)
    remote.store.saveTransfer({
      id: `remote-${i}`,
      stationId: remote.store.settings.stationId,
      name: `远端待接收-${i}.txt`,
      size: 10,
      senderId: status.settings.deviceId,
      senderName: '发送者',
      recipientId: 'other',
      recipientName: '接收者',
      status: 'ready',
      createdAt: Date.now(),
      startedAt: Date.now(),
      completedAt: null,
      duration: null,
      uploaded: 10,
      downloaded: 0,
      sha256: null,
      expiresAt: null,
      cleanedAt: null,
      error: null,
    });
  await remote.startHub();
  try {
    await page.locator('main').getByRole('button', { name: '连接其他中转站', exact: true }).click();
    await fixedWhileScrolling('.dialog-body', '.dialog-footer');
    await page
      .getByLabel('中转站地址或配对链接')
      .fill(`http://127.0.0.1:${remote.hub.server.address().port}/#pair=${remote.pairingToken}`);
    await page
      .getByRole('dialog', { name: '连接中转站' })
      .getByRole('button', { name: '连接', exact: true })
      .click();
    await expect(page.locator('.transfer-row')).toHaveCount(35);
    await expect.poll(() => top('.transfer-items')).toBe(0);
    await scroll('.transfer-items', 600);
    await page.getByRole('button', { name: '切换中转站' }).click();
    await page.locator(`[role="option"][data-station-id="${localId}"]`).click();
    await expect(page.locator('.transfer-row')).toHaveCount(30);
    await expect.poll(() => top('.transfer-items')).toBeCloseTo(360, 0);
    await page.getByRole('button', { name: '切换中转站' }).click();
    await page
      .locator(`[role="option"][data-station-id="${remote.store.settings.stationId}"]`)
      .click();
    await expect(page.locator('.transfer-row')).toHaveCount(35);
    await expect.poll(() => top('.transfer-items')).toBeCloseTo(600, 0);
  } finally {
    await remote.close();
  }
  expect(errors).toEqual([]);
});
