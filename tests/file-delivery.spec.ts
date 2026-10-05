import {
  test,
  expect,
  _electron,
  chromium,
  type ElectronApplication,
  type Browser,
  type Page,
} from '@playwright/test';
import { mkdtempSync, rmSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
let app: ElectronApplication,
  browser: Browser,
  desktop: Page,
  phone: Page,
  offline: Page,
  dir: string,
  boot: any,
  base: string;
const errors: string[] = [];
async function admin(route: string, body?: unknown) {
  return desktop.evaluate(
    async ({ route, body }) => {
      const boot = await window.relay3!.bootstrap();
      const res = await fetch(boot.controlUrl + '/admin' + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${boot.adminToken}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const r = await res.json();
      if (!res.ok) throw new Error(r.error);
      return r;
    },
    { route, body },
  );
}
async function join(page: Page, name: string) {
  const status = await admin('/status');
  await page.goto(base + '/#pair=' + status.pairingCode);
  await page.getByRole('button', { name: '连接中转站', exact: true }).click();
  await page.getByLabel('设备名称').fill(name);
  await page.locator('dialog').getByRole('button', { name: '连接', exact: true }).click();
  await expect(page.locator('main')).toHaveAttribute('data-connected', 'true');
}
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'relay3-delivery-ui-'));
  app = await _electron.launch({
    args: ['.'],
    cwd: process.cwd(),
    env: { ...process.env, RELAY3_DATA_DIR: dir },
  });
  desktop = await app.firstWindow();
  desktop.on('pageerror', (e) => errors.push(e.message));
  boot = await desktop.evaluate(() => window.relay3!.bootstrap());
  const server = net.createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((r) => server.close(() => r()));
  await admin('/settings', {
    port,
    receiveDir: path.join(dir, 'received'),
    stationName: '这是一个很长的中转站名字用于检查切换控件布局',
  });
  await desktop.getByRole('button', { name: '本机中转站', exact: true }).click();
  await desktop.getByRole('button', { name: '开启中转站', exact: true }).click();
  await desktop.getByRole('button', { name: '本机加入', exact: true }).click();
  await expect(desktop.locator('main')).toHaveAttribute('data-connected', 'true');
  const addressChoice = desktop.getByLabel('选择局域网地址');
  const stationAddress = desktop.locator('.pairing-address-text');
  await expect(stationAddress).toContainText('地址：' + (await addressChoice.inputValue()));
  expect(await addressChoice.evaluate((el) => getComputedStyle(el).fontSize)).toBe(
    await stationAddress.evaluate((el) => getComputedStyle(el).fontSize),
  );
  await expect(addressChoice.locator('option').first()).toHaveText(
    '这是一个很长的中转站名字用于检查切换控件布局',
  );
  await desktop.screenshot({ path: 'test-results/delivery-station-address.png' });
  base = `http://127.0.0.1:${port}`;
  browser = await chromium.launch({ args: ['--no-proxy-server'] });
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
    acceptDownloads: true,
  });
  phone = await context.newPage();
  phone.on('pageerror', (e) => errors.push(e.message));
  await join(phone, '在线手机');
  const offContext = await browser.newContext({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  });
  offline = await offContext.newPage();
  await join(offline, '离线电脑');
  await offline.close();
});
test.afterAll(async () => {
  await browser?.close();
  await app?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});
