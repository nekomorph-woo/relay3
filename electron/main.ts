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
} from 'electron';
import { RelayService } from '../server/service';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createWriteStream, existsSync, mkdirSync, linkSync, rmSync, constants } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const dirname = path.dirname(fileURLToPath(import.meta.url));
app.setName('relay3');
if (process.env.RELAY3_DATA_DIR) app.setPath('userData', process.env.RELAY3_DATA_DIR);
let service: RelayService;
let window: BrowserWindow | null = null;
let quitting = false;
const downloads = new Map<string, AbortController>();
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
    width: 1220,
    height: 840,
    minWidth: 800,
    minHeight: 600,
    title: 'relay3',
    backgroundColor: '#f5f6f7',
    icon: path.join(dirname, '../dist/relay3.png'),
    webPreferences: {
      preload: path.join(dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (e, url) => {
    if (new URL(url).origin !== new URL(process.env.RELAY3_DEV_URL ?? service.controlUrl).origin)
      e.preventDefault();
  });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, cb) => cb(false));
  await window.loadURL(process.env.RELAY3_DEV_URL ?? service.controlUrl);
  window.on('closed', () => (window = null));
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (window) {
      if (window.isMinimized()) window.restore();
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
      await session.defaultSession.setProxy({ mode: 'direct' });
      await service.startControl();
      if (process.env.RELAY3_TEST_HUB === '1') await service.startHub();
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: 'relay3',
            submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }],
          },
          {
            label: '编辑',
            submenu: [
              { role: 'undo' },
              { role: 'redo' },
              { type: 'separator' },
              { role: 'cut' },
              { role: 'copy' },
              { role: 'paste' },
              { role: 'selectAll' },
            ],
          },
          { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }] },
        ]),
      );
      app.setAboutPanelOptions({
        applicationName: 'relay3',
        applicationVersion: app.getVersion(),
        iconPath: path.join(dirname, '../dist/relay3.png'),
      });
      if (process.platform === 'darwin')
        app.dock?.setIcon(nativeImage.createFromPath(path.join(dirname, '../dist/relay3.png')));
      const handler = (name: string, fn: (...args: any[]) => any) =>
        ipcMain.handle(name, (event, ...args) => {
          senderAllowed(event);
          return fn(...args);
        });
      handler('bootstrap', () => ({
        controlUrl: service.controlUrl,
        adminToken: service.adminToken,
        deviceId: service.store.settings.deviceId,
        deviceName: service.store.settings.deviceName,
        platform: process.platform === 'darwin' ? 'Mac' : 'PC',
        version: app.getVersion(),
      }));
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
        };
        const target = choices[kind];
        if (!target) throw new Error('目录无效');
        mkdirSync(target, { recursive: true });
        const error = await shell.openPath(target);
        if (error) throw new Error(error);
        return true;
      });
      handler('cancel-download', (id: string) => {
        downloads.get(id)?.abort();
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
        }) => {
          const base = localUrl(input.base);
          if (!/^[a-zA-Z0-9-]+$/.test(input.id) || downloads.has(input.id))
            throw new Error('传输标识无效或已在接收');
          const dir = service.store.settings.receiveDir;
          mkdirSync(dir, { recursive: true });
          let safeName =
            path
              .basename(input.name.replace(/\\/g, '/'))
              .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
              .replace(/[. ]+$/, '') || 'relay3-file';
          if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i.test(safeName))
            safeName = '_' + safeName;
          let destination = path.join(dir, safeName),
            n = 1;
          const ext = path.extname(safeName),
            stem = safeName.slice(0, safeName.length - ext.length);
          while (existsSync(destination)) destination = path.join(dir, `${stem} (${n++})${ext}`);
          const temporary = path.join(dir, `.relay3-${input.id}.partial`),
            controller = new AbortController();
          downloads.set(input.id, controller);
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
                hash.update(chunk);
                if (Date.now() - last > 200) {
                  last = Date.now();
                  window?.webContents.send('download-progress', { id: input.id, bytes });
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
              id: randomUUID(),
              name: path.basename(destination),
              path: destination,
              size: bytes,
              receivedAt: Date.now(),
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
            downloads.delete(input.id);
            rmSync(temporary, { force: true });
          }
        },
      );
      await createWindow();
      app.on('activate', () => {
        if (!window) void createWindow();
      });
    })
    .catch((err) => {
      dialog.showErrorBox('relay3 启动失败', String(err));
      app.quit();
    });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (e) => {
    if (!quitting && service) {
      e.preventDefault();
      quitting = true;
      for (const c of downloads.values()) c.abort();
      void service.close().finally(() => app.quit());
    }
  });
}
