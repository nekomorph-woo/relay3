import { NativeFiles } from './nativeFiles';
import { capacitySnapshot, assertCapacity } from '../server/capacity';
import {
  initializeDiagnostics,
  observeWindow,
  diagnosticInfo,
  exportDiagnostics,
  clearDiagnostics,
  logsDir,
} from './diagnostics';
import { diagnostic } from '../server/diagnostics';
import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  Menu,
  nativeImage,
  net,
  session,
  clipboard,
  Tray,
  powerSaveBlocker,
  powerMonitor,
  Notification,
} from 'electron';
import { generateIdentity, validIdentity } from '../src/chat/crypto';
import { RelayService } from '../server/service';
import { diagnoseConnection } from './connectionDiagnosis';
import { StationDiscovery, probeStation } from './discovery';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  linkSync,
  rmSync,
  constants,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const appIconPath = path.join(dirname, '../dist/relay3-desktop.png');
app.setName('Relay3');
app.setPath('userData', process.env.RELAY3_DATA_DIR ?? path.join(app.getPath('appData'), 'relay3'));
let service: RelayService;
let nativeFiles: NativeFiles;
// 与页面使用同一套直连 Chromium 网络栈，避免发现探测和连接走不同代理设置。
const discovery = new StationDiscovery(undefined, (base, signal) =>
  probeStation(base, signal, (url, options) => net.fetch(url.toString(), options)),
);
let window: BrowserWindow | null = null;
let quitting = false;
let shutdownComplete = false;
let tray: Tray | undefined;
let powerBlocker: number | undefined;
let runtimeTimer: NodeJS.Timeout | undefined;
const clientActivities = new Set<string>();
const connectionChecks = new Map<string, AbortController>();
function showWindow() {
  if (window) {
    window.show();
    if (window.isMinimized()) window.restore();
    window.focus();
  }
}
function updateRuntime() {
  if (!service || quitting) return;
  void nativeFiles
    ?.cleanup()
    .catch((e) => diagnostic('warn', 'prepared.cleanup-failed', { error: e }));
  const settings = service.store.settings;
  if (settings.backgroundMode && !tray) {
    const icon = nativeImage.createFromPath(appIconPath).resize({ width: 18, height: 18 });
    tray = new Tray(icon);
    tray.on('click', showWindow);
  } else if (!settings.backgroundMode && tray) {
    tray.destroy();
    tray = undefined;
    showWindow();
  }
  const active = downloads.size + service.streams.size + clientActivities.size;
  tray?.setToolTip(`Relay3 · ${service.hub ? '中转站运行中' : '中转站已关闭'} · ${active} 项活动`);
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开 Relay3', click: showWindow },
      { label: service.hub ? '中转站运行中' : '中转站已关闭', enabled: false },
      { label: `活动任务 ${active}`, enabled: false },
      { type: 'separator' },
      { label: '退出 Relay3', click: () => app.quit() },
    ]),
  );
  const shouldBlock =
    (!!settings.preventSleepStation && !!service.hub) ||
    (settings.preventSleepTransfers !== false && active > 0);
  if (shouldBlock && powerBlocker === undefined)
    powerBlocker = powerSaveBlocker.start('prevent-app-suspension');
  if (!shouldBlock && powerBlocker !== undefined) {
    powerSaveBlocker.stop(powerBlocker);
    powerBlocker = undefined;
  }
}
const downloads = new Map<string, AbortController>();
const downloadReservations = new Map<string, { dir: string; remaining: number }>();
function localUrl(raw: string) {
  const u = new URL(raw);
  const h = u.hostname;
  if (
    u.protocol !== 'http:' ||
    u.username ||
    u.password ||
    !(
      /^(localhost|127\.0\.0\.1)$/.test(h) ||
      /^192\.168\.\d{1,3}\.\d{1,3}$/.test(h) ||
      /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(h)
    )
  )
    throw new Error('请输入局域网中转站的 HTTP 地址');
  return u.origin;
}
function senderAllowed(event: Electron.IpcMainInvokeEvent) {
  const expected = new URL(process.env.RELAY3_DEV_URL ?? service.controlUrl).origin;
  if (!event.senderFrame || new URL(event.senderFrame.url).origin !== expected)
    throw new Error('来源无效');
}
async function createWindow() {
  window = new BrowserWindow({
    width: 1404,
    height: 942,
    minWidth: 800,
    minHeight: 600,
    title: 'Relay3',
    backgroundColor: '#f5f6f7',
    icon: appIconPath,
    webPreferences: {
      preload: path.join(dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  observeWindow(window);
  window.webContents.on('render-process-gone', () => {
    // 主进程仍可能持有中转监听与下载；页面崩溃后统一退出，避免静默运行。
    app.quit();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (e, url) => {
    if (new URL(url).origin !== new URL(process.env.RELAY3_DEV_URL ?? service.controlUrl).origin)
      e.preventDefault();
  });
  window.setMenuBarVisibility(false);
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !(input.meta || input.control) || input.alt) return;
    const key = input.key.toLowerCase();
    const actions: Record<string, () => void> = {
      c: () => window?.webContents.copy(),
      v: () => window?.webContents.paste(),
      x: () => window?.webContents.cut(),
      a: () => window?.webContents.selectAll(),
      z: () => (input.shift ? window?.webContents.redo() : window?.webContents.undo()),
      y: () => window?.webContents.redo(),
      q: () => app.quit(),
    };
    if (actions[key]) {
      event.preventDefault();
      actions[key]();
    }
  });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, cb) => cb(false));
  await window.loadURL(process.env.RELAY3_DEV_URL ?? service.controlUrl);
  window.on('close', (e) => {
    if (!quitting && service.store.settings.backgroundMode) {
      e.preventDefault();
      window?.hide();
    }
  });
  window.on('closed', () => (window = null));
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  initializeDiagnostics();
  app.on('second-instance', () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
  });
  app
    .whenReady()
    .then(async () => {
      service = new RelayService(
        process.env.RELAY3_DATA_DIR ?? app.getPath('userData'),
        path.join(dirname, '../dist'),
        path.join(app.getPath('downloads'), 'relay3'),
      );
      nativeFiles = new NativeFiles(
        path.join(app.getPath('userData'), 'prepared-files'),
        (id, stage, bytes, total) =>
          window?.webContents.send('native-progress', { id, stage, bytes, total }),
      );
      // 上次进程退出留下的压缩包不复用，任务历史和用户原目录均保留。
      rmSync(path.join(app.getPath('userData'), 'prepared-files'), {
        recursive: true,
        force: true,
      });
      await session.defaultSession.setProxy({ mode: 'direct' });
      service.onHubChanged = () =>
        discovery.publish(
          service.hub
            ? {
                stationId: service.store.settings.stationId,
                name: service.store.settings.stationName,
                port: (service.hub.server.address() as { port: number }).port,
                platform: process.platform === 'darwin' ? 'Mac' : 'PC',
              }
            : undefined,
        );
      await service.startControl();
      if (process.env.RELAY3_TEST_HUB === '1') await service.startHub();
      Menu.setApplicationMenu(null);
      app.setAboutPanelOptions({
        applicationName: 'Relay3',
        applicationVersion: app.getVersion(),
        iconPath: appIconPath,
        website: 'https://github.com/nekomorph-woo/relay3',
        copyright: 'PC · Mac · 手机',
      });
      if (process.platform === 'darwin') app.dock?.setIcon(nativeImage.createFromPath(appIconPath));
      const handler = (name: string, fn: (...args: any[]) => any) =>
        ipcMain.handle(name, async (event, ...args) => {
          try {
            senderAllowed(event);
            if (quitting) throw new Error('应用正在退出');
            return await fn(...args);
          } catch (error) {
            diagnostic('error', 'ipc.failed', { channel: name, error });
            throw error;
          }
        });
      handler('notify-station', (input: { stationId: string; page: string; body: string }) => {
        const saved = Object.values(service.store.clientSessions()).find(
          (s) => s.stationId === input.stationId,
        );
        if (
          !saved ||
          !['chat', 'transfer'].includes(input.page) ||
          typeof input.body !== 'string' ||
          input.body.length > 240 ||
          !Notification.isSupported()
        )
          return;
        const n = new Notification({
          title: `Relay3 · ${saved.stationName || '其他'}`,
          body: input.body,
          icon: appIconPath,
        });
        n.on('click', () => {
          showWindow();
          window?.webContents.send('notification-open', {
            stationId: input.stationId,
            page: input.page,
          });
        });
        n.show();
      });
      handler('client-activity', (id: string, active: boolean) => {
        if (typeof id !== 'string' || id.length > 80 || typeof active !== 'boolean')
          throw new Error('任务标识无效');
        if (active) clientActivities.add(id);
        else clientActivities.delete(id);
        updateRuntime();
      });
      handler('diagnostic-info', diagnosticInfo);
      handler('connection-diagnose', async (raw: string, expected?: string, id = 'check') => {
        if (typeof id !== 'string' || id.length > 80 || connectionChecks.size >= 4)
          throw new Error('检查繁忙');
        const c = new AbortController();
        connectionChecks.set(id, c);
        try {
          return await diagnoseConnection(
            raw,
            expected,
            (url, options) => net.fetch(url instanceof URL ? url.toString() : url, options),
            c.signal,
          );
        } finally {
          connectionChecks.delete(id);
        }
      });
      handler('connection-diagnose-cancel', (id: string) => connectionChecks.get(id)?.abort());
      handler('discovery-start', () => discovery.start());
      handler('discovery-snapshot', () => discovery.snapshot());
      handler('discovery-refresh', () => discovery.refresh());
      handler('discovery-stop', () => discovery.stop());
      handler('diagnostic-export', () => exportDiagnostics(window!));
      handler('diagnostic-clear', () => clearDiagnostics(window!));
      let diagnosticCount = 0,
        diagnosticStarted = Date.now();
      handler('diagnostic-report', (data: any) => {
        if (Date.now() - diagnosticStarted > 60_000) {
          diagnosticCount = 0;
          diagnosticStarted = Date.now();
        }
        if (diagnosticCount++ >= 20) return;
        if (!data || typeof data.event !== 'string') throw new Error('诊断数据无效');
        diagnostic('error', 'renderer.exception', {
          event: String(data.event).slice(0, 100),
          name: String(data.name ?? ''),
          message: String(data.message ?? ''),
          stack: String(data.stack ?? ''),
          stationId: String(data.stationId ?? '').slice(0, 100),
          base: String(data.base ?? '').slice(0, 240),
        });
      });
      handler('show-about', () => app.showAboutPanel());
      handler('open-github', () => shell.openExternal('https://github.com/nekomorph-woo/relay3'));
      handler('clipboard-write', (text: string) => {
        if (typeof text !== 'string' || text.length > 1_048_576) throw new Error('复制内容无效');
        clipboard.writeText(text);
        return true;
      });
      handler('chat-identity', () => {
        const folder = path.join(app.getPath('userData'), 'chat-keys');
        mkdirSync(folder, { recursive: true, mode: 0o700 });
        const filename = path.join(folder, service.store.settings.deviceId + '.json');
        if (existsSync(filename)) {
          try {
            const saved = JSON.parse(readFileSync(filename, 'utf8'));
            if (!validIdentity(saved)) throw new Error();
            return saved;
          } catch {
            throw new Error('本机聊天密钥无法读取，请在设置中更换设备身份');
          }
        }
        const identity = generateIdentity();
        writeFileSync(filename, JSON.stringify(identity), { mode: 0o600, flag: 'wx' });
        return identity;
      });
      handler('bootstrap', () => ({
        controlUrl: service.controlUrl,
        adminToken: service.adminToken,
        deviceId: service.store.settings.deviceId,
        deviceName: service.store.settings.deviceName,
        platform: process.platform === 'darwin' ? 'Mac' : 'PC',
        version: app.getVersion(),
        savedHubs: service.store.clientSessions(),
        clientView: service.store.clientView(),
      }));
      handler('pick-folder-file', async () => {
        const picked = await dialog.showOpenDialog(window!, { properties: ['openDirectory'] });
        if (picked.canceled) return null;
        clientActivities.add('folder');
        updateRuntime();
        try {
          return await nativeFiles.folder(picked.filePaths[0], async (excluded) => {
            const result = await dialog.showMessageBox(window!, {
              type: 'warning',
              title: '部分条目无法打包',
              message: `${excluded.length} 个条目将排除`,
              detail: excluded.slice(0, 20).join('\n'),
              buttons: ['取消', '排除这些条目并继续'],
              defaultId: 0,
              cancelId: 0,
            });
            return result.response === 1;
          });
        } finally {
          clientActivities.delete('folder');
          updateRuntime();
        }
      });
      handler('native-hash', (id: string) => nativeFiles.hash(id));
      handler('native-release', (id: string) => nativeFiles.release(id));
      handler('native-cancel', (id: string) => nativeFiles.cancel(id));
      handler(
        'native-upload',
        async (input: {
          nativeId: string;
          base: string;
          token: string;
          fileId: string;
          size: number;
          hash: string;
          stationId: string;
        }) => {
          const base = localUrl(input.base),
            saved = Object.values(service.store.clientSessions()).find(
              (s) => s.base === base && s.token === input.token && s.stationId === input.stationId,
            );
          if (!saved || !/^[a-zA-Z0-9-]{16,80}$/.test(input.fileId))
            throw new Error('上传凭证或文件标识无效');
          const source = nativeFiles.resolve(input.nativeId).source;
          service.store.db
            .prepare('INSERT OR REPLACE INTO settings VALUES (?,?)')
            .run(`source:${input.stationId}:${input.fileId}`, JSON.stringify(source));
          await nativeFiles.upload(
            input.nativeId,
            base,
            input.token,
            input.fileId,
            input.size,
            input.hash,
          );
        },
      );
      handler('reuse-source', async (input: { stationId: string; fileIds: string[] }) => {
        if (!Array.isArray(input.fileIds) || input.fileIds.length > 100)
          throw new Error('文件清单无效');
        const files = [];
        let missing = 0;
        for (const id of input.fileIds) {
          const row = service.store.db
            .prepare('SELECT value FROM settings WHERE key=?')
            .get(`source:${input.stationId}:${id}`) as { value: string } | undefined;
          try {
            if (!row) throw new Error();
            files.push(await nativeFiles.source(JSON.parse(row.value)));
          } catch {
            missing++;
          }
        }
        return { files, missing };
      });
      handler('pick-directory', async () => {
        const result = await dialog.showOpenDialog(window!, {
          properties: ['openDirectory', 'createDirectory'],
        });
        return result.canceled ? null : result.filePaths[0];
      });
      handler('open-directory', async (kind: string) => {
        const choices: Record<string, string> = {
          data: service.store.dataDir,
          cache: service.store.settings.cacheDir,
          receive: service.store.settings.receiveDir,
          logs: logsDir,
        };
        const target = choices[kind];
        if (!target) throw new Error('目录无效');
        mkdirSync(target, { recursive: true });
        const error = await shell.openPath(target);
        if (error) throw new Error(error);
        return true;
      });
      handler('remember-source', (input: { stationId: string; fileId: string; path: string }) => {
        if (
          !/^[a-zA-Z0-9-]{16,80}$/.test(input.fileId) ||
          !/^[a-zA-Z0-9-]{16,80}$/.test(input.stationId) ||
          !path.isAbsolute(input.path)
        )
          throw new Error('源文件无效');
        service.store.db
          .prepare('INSERT OR REPLACE INTO settings VALUES (?,?)')
          .run(`source:${input.stationId}:${input.fileId}`, JSON.stringify(input.path));
        return true;
      });
      function resolveFile(input: {
        kind: 'received' | 'cache' | 'source';
        id: string;
        stationId?: string;
      }) {
        let target: string | undefined;
        if (input.kind === 'received')
          target = service.store.received().find((f) => f.id === input.id)?.path;
        if (input.kind === 'cache')
          target = service.cache().entries.find((f) => f.id === input.id)?.path;
        if (input.kind === 'source') {
          const row = service.store.db
            .prepare('SELECT value FROM settings WHERE key=?')
            .get(`source:${input.stationId}:${input.id}`) as { value: string } | undefined;
          if (row) target = JSON.parse(row.value);
        }
        return target;
      }
      handler('can-reveal-file', (input: Parameters<typeof resolveFile>[0]) => {
        const target = resolveFile(input);
        return !!target && existsSync(target);
      });
      handler('reveal-file', (input: Parameters<typeof resolveFile>[0]) => {
        const target = resolveFile(input);
        if (!target || !existsSync(target)) throw new Error('文件已删除、移动或清理');
        shell.showItemInFolder(target);
        return true;
      });
      handler('cancel-download', (id: string, stationId?: string) => {
        if (stationId) downloads.get(`${stationId}:${id}`)?.abort();
        else
          for (const [key, controller] of downloads) if (key.endsWith(':' + id)) controller.abort();
        return true;
      });
      handler(
        'download',
        async (input: {
          base: string;
          token: string;
          id: string;
          name: string;
          size: number;
          sha256: string;
          packageId?: string;
          stationId?: string;
          stationName?: string;
        }) => {
          const base = localUrl(input.base);
          const saved = Object.values(service.store.clientSessions()).find(
            (s) => s.base === base && s.token === input.token,
          );
          if (input.stationId && saved?.stationId !== input.stationId)
            throw new Error('中转站凭证不匹配');
          const stationId = saved?.stationId;
          const downloadKey = `${stationId ?? base}:${input.id}`;
          if (!/^[a-zA-Z0-9-]+$/.test(input.id) || downloads.has(downloadKey))
            throw new Error('传输标识无效或已在接收');
          const dir = service.store.settings.receiveDir;
          mkdirSync(dir, { recursive: true });
          const reserved = [...downloadReservations.values()]
            .filter((r) => r.dir === dir)
            .reduce((n, r) => n + r.remaining, 0);
          // 接收目录与本机中转缓存共用磁盘时，也扣除站内承诺。
          const sameDisk =
            (await import('node:fs')).statSync(dir).dev ===
            (await import('node:fs')).statSync(service.store.settings.cacheDir).dev;
          assertCapacity(
            input.size,
            capacitySnapshot(dir, reserved + (sameDisk ? service.capacity().committedBytes : 0))
              .availableBytes,
            '接收目录',
          );
          downloadReservations.set(downloadKey, { dir, remaining: input.size });
          let safeName =
            path
              .basename(input.name.replace(/\\/g, '/'))
              .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
              .replace(/[. ]+$/, '') || 'Relay3-file';
          if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i.test(safeName))
            safeName = '_' + safeName;
          let destination = path.join(dir, safeName),
            n = 1;
          const ext = path.extname(safeName),
            stem = safeName.slice(0, safeName.length - ext.length);
          while (existsSync(destination)) destination = path.join(dir, `${stem} (${n++})${ext}`);
          const temporary = path.join(dir, `.relay3-${randomUUID()}.partial`),
            controller = new AbortController();
          downloads.set(downloadKey, controller);
          try {
            const response = await net.fetch(`${base}/api/transfers/${input.id}/download`, {
              headers: { Authorization: `Bearer ${input.token}` },
              signal: controller.signal,
              redirect: 'error',
            });
            if (!response.ok) throw new Error((await response.json()).error ?? '下载失败');
            const hash = createHash('sha256');
            let bytes = 0,
              last = 0;
            const meter = new Transform({
              transform(chunk, _enc, cb) {
                bytes += chunk.length;
                const reservation = downloadReservations.get(downloadKey);
                if (reservation) reservation.remaining = Math.max(0, input.size - bytes);
                hash.update(chunk);
                if (Date.now() - last > 200) {
                  last = Date.now();
                  window?.webContents.send('download-progress', {
                    id: input.id,
                    key: downloadKey,
                    stationId,
                    bytes,
                  });
                }
                cb(null, chunk);
              },
            });
            await pipeline(
              Readable.fromWeb(response.body as any),
              meter,
              createWriteStream(temporary, { flags: 'wx' }),
              { signal: controller.signal },
            );
            if (bytes !== input.size || hash.digest('hex') !== input.sha256)
              throw new Error('文件校验失败，请重新接收');
            // An atomic exclusive link prevents concurrent downloads overwriting the same name.
            while (true) {
              try {
                try {
                  linkSync(temporary, destination);
                } catch (e: any) {
                  if (!['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV'].includes(e.code)) throw e;
                  // exFAT and some network volumes do not support hard links.
                  await copyFile(
                    temporary,
                    destination,
                    constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
                  );
                }
                break;
              } catch (e: any) {
                if (e.code !== 'EEXIST') throw e;
                destination = path.join(dir, `${stem} (${n++})${ext}`);
              }
            }
            service.store.saveReceived({
              id: `${stationId ?? base}:${input.id}`,
              transferId: input.id,
              packageId: input.packageId,
              name: path.basename(destination),
              path: destination,
              size: bytes,
              receivedAt: Date.now(),
              stationId,
              stationName:
                typeof input.stationName === 'string' && input.stationName.trim()
                  ? input.stationName.slice(0, 240)
                  : saved?.stationName,
            });
            // The server may observe its finish event shortly after the client receives EOF.
            let confirmed = false;
            for (let attempt = 0; attempt < 4; attempt++) {
              const result = await net
                .fetch(`${base}/api/transfers/${input.id}/complete`, {
                  method: 'POST',
                  headers: {
                    Authorization: `Bearer ${input.token}`,
                    'Content-Type': 'application/json',
                  },
                  body: '{}',
                  redirect: 'error',
                })
                .catch(() => null);
              if (!result) break;
              const record = await result.json();
              if (result.ok) {
                service.store.remember([record]);
                confirmed = true;
                break;
              }
              if (result.status !== 409) break;
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
            return { path: destination, confirmed };
          } finally {
            downloads.delete(downloadKey);
            downloadReservations.delete(downloadKey);
            rmSync(temporary, { force: true });
          }
        },
      );
      await createWindow();
      runtimeTimer = setInterval(updateRuntime, 1000);
      updateRuntime();
      powerMonitor.on('resume', () => {
        window?.webContents.send('system-resume');
        service.broadcast();
        updateRuntime();
      });
      app.on('activate', () => {
        if (!window) void createWindow();
      });
    })
    .catch((err) => {
      diagnostic('error', 'app.startup-failed', { error: err });
      dialog.showErrorBox('Relay3 启动失败', String(err));
      app.quit();
    });
  app.on('window-all-closed', () => app.quit());
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => app.quit());
  app.on('before-quit', (e) => {
    if (shutdownComplete) return;
    e.preventDefault();
    if (quitting) return;
    quitting = true;
    clearInterval(runtimeTimer);
    tray?.destroy();
    if (powerBlocker !== undefined) powerSaveBlocker.stop(powerBlocker);
    const deadline = setTimeout(() => {
      diagnostic('error', 'app.shutdown-timeout');
      app.exit(1);
    }, 5000);
    for (const c of connectionChecks.values()) c.abort();
    for (const c of downloads.values()) c.abort();
    // 销毁渲染进程，同时终止全部客户端 WebSocket、XHR 和重连计时器。
    window?.destroy();
    const transfersSettled = (async () => {
      while (downloads.size) await new Promise<void>((resolve) => setTimeout(resolve, 10));
    })();
    void Promise.allSettled([
      service?.close(transfersSettled),
      discovery.close(),
      nativeFiles?.close(),
    ]).then((results) => {
      for (const result of results)
        if (result.status === 'rejected')
          diagnostic('error', 'app.shutdown-failed', { error: result.reason });
      clearTimeout(deadline);
      shutdownComplete = true;
      app.quit();
    });
  });
}
