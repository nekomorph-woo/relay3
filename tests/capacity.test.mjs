import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capacitySnapshot, assertCapacity, diskMargin } from '../dist-electron/capacity.js';
test('容量预算只扣尚未写入承诺及安全余量，并检查非法大小', () => {
  const stat = () => ({ bavail: 1000, bsize: 1024 * 1024 });
  const c = capacitySnapshot('/unused', 200 * 1024 * 1024, stat);
  assert.equal(c.availableBytes, 800 * 1024 * 1024 - diskMargin);
  assert.doesNotThrow(() => assertCapacity(c.availableBytes, c.availableBytes));
  assert.throws(
    () => assertCapacity(c.availableBytes + 1, c.availableBytes),
    (e) => e.statusCode === 507,
  );
  assert.throws(
    () => assertCapacity(-1, c.availableBytes),
    (e) => e.statusCode === 400,
  );
  assert.equal(capacitySnapshot('/unused', 2000 * 1024 * 1024, stat).availableBytes, 0);
});
