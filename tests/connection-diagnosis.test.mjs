import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  diagnoseHttp,
  stationAddress,
  diagnosisText,
  pairingFailure,
} from '../dist-electron/connectionDiagnosis.js';
test('连接检查不发送凭证、不消费配对码、不跟随重定向', async () => {
  let count = 0;
  const report = await diagnoseHttp(
    'http://192.168.5.13:42830/#pair=secret',
    'station',
    undefined,
    async (url, options) => {
      count++;
      assert.equal(url, 'http://192.168.5.13:42830/api/info');
      assert.equal(options.redirect, 'error');
      assert.equal(options.credentials, 'omit');
      assert.equal(options.headers, undefined);
      return Response.json({ app: 'Relay3', running: true, stationId: 'station', name: '工作站' });
    },
  );
  assert.equal(count, 1);
  assert.ok(report.steps.every((s) => s.state !== 'failed'));
  assert.ok(!diagnosisText(report).includes('secret'));
});
test('地址验证、站身份变化、超时与凭证失效分开表达', async () => {
  assert.throws(() => stationAddress('https://192.168.5.13'), /HTTP/);
  assert.throws(() => stationAddress('http://example.com'), /IPv4/);
  assert.throws(() => stationAddress('http://user:secret@192.168.5.13'), /账号密码/);
  const changed = await diagnoseHttp('http://192.168.5.13', 'old', undefined, async () =>
    Response.json({ app: 'Relay3', running: true, stationId: 'new' }),
  );
  assert.match(changed.steps.at(-1).detail, /身份已变化/);
  const timeout = await diagnoseHttp('http://192.168.5.13', undefined, undefined, async () => {
    throw new Error('timeout');
  });
  assert.ok(timeout.advice.some((a) => a.includes('不能确定')));
  assert.match(pairingFailure({ status: 401 }), /凭证/);
  assert.match(pairingFailure({ status: 409 }), /冲突/);
});
