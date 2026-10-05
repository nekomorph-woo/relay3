import { test, expect, _electron, chromium } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { setBrowserDeviceName } from './device-ui';
import { unzipSync, strFromU8 } from 'fflate';

test('连接报告、文件夹ZIP双端接收、SQLite搜索、后台隐藏窗口与重新发送草稿', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'relay3-usability-')),
    folder = path.join(dir, '照片目录');
  mkdirSync(folder);
  writeFileSync(path.join(folder, '说明.txt'), '文件夹验收');
  const app = await _electron.launch({
      args: ['.'],
      cwd: process.cwd(),
      env: { ...process.env, RELAY3_DATA_DIR: dir },
    }),
    desktop = await app.firstWindow(),
    errors: string[] = [];
  desktop.on('pageerror', (e) => errors.push(e.message));
  const browser = await chromium.launch({ args: ['--no-proxy-server'] }),
    phone = await browser.newPage({ viewport: { width: 375, height: 812 } });
  try {
    const boot = await desktop.evaluate(() => window.relay3!.bootstrap());
    const admin = async (route: string, body?: unknown) =>
      desktop.evaluate(
        async ({ route, body }) => {
          const b = await window.relay3!.bootstrap();
          const r = await fetch(b.controlUrl + '/admin' + route, {
            method: body === undefined ? 'GET' : 'POST',
            headers: {
              Authorization: 'Bearer ' + b.adminToken,
              'Content-Type': 'application/json',
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
          return r.json();
        },
        { route, body },
      );
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    await new Promise<void>((r) => server.close(() => r()));
    await admin('/settings', {
      port,
      receiveDir: path.join(dir, 'received'),
      stationName: '验收中转站',
    });
    await desktop.getByRole('button', { name: '本机中转站', exact: true }).click();
    await desktop.getByRole('button', { name: '开启中转站', exact: true }).click();
    await desktop.getByRole('button', { name: '本机加入', exact: true }).click();
    const base = `http://127.0.0.1:${port}`,
      status = await admin('/status');
    const report = await desktop.evaluate((base) => window.relay3!.diagnoseConnection(base), base);
    expect(report.steps.every((s) => s.state !== 'failed')).toBe(true);
    expect(JSON.stringify(report)).not.toContain(status.pairingCode);
    await phone.goto(base + '/#pair=' + status.pairingCode);
    await phone.getByRole('button', { name: '连接中转站', exact: true }).click();
    await setBrowserDeviceName(phone, '验收手机');
    await phone.locator('dialog').getByRole('button', { name: '连接', exact: true }).click();
    await expect(phone.locator('main')).toHaveAttribute('data-connected', 'true');
    await desktop.getByRole('button', { name: '文件传输', exact: true }).click();
    const receiver = (await admin('/status')).devices.find((d: any) => d.name === '验收手机');
    await desktop.locator(`.delivery-recipients [data-device-id="${receiver.id}"] input`).check();
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, folder);
    await desktop.getByRole('button', { name: '选择文件夹（自动 ZIP）', exact: true }).click();
    await expect(desktop.locator('.selected-files')).toContainText('照片目录.zip');
    await desktop.getByRole('button', { name: '发送', exact: true }).click();
    await expect(desktop.locator('.file-package').first()).toContainText('照片目录.zip');
    const downloadEvent = phone.waitForEvent('download');
    await phone.getByRole('button', { name: '接收', exact: true }).first().click();
    const download = await downloadEvent;
    const file = await download.path();
    expect(file).toBeTruthy();
    const archive = unzipSync(readFileSync(file!));
    expect(strFromU8(archive['照片目录/说明.txt'])).toBe('文件夹验收');
    await desktop.getByRole('button', { name: '群聊大厅', exact: true }).click();
    const composer = desktop.locator('.chat-composer textarea').first();
    await composer.fill('局域网中文搜索验收');
    await desktop.getByRole('button', { name: '发送文字', exact: true }).click();
    await desktop.getByRole('button', { name: '搜索历史', exact: true }).click();
    const search = desktop.getByRole('dialog', { name: '搜索大厅历史' });
    await search.getByLabel('关键词').fill('中文搜索');
    await search.getByRole('button', { name: '搜索', exact: true }).click();
    await expect(search.locator('.chat-search-results')).toContainText('局域网中文搜索验收');
    await search.getByRole('button', { name: '跳转到消息' }).click();
    await expect(search).toHaveCount(0);
    await desktop.getByRole('button', { name: '本机中转站', exact: true }).click();
    await admin('/settings', { backgroundMode: true });
    await new Promise((r) => setTimeout(r, 1200));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    expect(
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
    ).toBe(false);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    expect((await (await phone.request.get(base + '/api/info')).json()).running).toBe(true);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
    await admin('/settings', { backgroundMode: false });
    await desktop.getByRole('button', { name: '文件传输', exact: true }).click();
    await desktop.locator('.package-summary').first().click();
    await desktop.getByRole('button', { name: '重新发送', exact: true }).first().click();
    await expect(desktop.locator('.notice')).toContainText('需要重新选择');
    await desktop.screenshot({ path: 'test-results/usability-desktop.png' });
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
