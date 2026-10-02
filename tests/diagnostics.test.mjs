import test from 'node:test';
import assert from 'node:assert/strict';
import { scrub, errorData } from '../dist-electron/diagnosticData.js';
test('诊断脱敏保留错误堆栈与文件系统错误字段', () => {
  const secret = 'a'.repeat(64);
  const text = scrub(`Bearer hello http://local/?token=hello#pair=123456 privateKey=${secret}`);
  for (const value of ['hello', '123456', secret]) assert.ok(!text.includes(value));
  const error = Object.assign(new Error('EPERM: C:\\cache'), {
    code: 'EPERM',
    syscall: 'unlink',
    path: 'C:\\cache',
  });
  assert.equal(errorData(error).code, 'EPERM');
  assert.equal(errorData(error).path, 'C:\\cache');
  assert.ok(errorData(error).stack.includes('EPERM'));
  assert.equal(scrub('x'.repeat(9000)).length, 8000);
});
