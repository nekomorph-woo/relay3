import { setBrowserDeviceName } from './device-ui';
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
  await setBrowserDeviceName(page, name);
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
async function send(files: { name: string; content: string }[]) {
  await desktop.getByRole('button', { name: '文件传输', exact: true }).click();
  const d = (await admin('/status')).devices.find((d: any) => d.name === '在线手机');
  await desktop.locator(`.delivery-recipients [data-device-id="${d.id}"] input`).check();
  await desktop
    .getByLabel('选择待发送文件')
    .setInputFiles(
      files.map((f) => ({ name: f.name, mimeType: 'text/plain', buffer: Buffer.from(f.content) })),
    );
  await desktop.getByRole('button', { name: '发送', exact: true }).click();
  await expect(desktop.locator('.selected-files .file-line')).toHaveCount(0);
  const p = (await admin('/packages')).items[0];
  return { id: p.id, card: desktop.locator(`[data-package-id="${p.id}"]`) };
}
test('多文件成包、跨页部分下载与完整发送记录', async () => {
  const { id, card } = await send(
    Array.from({ length: 10 }, (_, i) => ({ name: `跨页文件${i}.txt`, content: `内容${i}` })),
  );
  await expect(card.locator('.package-summary strong')).toHaveText('跨页文件0.txt 等 10 个文件');
  await card.locator('.package-summary').click();
  await expect(card.locator('.package-file-row')).toHaveCount(8);
  await card.getByRole('button', { name: '文件下一页' }).click();
  await expect(card.locator('.package-file-row')).toHaveCount(2);
  const receiver = phone.locator(`[data-package-id="${id}"]`);
  await receiver.getByLabel('选择 跨页文件0.txt', { exact: true }).check();
  await receiver.getByRole('button', { name: '文件下一页' }).click();
  await receiver.getByLabel('选择 跨页文件9.txt', { exact: true }).check();
  const downloads: string[] = [];
  phone.on('download', (d) => downloads.push(d.suggestedFilename()));
  await receiver.getByRole('button', { name: '下载所选（2）', exact: true }).click();
  await expect.poll(() => downloads.length).toBe(2);
  await expect(receiver).toContainText('已开始下载 2 项');
  const record = await admin('/packages/' + id);
  expect(
    record.files.filter((f: any) => f.transfers[0].status === 'awaiting-confirm'),
  ).toHaveLength(2);
  expect(record.files.filter((f: any) => f.transfers[0].status === 'pending')).toHaveLength(8);
  await receiver.getByRole('button', { name: '确认收到' }).click();
  await receiver.getByRole('button', { name: '文件上一页' }).click();
  await receiver.getByRole('button', { name: '确认收到' }).click();
  await card.getByRole('button', { name: '接收设备 · 1' }).click();
  await card.locator('.package-recipient-detail summary').click();
  await expect(card.locator('.package-recipient-detail')).toContainText('已收到 2/10');
  await expect(card.locator('.package-recipient-file').first()).toContainText('已下载过');
  await desktop.screenshot({ path: 'test-results/package-recipient-details.png' });
  await phone.screenshot({ path: 'test-results/package-phone-partial.png' });
  await desktop.getByRole('button', { name: '收发记录', exact: true }).click();
  await expect(desktop.locator(`[data-package-id="${id}"]`)).toHaveCount(1);
});
test('失败文件独立重传或移除，完成前接收者无入口', async () => {
  let n = 0;
  await desktop.route('**/api/files/*/upload', async (r) => {
    n++;
    if (n === 2) await r.fulfill({ status: 409, json: { error: '模拟失败' } });
    else await r.continue();
  });
  const first = await send([
    { name: '成功.txt', content: '成功' },
    { name: '失败.txt', content: '失败' },
  ]);
  await expect(first.card).toContainText('尚未发送 · 已上传 1/2');
  await expect(phone.locator(`[data-package-id="${first.id}"]`)).toHaveCount(0);
  await first.card
    .getByLabel('重传 失败.txt', { exact: true })
    .setInputFiles({ name: '失败.txt', mimeType: 'text/plain', buffer: Buffer.from('失败') });
  await expect(first.card).toContainText('等待接收');
  await expect(phone.locator(`[data-package-id="${first.id}"]`)).toHaveCount(1);
  await desktop.unroute('**/api/files/*/upload');
  n = 0;
  await desktop.route('**/api/files/*/upload', async (r) => {
    n++;
    if (n === 2) await r.fulfill({ status: 409, json: { error: '模拟失败' } });
    else await r.continue();
  });
  const second = await send([
    { name: '保留.txt', content: '保留' },
    { name: '移除.txt', content: '失败' },
  ]);
  await second.card.getByRole('button', { name: '仅发送已上传文件' }).click();
  await expect(second.card.locator('.package-summary strong')).toHaveText('保留.txt');
  await expect(second.card).toContainText('发送前已移除 1');
  const p = await admin('/packages/' + second.id);
  expect(p.files).toHaveLength(1);
  expect(p.readyAt).toBe(p.files[0].uploadedAt);
  await desktop.unroute('**/api/files/*/upload');
  await desktop.screenshot({ path: 'test-results/package-recovered.png' });
});
test('提醒进入指定文件包；群聊无权限只展示通用入口，窄屏详情不越界', async () => {
  const { id, card } = await send([{ name: '提醒.txt', content: '提醒' }]);
  await phone.getByRole('button', { name: '群聊大厅', exact: true }).click();
  await card.locator('.package-summary').click();
  await card.getByRole('button', { name: '提醒未处理设备' }).click();
  await expect(phone.locator('.package-reminder')).toContainText('提醒你接收文件');
  await expect(phone.locator('.chat-hall')).toBeVisible();
  await phone.getByRole('button', { name: '查看文件', exact: true }).click();
  const detail = phone.getByRole('dialog', { name: '文件详情' });
  await expect(detail).toContainText('提醒.txt');
  await detail.press('Escape');
  await expect(detail).toBeVisible();
  await detail.getByRole('button', { name: '关闭文件详情' }).click();
  await desktop.getByRole('button', { name: '群聊大厅', exact: true }).click();
  await desktop.getByRole('button', { name: '发送文件', exact: true }).click();
  const modal = desktop.getByRole('dialog', { name: '发送文件', exact: true });
  await modal.getByLabel('选择群聊文件').setInputFiles([
    { name: '只有授权者知道.txt', mimeType: 'text/plain', buffer: Buffer.from('私密') },
    { name: '第二个私密.txt', mimeType: 'text/plain', buffer: Buffer.from('私密2') },
  ]);
  const recipient = (await admin('/status')).devices.find((d: any) => d.name === '在线手机');
  await modal.locator(`[data-device-id="${recipient.id}"] input`).check();
  await modal.locator('summary').click();
  await modal.getByLabel('文件公开备注').fill('检查包权限');
  await modal.getByRole('button', { name: '发送文件', exact: true }).click();
  const message = phone.locator('.bbs-message').filter({ hasText: '检查包权限' });
  await expect(message.locator('.chat-package-button')).toContainText(
    '只有授权者知道.txt 等 2 个文件',
  );
  await message.getByRole('button', { name: '查看文件' }).click();
  await expect(detail).toContainText('只有授权者知道');
  for (const width of [320, 375, 768]) {
    await phone.setViewportSize({ width, height: 700 });
    const box = (await detail.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.y + box.height).toBeLessThanOrEqual(700);
    expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
  }
  await phone.screenshot({ path: 'test-results/package-phone-chat.png' });
  await detail.getByRole('button', { name: '关闭文件详情' }).click();
  const other = await browser.newPage({ viewport: { width: 375, height: 812 } });
  await join(other, '旁观者');
  await other.getByRole('button', { name: '群聊大厅', exact: true }).click();
  await other.getByRole('button', { name: '关闭密文汇总' }).click();
  const unknown = other.locator('.bbs-message').filter({ hasText: '检查包权限' });
  await expect(unknown.getByRole('button', { name: '未知文件' })).toBeDisabled();
  await expect(unknown).not.toContainText('个文件');
  await expect(unknown).not.toContainText('私密');
  await other.close();
  expect(errors).toEqual([]);
});
test('文件包缓存按包清理前确认，整包取消保存记录', async () => {
  const { id, card } = await send([
    { name: '取消一.txt', content: '取消1' },
    { name: '取消二.txt', content: '取消2' },
  ]);
  await card.locator('.package-summary').click();
  await card.getByRole('button', { name: '取消发送' }).click();
  await desktop.getByRole('button', { name: '确认取消', exact: true }).click();
  await expect(card).toHaveCount(0);
  expect((await admin('/packages/' + id)).state).toBe('cancelled');
  const next = await send([
    { name: '缓存一.txt', content: '缓存1' },
    { name: '缓存二.txt', content: '缓存2' },
  ]);
  await desktop.getByRole('button', { name: '中转缓存', exact: true }).click();
  const cache = desktop.locator(`[data-scroll-id="cache-package:${next.id}"]`);
  await expect(cache.locator('.package-summary strong')).toHaveText('缓存一.txt 等 2 个文件');
  await cache.getByRole('button', { name: '清理缓存', exact: true }).click();
  const confirm = desktop.getByRole('dialog', { name: '清理所选文件' });
  await expect(confirm).toBeVisible();
  expect((await admin('/cache')).entries.filter((e: any) => e.packageId === next.id)).toHaveLength(
    2,
  );
  await confirm.getByRole('button', { name: '确认清理', exact: true }).click();
  await expect(cache).toHaveCount(0);
  expect((await admin('/packages/' + next.id)).files.every((f: any) => f.cleanedAt)).toBe(true);
});
