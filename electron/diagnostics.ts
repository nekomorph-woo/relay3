import { app, crashReporter, dialog, BrowserWindow } from 'electron';
import log from 'electron-log/main';
import path from 'node:path';
import os from 'node:os';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  rmSync,
  renameSync,
} from 'node:fs';
import { zipSync, strToU8 } from 'fflate';
import { setDiagnosticSink, diagnostic } from '../server/diagnostics';

export let logsDir = '';
let crashDir = '',
  marker = '';
let fatal = false;
export function initializeDiagnostics() {
  logsDir = path.join(app.getPath('userData'), 'logs');
  crashDir = path.join(app.getPath('userData'), 'crash-dumps');
  marker = path.join(logsDir, 'active-session.json');
  mkdirSync(logsDir, { recursive: true });
  mkdirSync(crashDir, { recursive: true });
  app.setPath('crashDumps', crashDir);
  log.transports.file.resolvePathFn = () => path.join(logsDir, 'main.log');
  log.transports.file.maxSize = 5 * 1024 * 1024;
  log.transports.file.sync = true;
  log.transports.file.writeOptions = { flag: 'a', encoding: 'utf8', mode: 0o600 };
  log.transports.console.level = false;
  log.transports.file.archiveLogFn = (file) => {
    for (let i = 4; i >= 1; i--) {
      const from = path.join(logsDir, `main.${i}.log`),
        to = path.join(logsDir, `main.${i + 1}.log`);
      if (existsSync(from)) {
        rmSync(to, { force: true });
        renameSync(from, to);
      }
    }
    renameSync(file.path, path.join(logsDir, 'main.1.log'));
  };
  setDiagnosticSink((level, event, details) => log[level](event, details));
  if (existsSync(marker)) diagnostic('warn', 'session.previous-exit-unclean');
  writeFileSync(
    marker,
    JSON.stringify({ startedAt: new Date().toISOString(), version: app.getVersion() }),
  );
  diagnostic('info', 'session.start', {
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    os: os.release(),
    packaged: app.isPackaged,
  });
  crashReporter.start({ uploadToServer: false, compress: true });
  let crashBytes = 0;
  const dumps = diagnosticFiles()
    .filter((file) => file.name.endsWith('.dmp'))
    .sort((a, b) => statSync(b.path).mtimeMs - statSync(a.path).mtimeMs);
  for (const [index, file] of dumps.entries()) {
    crashBytes += statSync(file.path).size;
    if (index >= 20 || crashBytes > 100 * 1024 * 1024) rmSync(file.path, { force: true });
  }
  process.on('uncaughtException', (error) => {
    fatal = true;
    diagnostic('error', 'main.uncaught-exception', { error });
    dialog.showErrorBox(
      'Relay3 遇到异常',
      '异常信息已记录，请重新打开应用，在设置中导出诊断日志。',
    );
    app.exit(1);
  });
  process.on('unhandledRejection', (error) =>
    diagnostic('error', 'main.unhandled-rejection', {
      error: error instanceof Error ? error : new Error(String(error)),
    }),
  );
  process.on('warning', (error) => diagnostic('warn', 'main.warning', { error }));
  app.on('child-process-gone', (_event, details) =>
    diagnostic('error', 'process.child-gone', {
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
    }),
  );
  app.on('quit', (_event, code) => {
    diagnostic('info', 'session.quit', { code });
    if (!fatal && code === 0) rmSync(marker, { force: true });
  });
}
export function observeWindow(window: BrowserWindow) {
  window.webContents.on('console-message', (details) => {
    if (details.level === 'error')
      diagnostic('error', 'renderer.console-error', {
        message: details.message,
        source: details.sourceId,
        line: details.lineNumber,
      });
  });
  window.webContents.on('render-process-gone', (_event, details) =>
    diagnostic('error', 'renderer.process-gone', {
      reason: details.reason,
      exitCode: details.exitCode,
    }),
  );
  window.webContents.on('unresponsive', () => diagnostic('warn', 'renderer.unresponsive'));
  window.webContents.on('preload-error', (_event, _path, error) =>
    diagnostic('error', 'renderer.preload-error', { error }),
  );
  window.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) =>
    diagnostic('error', 'renderer.load-failed', { code, description, isMainFrame }),
  );
}
export function diagnosticInfo() {
  return {
    path: logsDir,
    crashPath: crashDir,
    files: diagnosticFiles().length,
    bytes: diagnosticFiles().reduce((sum, file) => sum + statSync(file.path).size, 0),
  };
}
function diagnosticFiles() {
  const files: { path: string; name: string }[] = [];
  function walk(dir: string, prefix: string, depth = 0) {
    if (depth > 3) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const filename = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(filename, prefix + entry.name + '/', depth + 1);
      else if (/^(main(?:\.\d+)?\.log)$/.test(entry.name) || entry.name.endsWith('.dmp'))
        files.push({ path: filename, name: prefix + entry.name });
    }
  }
  walk(logsDir, 'logs/');
  walk(crashDir, 'crash-dumps/');
  return files;
}
export async function exportDiagnostics(window: BrowserWindow) {
  const result = await dialog.showSaveDialog(window, {
    defaultPath: path.join(app.getPath('downloads'), `Relay3-diagnostics-${Date.now()}.zip`),
    filters: [{ name: '诊断日志', extensions: ['zip'] }],
  });
  if (result.canceled || !result.filePath) return null;
  diagnostic('info', 'diagnostics.export');
  const files: Record<string, Uint8Array> = {};
  let bytes = 0;
  const included: string[] = [],
    skipped: string[] = [];
  for (const file of diagnosticFiles().sort(
    (a, b) => statSync(b.path).mtimeMs - statSync(a.path).mtimeMs,
  )) {
    const size = statSync(file.path).size;
    if (bytes + size > 50 * 1024 * 1024) {
      skipped.push(file.name);
      continue;
    }
    files[file.name] = readFileSync(file.path);
    bytes += size;
    included.push(file.name);
  }
  files['manifest.json'] = strToU8(
    JSON.stringify(
      {
        version: app.getVersion(),
        exportedAt: new Date().toISOString(),
        platform: process.platform,
        arch: process.arch,
        os: os.release(),
        electron: process.versions.electron,
        node: process.versions.node,
        included,
        skipped,
        note: '仅本地采集。崩溃转储可能含进程内存，请仅提供给信任的排查人员。',
      },
      null,
      2,
    ),
  );
  writeFileSync(result.filePath, zipSync(files));
  return result.filePath;
}
export async function clearDiagnostics(window: BrowserWindow) {
  const result = await dialog.showMessageBox(window, {
    type: 'question',
    message: '清理所有诊断日志和崩溃转储？',
    detail: '清理后无法用这些日志排查此前异常。应用数据和收发历史保留。',
    buttons: ['取消', '清理'],
    defaultId: 0,
    cancelId: 0,
  });
  if (result.response !== 1) return false;
  for (const file of diagnosticFiles()) {
    if (file.path === path.join(logsDir, 'main.log')) {
      if (!log.transports.file.getFile().clear()) throw new Error('日志文件无法清理');
    } else rmSync(file.path, { force: true });
  }
  diagnostic('info', 'diagnostics.cleared');
  return true;
}
