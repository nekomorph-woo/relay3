import { ZipFile } from 'yazl';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { readdir, lstat, mkdir, rm, stat, access } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { request } from 'node:http';
import { assertCapacity, capacitySnapshot } from '../server/capacity';
export interface NativeFile {
  nativeId: string;
  name: string;
  size: number;
  lastModified: number;
}
export class NativeFiles {
  private files = new Map<
    string,
    { path: string; source: string; temporary: boolean; hash?: string; createdAt: number }
  >();
  private active = new Map<string, AbortController>();
  constructor(
    readonly directory: string,
    readonly progress: (id: string, stage: string, bytes: number, total: number) => void,
  ) {}
  async scan(root: string, signal: AbortSignal) {
    const entries: { path: string; relative: string; size: number; directory: boolean }[] = [],
      excluded: string[] = [];
    let total = 0;
    const walk = async (dir: string) => {
      signal.throwIfAborted();
      for (const item of await readdir(dir, { withFileTypes: true })) {
        signal.throwIfAborted();
        const full = path.join(dir, item.name),
          relative = path.relative(path.dirname(root), full).split(path.sep).join('/');
        if (entries.length >= 100000) throw new Error('目录超过十万个条目，请拆分发送');
        if (item.isSymbolicLink()) {
          excluded.push(relative + '（符号链接）');
          continue;
        }
        try {
          const info = await lstat(full);
          if (info.isDirectory()) {
            entries.push({ path: full, relative, size: 0, directory: true });
            await walk(full);
          } else if (info.isFile()) {
            await access(full);
            entries.push({ path: full, relative, size: info.size, directory: false });
            total += info.size;
          } else excluded.push(relative + '（特殊文件）');
        } catch (e: any) {
          if (signal.aborted || e.message?.includes('十万个')) throw e;
          excluded.push(relative + '（无法读取）');
        }
      }
    };
    await walk(root);
    return { entries, excluded, total };
  }
  async folder(
    root: string,
    confirm: (excluded: string[]) => Promise<boolean>,
  ): Promise<NativeFile> {
    const id = randomUUID(),
      controller = new AbortController();
    this.active.set(id, controller);
    let output: string | undefined;
    try {
      this.progress(id, '扫描文件夹', 0, 0);
      const scan = await this.scan(root, controller.signal);
      if (scan.excluded.length && !(await confirm(scan.excluded)))
        throw new Error('已取消文件夹发送');
      await mkdir(this.directory, { recursive: true });
      assertCapacity(
        Math.ceil(scan.total * 1.02) + scan.entries.length * 512 + 4096,
        capacitySnapshot(this.directory).availableBytes,
        '临时压缩目录',
      );
      output = path.join(this.directory, id + '.zip');
      const zip = new ZipFile(),
        hash = createHash('sha256');
      let bytes = 0,
        last = 0;
      zip.addEmptyDirectory(path.basename(root) + '/');
      for (const e of scan.entries) {
        controller.signal.throwIfAborted();
        if (e.directory) zip.addEmptyDirectory(e.relative + '/');
        else
          zip.addFile(e.path, e.relative, {
            compress: !/\.(zip|gz|7z|rar|jpg|jpeg|png|mp4|mov|heic|webp|mp3|pdf)$/i.test(e.path),
          });
      }
      const meter = new Transform({
        transform: (chunk, _enc, cb) => {
          bytes += chunk.length;
          hash.update(chunk);
          if (Date.now() - last > 100) {
            last = Date.now();
            this.progress(id, '压缩文件夹', bytes, scan.total);
          }
          cb(null, chunk);
        },
      });
      zip.on('error', (e) => meter.destroy(e));
      const pending = pipeline(
        zip.outputStream,
        meter,
        createWriteStream(output, { flags: 'wx' }),
        { signal: controller.signal },
      );
      zip.end({ forceZip64Format: true, comment: '' });
      await pending;
      this.files.set(id, {
        path: output,
        source: root,
        temporary: true,
        hash: hash.digest('hex'),
        createdAt: Date.now(),
      });
      this.progress(id, '文件夹已准备好', bytes, bytes);
      return {
        nativeId: id,
        name: path.basename(root) + '.zip',
        size: bytes,
        lastModified: Date.now(),
      };
    } catch (e) {
      if (output) await rm(output, { force: true });
      throw e;
    } finally {
      this.active.delete(id);
    }
  }
  async source(source: string): Promise<NativeFile> {
    const info = await stat(source);
    if (!info.isFile()) throw new Error('原始目录请重新选择并压缩');
    const id = randomUUID();
    this.files.set(id, { path: source, source, temporary: false, createdAt: Date.now() });
    return {
      nativeId: id,
      name: path.basename(source),
      size: info.size,
      lastModified: info.mtimeMs,
    };
  }
  resolve(id: string) {
    const f = this.files.get(id);
    if (!f || !existsSync(f.path)) throw new Error('原文件或临时压缩文件已不存在，请重新选择');
    return f;
  }
  async hash(id: string) {
    const f = this.resolve(id);
    if (f.temporary && f.hash) return f.hash;
    const controller = new AbortController();
    this.active.set(id, controller);
    const hash = createHash('sha256');
    try {
      const stream = createReadStream(f.path, { signal: controller.signal });
      let bytes = 0,
        last = 0;
      const total = (await stat(f.path)).size;
      for await (const chunk of stream) {
        hash.update(chunk);
        bytes += chunk.length;
        if (Date.now() - last > 150) {
          last = Date.now();
          this.progress(id, '校验原文件', bytes, total);
        }
      }
      return hash.digest('hex');
    } finally {
      this.active.delete(id);
    }
  }
  async upload(
    id: string,
    base: string,
    token: string,
    fileId: string,
    size: number,
    checksum: string,
  ) {
    const f = this.resolve(id);
    if ((await stat(f.path)).size !== size || (await this.hash(id)) !== checksum)
      throw new Error('文件与原任务不一致，请重新选择');
    const controller = new AbortController();
    this.active.set(id, controller);
    try {
      await new Promise<void>((resolve, reject) => {
        const req = request(
          base + '/api/files/' + encodeURIComponent(fileId) + '/upload',
          {
            method: 'PUT',
            headers: {
              Authorization: 'Bearer ' + token,
              'Content-Type': 'application/octet-stream',
              'Content-Length': size,
            },
            signal: controller.signal,
          },
          (res) => {
            let body = '',
              length = 0;
            res.on('data', (chunk) => {
              length += chunk.length;
              if (length > 16384) {
                req.destroy(new Error('上传响应过大'));
                return;
              }
              body += chunk;
            });
            res.on('end', () => {
              if (res.statusCode && res.statusCode < 400) resolve();
              else {
                try {
                  reject(new Error(JSON.parse(body).error));
                } catch {
                  reject(new Error('上传失败，请重试'));
                }
              }
            });
          },
        );
        req.on('error', reject);
        let bytes = 0,
          last = 0;
        const meter = new Transform({
          transform: (chunk, _enc, cb) => {
            bytes += chunk.length;
            if (Date.now() - last > 150) {
              last = Date.now();
              this.progress(id, '上传', bytes, size);
            }
            cb(null, chunk);
          },
        });
        void pipeline(createReadStream(f.path), meter, req, { signal: controller.signal }).catch(
          reject,
        );
      });
    } finally {
      this.active.delete(id);
    }
  }
  async release(id: string) {
    const f = this.files.get(id);
    if (f?.temporary) await rm(f.path, { force: true });
    this.files.delete(id);
  }
  cancel(id: string) {
    this.active.get(id)?.abort();
  }
  async cleanup() {
    for (const [id, f] of this.files)
      if (!this.active.has(id) && f.createdAt + 86400000 <= Date.now()) await this.release(id);
  }
  async close() {
    for (const c of this.active.values()) c.abort();
    while (this.active.size) await new Promise((r) => setTimeout(r, 10));
    await rm(this.directory, { recursive: true, force: true });
  }
}