test('普通多目标离线发送、上传完成后独立接收、服务端任务和长站名', async () => {
  await desktop.getByRole('button', { name: '文件传输', exact: true }).click();
  await desktop.getByLabel('接收缓冲时间说明').hover();
  await expect(desktop.getByRole('tooltip')).toContainText('从文件完整上传到中转站开始计时');
  await desktop.mouse.move(500, 70);
  await expect(desktop.locator('.delivery-recipients')).toContainText('离线电脑');
  const devices = (await admin('/status')).devices;
  for (const name of ['在线手机', '离线电脑']) {
    const d = devices.find((d: any) => d.name === name);
    await desktop.locator(`.delivery-recipients [data-device-id="${d.id}"] input`).check();
  }
  await expect(desktop.locator('.buffer-presets button[aria-pressed="true"]')).toHaveText('24小时');
  await desktop
    .locator('.buffer-presets')
    .getByRole('button', { name: '1小时', exact: true })
    .click();
  await expect(desktop.getByLabel('接收缓冲分钟数')).toHaveValue('60');
  const selected = desktop.locator('.buffer-presets button[aria-pressed="true"]');
  await expect(selected).toHaveText('1小时');
  expect(await selected.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(
    await desktop
      .locator('.buffer-presets button[aria-pressed="false"]')
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor),
  );
  await desktop.getByLabel('接收缓冲分钟数').fill('10');
  await desktop.getByLabel('选择待发送文件').setInputFiles({
    name: '多目标.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('多目标共享缓存'),
  });
  await desktop.getByRole('button', { name: '发送', exact: true }).click();
  await expect(desktop.locator('.transfer-row')).toHaveCount(2);
  await expect.poll(async () => (await admin('/cache')).entries.length).toBe(1);
  const row = phone.locator('.transfer-row').filter({ hasText: '多目标.txt' });
  const event = phone.waitForEvent('download');
  await row.getByRole('button', { name: '接收', exact: true }).click();
  const download = await event;
  expect(await download.failure()).toBeNull();
  await expect(row.getByRole('button', { name: '确认收到' })).toBeVisible();
  await row.getByRole('button', { name: '确认收到' }).click();
  await expect
    .poll(
      async () =>
        (await admin('/records')).items.find((t: any) => t.recipientName === '在线手机').status,
    )
    .toBe('completed');
  await desktop.getByRole('button', { name: '本机中转站后台任务' }).click();
  await expect(desktop.locator('.background-task-popover')).toContainText('多目标.txt');
  await desktop.screenshot({ path: 'test-results/delivery-tasks.png' });
  await desktop.getByRole('button', { name: '关闭后台任务' }).click();
  await desktop.getByRole('button', { name: '切换中转站' }).click();
  await expect(desktop.getByRole('listbox', { name: '中转站列表' })).toContainText(
    '这是一个很长的中转站名字',
  );
  await desktop.getByRole('listbox', { name: '中转站列表' }).getByRole('option').click();
  await expect(desktop.locator('.station-switch-trigger strong')).toHaveCSS(
    'white-space',
    'nowrap',
  );
});
test('本机文件删除后可重新下载、下载时间更新与缓存清理不影响本机文件', async () => {
  await phone.getByRole('button', { name: '文件传输', exact: true }).click();
  await phone.locator(`.delivery-recipients [data-device-id="${boot.deviceId}"] input`).check();
  await phone.getByLabel('选择待发送文件').setInputFiles({
    name: '重新下载.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('重新下载验证'),
  });
  await phone.getByRole('button', { name: '发送', exact: true }).click();
  const row = desktop.locator('.transfer-row').filter({ hasText: '重新下载.txt' });
  await row.getByRole('button', { name: '接收', exact: true }).click();
  await expect.poll(async () => (await admin('/received')).entries.length).toBe(1);
  const first = (await admin('/received')).entries[0];
  expect(readFileSync(first.path).toString()).toBe('重新下载验证');
  unlinkSync(first.path);
  await desktop.getByRole('button', { name: '收发记录', exact: true }).click();
  const history = desktop.locator('.record-row').filter({ hasText: '重新下载.txt' });
  await expect(history).toContainText('可重新下载');
  await history.getByRole('button', { name: '重新下载', exact: true }).click();
  await expect
    .poll(async () => (await admin('/received')).entries[0].receivedAt)
    .toBeGreaterThan(first.receivedAt);
  await expect(history).toContainText('已下载过');
  await expect(history.getByRole('button', { name: '打开接收文件所在目录' })).toBeVisible();
  const record = (await admin('/records')).items.find((t: any) => t.name === '重新下载.txt');
  await admin('/cache/delete', { ids: [record.fileId] });
  await expect.poll(async () => (await admin('/received')).entries[0].exists).toBe(true);
});
test('群聊文件名加密、手机大厅接收、Emoji本地加载和输入留白', async () => {
  await desktop.getByRole('button', { name: '群聊大厅', exact: true }).click();
  await phone.getByRole('button', { name: '群聊大厅', exact: true }).click();
  for (const action of ['发送密文', '发送文件']) {
    const button = desktop
      .locator('.chat-compose-options')
      .getByRole('button', { name: action, exact: true });
    const iconBox = (await button.locator('svg').boundingBox())!;
    const textBox = (await button.locator('span').boundingBox())!;
    expect(Math.abs(iconBox.y + iconBox.height / 2 - textBox.y - textBox.height / 2)).toBeLessThan(
      1,
    );
  }
  await desktop
    .locator('.chat-compose-options')
    .screenshot({ path: 'test-results/delivery-composer-actions.png' });
  await desktop.getByRole('button', { name: '发送文件', exact: true }).click();
  const modal = desktop.getByRole('dialog', { name: '发送文件', exact: true });
  await modal.getByLabel('接收缓冲时间说明').hover();
  await expect(desktop.getByRole('tooltip')).toContainText('超时未处理后不能再操作');
  await desktop.mouse.move(500, 70);
  await modal.getByLabel('选择群聊文件').setInputFiles({
    name: '加密文件名.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('聊天文件'),
  });
  await modal
    .getByLabel('选择群聊文件')
    .evaluate((input) => input.dispatchEvent(new Event('cancel', { bubbles: true })));
  await expect(modal).toBeVisible();
  await expect(modal.locator('.chat-file-selection')).toContainText('加密文件名.txt');
  await modal.press('Escape');
  await expect(modal).toBeVisible();
  const searchBox = (await modal.getByLabel('搜索接收设备').boundingBox())!;
  const filterBox = (await modal.getByLabel('接收设备在线筛选').boundingBox())!;
  expect(searchBox.height).toBe(filterBox.height);
  expect(Math.abs(searchBox.y - filterBox.y)).toBeLessThan(1);
  const recipient = (await admin('/status')).devices.find((d: any) => d.name === '在线手机');
  await modal.locator(`[data-device-id="${recipient.id}"] input`).check();
  await modal.locator('summary').click();
  await modal.getByLabel('文件公开备注').fill('公开文件说明');
  await modal.getByRole('button', { name: '发送文件', exact: true }).click();
  await expect(modal).toHaveCount(0);
  const message = phone.locator('.bbs-message').filter({ hasText: '加密文件名.txt' });
  await expect(message).toContainText('公开文件说明');
  const event = phone.waitForEvent('download');
  await message.getByRole('button', { name: '接收', exact: true }).click();
  await event;
  await message.getByRole('button', { name: '确认收到' }).click();
  await expect(message).toContainText('已下载过');
  await desktop.getByLabel('文字消息').fill('你好 😀 <b>原文</b>');
  await desktop.getByRole('button', { name: '发送文字', exact: true }).click();
  await expect(
    phone.locator('.bbs-message').filter({ hasText: '你好' }).locator('.inline-emoji'),
  ).toHaveCount(1);
  await expect(phone.locator('.bbs-message').filter({ hasText: '你好' })).toContainText(
    '<b>原文</b>',
  );
  await desktop.getByRole('button', { name: '选择表情' }).click();
  await expect(desktop.locator('em-emoji-picker')).toBeVisible();
  await desktop.screenshot({ path: 'test-results/delivery-emoji.png' });
  await desktop.getByRole('button', { name: '关闭表情' }).click();
  await desktop.getByRole('button', { name: '发送密文', exact: true }).click();
  const textarea = desktop.getByRole('dialog', { name: '发送密文' }).getByLabel('文字消息');
  await expect(textarea).toHaveCSS('padding-left', '12px');
  await desktop.screenshot({ path: 'test-results/delivery-input.png' });
  await desktop.getByRole('button', { name: '关闭密文输入' }).click();
  expect(errors).toEqual([]);
});

