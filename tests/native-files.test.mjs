import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { unzipSync, strFromU8 } from 'fflate';
import { NativeFiles } from '../dist-electron/nativeFiles.js';
test('文件夹ZIP保留顶层、中文路径、隐藏文件和空目录，显式确认符号链接排除', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'relay3-zip-')),
    root = path.join(dir, '照片目录'),
    tmp = path.join(dir, 'temporary');
  mkdirSync(path.join(root, '空目录'), { recursive: true });
  writeFileSync(path.join(root, '说明.txt'), '你好');
  writeFileSync(path.join(root, '.hidden'), 'hidden');
  symlinkSync(path.join(root, '说明.txt'), path.join(root, 'link'));
  const progress = [],
    files = new NativeFiles(tmp, (...p) => progress.push(p));
  try {
    let confirmed = false;
    const item = await files.folder(root, async (list) => {
      assert.equal(list.length, 1);
      confirmed = true;
      return true;
    });
    assert.ok(confirmed);
    assert.equal(item.name, '照片目录.zip');
    const f = files.resolve(item.nativeId),
      archive = unzipSync(readFileSync(f.path));
    assert.equal(strFromU8(archive['照片目录/说明.txt']), '你好');
    assert.equal(strFromU8(archive['照片目录/.hidden']), 'hidden');
    assert.ok(archive['照片目录/空目录/']);
    assert.equal(archive['照片目录/link'], undefined);
    assert.equal((await files.hash(item.nativeId)).length, 64);
    await files.release(item.nativeId);
    assert.throws(() => files.resolve(item.nativeId));
    assert.ok(readFileSync(path.join(root, '说明.txt')));
    assert.ok(progress.length > 0);
  } finally {
    await files.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test('取消排除不会产生半成品ZIP，原文件复用只接受普通文件', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'relay3-zip-cancel-')),
    root = path.join(dir, 'source');
  mkdirSync(root);
  writeFileSync(path.join(root, 'a'), 'a');
  symlinkSync(path.join(root, 'a'), path.join(root, 'link'));
  const files = new NativeFiles(path.join(dir, 'tmp'), () => {});
  try {
    await assert.rejects(
      files.folder(root, async () => false),
      /取消/,
    );
    await assert.rejects(files.source(root), /重新选择/);
    const f = await files.source(path.join(root, 'a'));
    assert.equal(f.size, 1);
    assert.equal((await files.hash(f.nativeId)).length, 64);
  } finally {
    await files.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
