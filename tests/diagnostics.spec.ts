import { test, expect, _electron } from '@playwright/test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { unzipSync, strFromU8 } from 'fflate';
const appVersion = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')).version;
test('统一异常采集、崩溃记录、脱敏导出与确认清理', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'relay3-diagnostics-'));
  mkdirSync(path.join(dir, 'logs'));
  writeFileSync(path.join(dir, 'logs', 'active-session.json'), '{}');
  const app = await _electron.launch({
    ...(process.env.RELAY3_PACKAGED_PATH
      ? { executablePath: process.env.RELAY3_PACKAGED_PATH, args: [] }
      : { args: ['.'] }),
    cwd: process.cwd(),
    env: { ...process.env, RELAY3_DATA_DIR: dir },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.evaluate(async () => {
      await window.relay3!.bootstrap();
      window.dispatchEvent(
        new ErrorEvent('error', { error: new Error('diagnostic-window-error Bearer TEST_SECRET') }),
      );
      window.dispatchEvent(
        new PromiseRejectionEvent('unhandledrejection', {
          promise: Promise.resolve(),
          reason: new Error('diagnostic-rejection'),
        }),
      );
      await window.relay3!.openDirectory('invalid').catch(() => {});
      const b = await window.relay3!.bootstrap();
      await fetch(b.controlUrl + '/admin/settings', {
        method: 'POST',
        headers: { Authorization: `Bearer ${b.adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ retentionHours: -1 }),
      });
    });
    await app.evaluate(() => {
      process.emit('unhandledRejection', new Error('diagnostic-main-rejection'), Promise.resolve());
    });
    const filename = path.join(dir, 'logs', 'main.log');
    await expect.poll(() => readFileSync(filename, 'utf8')).toContain('diagnostic-main-rejection');
    const text = readFileSync(filename, 'utf8');
    for (const event of [
      'session.previous-exit-unclean',
      'diagnostic-window-error',
      'diagnostic-rejection',
      'ipc.failed',
      'http.failed',
    ])
      expect(text).toContain(event);
    expect(text).not.toContain('TEST_SECRET');
    await page.getByRole('button', { name: '诊断日志', exact: true }).click();
    await expect(page.getByRole('button', { name: '导出诊断日志' })).toBeVisible();
    await page.getByRole('button', { name: '导出诊断日志' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'test-results/v036-diagnostics-settings.png' });
    const archive = path.join(dir, 'diagnostics.zip');
    await app.evaluate(({ dialog }, filename) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: filename });
    }, archive);
    await page.getByRole('button', { name: '导出诊断日志' }).click();
    await expect.poll(() => existsSync(archive)).toBeTruthy();
    const files = unzipSync(readFileSync(archive));
    expect(JSON.parse(strFromU8(files['manifest.json'])).version).toBe(appVersion);
    expect(strFromU8(files['logs/main.log'])).toContain('diagnostic-window-error');
    expect(
      Object.keys(files).some((name) => name.includes('sqlite') || name.includes('chat-keys')),
    ).toBeFalsy();
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    });
    expect(await page.evaluate(() => window.relay3!.clearDiagnostics())).toBeFalsy();
    expect(readFileSync(filename, 'utf8')).toContain('diagnostic-window-error');
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });
    expect(await page.evaluate(() => window.relay3!.clearDiagnostics())).toBeTruthy();
    expect(readFileSync(filename, 'utf8')).not.toContain('diagnostic-window-error');
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer(),
    );
    await expect.poll(() => readFileSync(filename, 'utf8')).toContain('renderer.process-gone');
  } finally {
    await app.close();
    expect(existsSync(path.join(dir, 'logs', 'active-session.json'))).toBeFalsy();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('主进程未捕获异常同步落盘并保留非正常退出标记', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'relay3-fatal-'));
  const app = await _electron.launch({
    ...(process.env.RELAY3_PACKAGED_PATH
      ? { executablePath: process.env.RELAY3_PACKAGED_PATH, args: [] }
      : { args: ['.'] }),
    cwd: process.cwd(),
    env: { ...process.env, RELAY3_DATA_DIR: dir },
  });
  try {
    await app.firstWindow();
    const closed = app.waitForEvent('close');
    await app.evaluate(({ dialog }) => {
      dialog.showErrorBox = () => {};
      setTimeout(() => {
        throw new Error('diagnostic-main-fatal');
      }, 50);
    });
    await closed;
    const text = readFileSync(path.join(dir, 'logs', 'main.log'), 'utf8');
    expect(text).toContain('main.uncaught-exception');
    expect(text).toContain('diagnostic-main-fatal');
    expect(existsSync(path.join(dir, 'logs', 'active-session.json'))).toBeTruthy();
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