test('大量设备可搜索筛选、分页保留选择且文件选择区紧凑', async () => {
  await desktop.evaluate(
    async ({ base }) => {
      const boot = await window.relay3!.bootstrap();
      const info = await (
        await fetch(boot.controlUrl + '/admin/status', {
          headers: { Authorization: `Bearer ${boot.adminToken}` },
        })
      ).json();
      for (let i = 1; i <= 10; i++)
        await fetch(base + '/api/join', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: crypto.randomUUID(),
            name: `历史设备${String(i).padStart(2, '0')}`,
            platform: 'PC',
            pairingToken: info.pairingToken,
          }),
        });
    },
    { base },
  );
  await desktop.reload();
  await expect(desktop.locator('main')).toHaveAttribute('data-connected', 'true');
  await desktop.getByRole('button', { name: '文件传输', exact: true }).click();
  await desktop.getByLabel('搜索接收设备').fill('历史设备');
  await expect(desktop.locator('.recipient-page [data-device-id]')).toHaveCount(4);
  const first = desktop.locator('.recipient-page input').first();
  await first.check();
  await desktop.getByRole('button', { name: '接收设备下一页' }).click();
  await desktop.locator('.recipient-page input').first().check();
  await expect(desktop.locator('.delivery-recipients legend')).toContainText('已选 2 台');
  await desktop.getByRole('button', { name: '接收设备上一页' }).click();
  await expect(desktop.locator('.recipient-page input').first()).toBeChecked();
  await desktop.getByLabel('接收设备在线筛选').selectOption('online');
  await expect(desktop.locator('.recipient-page')).toContainText('没有符合条件的设备');
  await desktop.getByLabel('接收设备在线筛选').selectOption('offline');
  await desktop.getByRole('button', { name: '全选筛选结果' }).click();
  await expect(desktop.locator('.delivery-recipients legend')).toContainText('已选 10 台');
  const box = await desktop.locator('.compact-file-picker').boundingBox();
  expect(box!.height).toBeLessThan(100);
  await desktop.screenshot({ path: 'test-results/delivery-many-devices.png' });
});

