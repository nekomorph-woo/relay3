import { test, expect, _electron, chromium } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
// @ts-ignore 已构建服务，用独立数据目录验证真实 Electron 生命周期。
import { RelayService } from '../dist-electron/index.js';
// @ts-ignore 测试中使用直连 HTTP，避开本机代理。
import { localFetch } from './http.mjs';

for (const mode of ['退出', '渲染崩溃', '强杀', '退出超时'] as const) {
  test(`本机状态和${mode}后双角色多站连接释放、重启恢复`, async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'relay3-lifecycle-'));
    const services: any[] = [];
    let app: any, browser: any;
    const launch = async () =>
      _electron.launch({
        args: ['.'],
        cwd: process.cwd(),
        env: { ...process.env, RELAY3_DATA_DIR: path.join(dir, 'desktop') },
      });
    try {
      for (const name of ['甲站', '乙站']) {
        const service = new RelayService(path.join(dir, name), path.resolve('dist'));
        service.store.saveSettings({ ...service.store.settings, port: 0, stationName: name });
        await service.startHub();
        services.push(service);
      }
      app = await launch();
      const page = await app.firstWindow();
      const boot = await page.evaluate(() => window.relay3!.bootstrap());
      async function admin(route: string, body?: unknown) {
        return page.evaluate(
          async ({ boot, route, body }) => {
            const res = await fetch(boot.controlUrl + '/admin' + route, {
              method: body === undefined ? 'GET' : 'POST',
              headers: {
                Authorization: 'Bearer ' + boot.adminToken,
                'Content-Type': 'application/json',
              },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            if (!res.ok) throw new Error(await res.text());
            return res.json();
          },
          { boot, route, body },
        );
      }
      const indicator = page.getByRole('button', { name: '本机中转站状态', exact: true });
      await expect(indicator).toHaveText('未开启');
      const listener = net.createServer();
      await new Promise<void>((r) => listener.listen(0, '127.0.0.1', r));
      const port = (listener.address() as net.AddressInfo).port;
      await new Promise<void>((r) => listener.close(() => r()));
      await admin('/settings', { port });
      await page.getByRole('button', { name: '本机中转站', exact: true }).click();
      await page.getByRole('button', { name: '开启中转站', exact: true }).click();
      await expect(indicator).toHaveText('已开启');
      await expect(indicator).toHaveAttribute('data-running', 'true');
      await page.screenshot({ path: `test-results/lifecycle-${mode}-sidebar.png` });
      let local = await admin('/status');
      const localBase = `http://127.0.0.1:${port}`;
      // 本机站连接一个外部客户端，退出后它应收到断开。
      browser = await chromium.launch({ args: ['--no-proxy-server'] });
      const peerPage = await browser.newPage();
      await peerPage.goto(localBase);
      await peerPage.evaluate(
        async ({ base, pairingToken }) => {
          const join = await (
            await fetch(base + '/api/join', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                id: crypto.randomUUID(),
                name: '外部设备',
                platform: 'PC',
                pairingToken,
              }),
            })
          ).json();
          const ws = new WebSocket(base.replace(/^http/, 'ws') + '/api/ws?token=' + join.token);
          (window as any).__peer = ws;
          (window as any).__peerClosed = false;
          ws.onclose = () => {
            (window as any).__peerClosed = true;
          };
        },
        { base: localBase, pairingToken: local.pairingToken },
      );
      await expect
        .poll(async () => (await admin('/status')).devices.some((d: any) => d.online))
        .toBe(true);
      for (const s of services) {
        await page.getByRole('button', { name: '添加中转站连接' }).click();
        await page
          .getByLabel('中转站地址或配对链接')
          .fill(`http://127.0.0.1:${s.hub.server.address().port}/#pair=${s.pairingToken}`);
        await page.locator('dialog').getByRole('button', { name: '连接', exact: true }).click();
        await expect(page.locator('main')).toHaveAttribute('data-connected', 'true');
      }
      await expect.poll(() => services.every((s) => s.clients.has(boot.deviceId))).toBe(true);

      if (mode === '退出超时') {
        await app.evaluate(({ net }: any) => {
          const original = net.fetch.bind(net);
          net.fetch = (url: string, options: any) => {
            if (url.includes('/download')) {
              (globalThis as any).__relayDownloadBlocked = true;
              return new Promise(() => {});
            }
            return original(url, options);
          };
        });
        await page.evaluate(async () => {
          const boot = await window.relay3!.bootstrap();
          const station = Object.values(boot.savedHubs)[0];
          void window
            .relay3!.download({
              base: station.base,
              token: station.token,
              stationId: station.stationId,
              id: 'timeout-test',
              name: 'timeout.txt',
              size: 1,
              sha256: '0'.repeat(64),
            })
            .catch(() => {});
        });
        await expect
          .poll(() => app.evaluate(() => (globalThis as any).__relayDownloadBlocked))
          .toBe(true);
      }
      const process = app.process();
      if (mode === '退出' || mode === '退出超时') {
        // 连续退出不能跳过第一次发起的异步清理。
        await app.evaluate(({ app }: any) => {
          app.quit();
          app.quit();
        });
      } else if (mode === '渲染崩溃') {
        await app.evaluate(({ BrowserWindow }: any) =>
          BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer(),
        );
      } else process.kill('SIGKILL');
      await expect.poll(() => process.exitCode !== null || process.signalCode !== null).toBe(true);
      if (mode === '退出超时') expect(process.exitCode).toBe(1);
      await expect.poll(() => services.every((s) => !s.clients.has(boot.deviceId))).toBe(true);
      for (const s of services) assertOffline(s, boot.deviceId);
      await expect.poll(() => peerPage.evaluate(() => (window as any).__peerClosed)).toBe(true);
      // 实际监听已关闭，而不只是 UI 状态变化。
      await expect
        .poll(async () => {
          try {
            await localFetch(localBase + '/api/info');
            return false;
          } catch {
            return true;
          }
        })
        .toBe(true);
      const db = new DatabaseSync(path.join(dir, 'desktop', 'relay3.sqlite'));
      try {
        expect(
          (db.prepare('SELECT data FROM client_sessions').all() as any[]).filter(
            (r) => JSON.parse(r.data).autoConnect,
          ).length,
        ).toBe(2);
        if (mode !== '强杀')
          expect(
            db.prepare('SELECT id FROM connections WHERE disconnectedAt IS NULL').all(),
          ).toHaveLength(0);
      } finally {
        db.close();
      }
      app = await launch();
      const restarted = await app.firstWindow();
      await expect(
        restarted.getByRole('button', { name: '本机中转站状态', exact: true }),
      ).toHaveText('未开启');
      await expect.poll(() => services.every((s) => s.clients.has(boot.deviceId))).toBe(true);
      const repaired = await restarted.evaluate(async () => {
        const boot = await window.relay3!.bootstrap();
        return (
          await fetch(boot.controlUrl + '/admin/status', {
            headers: { Authorization: 'Bearer ' + boot.adminToken },
          })
        ).json();
      });
      expect(repaired.devices.every((d: any) => !d.online)).toBe(true);
    } finally {
      await browser?.close();
      await app?.close().catch(() => {});
      await Promise.all(services.map((s) => s.close()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
function assertOffline(service: any, deviceId: string) {
  expect(service.store.device(deviceId).disconnectedAt).not.toBeNull();
  expect(service.store.connections().every((c: any) => c.disconnectedAt !== null)).toBe(true);
}