test('文件发送弹窗在窄屏保留固定提交区，多文件列表独立滚动', async () => {
  await phone.getByRole('button', { name: '群聊大厅', exact: true }).click();
  for (const width of [320, 375, 768]) {
    await phone.setViewportSize({ width, height: 700 });
    await phone.getByRole('button', { name: '发送文件', exact: true }).click();
    const modal = phone.getByRole('dialog', { name: '发送文件', exact: true });
    await modal.getByLabel('选择群聊文件').setInputFiles(
      Array.from({ length: 12 }, (_, i) => ({
        name: `较长的测试文件名称-${i}.txt`,
        mimeType: 'text/plain',
        buffer: Buffer.from('内容'),
      })),
    );
    const box = (await modal.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.y + box.height).toBeLessThanOrEqual(700);
    const send = (await modal
      .getByRole('button', { name: '发送文件', exact: true })
      .boundingBox())!;
    expect(send.y + send.height).toBeLessThanOrEqual(700);
    expect(
      await modal
        .locator('.compact-file-picker')
        .evaluate((el) => el.getBoundingClientRect().height),
    ).toBeLessThan(100);
    expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    if (width === 375) await phone.screenshot({ path: 'test-results/delivery-phone-composer.png' });
    await modal.getByRole('button', { name: '关闭文件发送' }).click();
  }
});

test('后台入口固定底部，运行数量和空闲图标随状态更新', async () => {
  await desktop.route('**/admin/tasks', async (route) =>
    route.fulfill({
      json: {
        tasks: Array.from({ length: 10 }, (_, i) => ({
          id: String(i),
          kind: 'upload',
          name: '测试任务',
          bytes: 0,
          total: 100,
          startedAt: Date.now(),
          state: 'running',
        })),
      },
    }),
  );
  const entry = desktop.getByRole('button', { name: '本机中转站后台任务' });
  await expect(entry).toHaveText('后台任务(10)');
  await expect(entry.locator('.task-spinning')).toHaveCount(1);
  const taskBox = (await entry.boundingBox())!;
  const footerBox = (await desktop.locator('.sidebar-bottom').boundingBox())!;
  expect(footerBox.y - taskBox.y - taskBox.height).toBeLessThan(20);
  await desktop.unroute('**/admin/tasks');
  await desktop.route('**/admin/tasks', async (route) => route.fulfill({ json: { tasks: [] } }));
  await expect(entry).toHaveText('后台任务');
  await expect(entry.locator('.lucide-list-todo')).toHaveCount(1);
  await expect(entry.locator('.task-spinning')).toHaveCount(0);
  await desktop.unroute('**/admin/tasks');
});
