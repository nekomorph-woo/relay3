import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { localFetch } from './http.mjs';
import { StationDiscovery, localAddress, probeStation } from '../dist-electron/discovery.js';

const stationId = '00000000-0000-4000-8000-000000000001';
const info = { app: 'Relay3', name: '书房中转站', stationId, running: true, onlineDevices: 2 };
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture(probe = async () => info) {
  const browsers = [],
    publications = [];
  let error;
  let destroyed = 0;
  const bonjour = {
    find() {
      const browser = new EventEmitter();
      browser.stop = () => {
        browser.stopped = true;
      };
      browsers.push(browser);
      return browser;
    },
    publish(options) {
      const service = new EventEmitter();
      service.options = options;
      service.stop = (done) => {
        service.stopped = true;
        done?.();
      };
      publications.push(service);
      return service;
    },
    destroy() {
      destroyed++;
    },
  };
  const discovery = new StationDiscovery((callback) => {
    error = callback;
    return bonjour;
  }, probe);
  return {
    discovery,
    browsers,
    publications,
    fail: () => error(new Error('UDP bind failed')),
    destroyed: () => destroyed,
  };
}
function offer(extra = {}) {
  return {
    name: 'Relay3-' + stationId,
    fqdn: 'Relay3-' + stationId + '._relay3._tcp.local',
    type: 'relay3',
    protocol: 'tcp',
    port: 42830,
    addresses: ['192.168.5.13'],
    txt: { app: 'Relay3', version: '1', stationId, name: '广播名称', platform: 'PC' },
    ...extra,
  };
}

test('只验证局域网地址，广播不能替代实际身份验证', async () => {
  assert.equal(localAddress('192.168.5.13'), true);
  for (const address of ['8.8.8.8', '192.168.999.1', 'example.com', '::1'])
    assert.equal(localAddress(address), false);
  let probes = 0;
  const f = fixture(async () => {
    probes++;
    return { ...info, stationId: 'another-station' };
  });
  try {
    f.discovery.start();
    const browser = f.browsers.at(-1);
    browser.emit('up', offer({ addresses: ['8.8.8.8'] }));
    browser.emit('up', offer({ txt: { ...offer().txt, version: '9' } }));
    assert.equal(probes, 0);
    browser.emit('up', offer());
    await tick();
    assert.equal(f.discovery.snapshot().stations[0].state, 'unreachable');
  } finally {
    await f.discovery.close();
  }
});

test('多网卡验证候选地址，按中转站 ID 去重并读取真实名称和在线数', async () => {
  const probed = [];
  const f = fixture(async (base) => {
    probed.push(base);
    if (base.includes('10.0.0.1')) throw new Error('不可达');
    return info;
  });
  try {
    f.discovery.start();
    f.browsers.at(-1).emit('up', offer({ addresses: ['10.0.0.1', '192.168.5.13'] }));
    f.browsers.at(-1).emit('up', offer({ fqdn: 'second._relay3._tcp.local' }));
    await tick();
    const snapshot = f.discovery.snapshot();
    assert.equal(snapshot.stations.length, 1);
    assert.equal(snapshot.stations[0].name, info.name);
    assert.equal(snapshot.stations[0].base, 'http://192.168.5.13:42830');
    assert.equal(snapshot.stations[0].onlineDevices, 2);
    assert.ok(probed.includes('http://10.0.0.1:42830'));
  } finally {
    await f.discovery.close();
  }
});

test('关闭广播立即移除、刷新重新发现、停止时取消探测且旧结果不复活', async () => {
  let resolveProbe;
  let signal;
  const f = fixture((base, s) => {
    signal = s;
    return new Promise((resolve) => {
      resolveProbe = resolve;
    });
  });
  try {
    f.discovery.start();
    f.browsers.at(-1).emit('up', offer());
    f.browsers.at(-1).emit('down', offer());
    assert.equal(f.discovery.snapshot().stations.length, 0);
    resolveProbe(info);
    await tick();
    assert.equal(f.discovery.snapshot().stations.length, 0);
    f.discovery.refresh();
    assert.equal(f.browsers[0].stopped, true);
    f.browsers.at(-1).emit('up', offer());
    f.discovery.stop();
    assert.equal(signal.aborted, true);
    resolveProbe(info);
    await tick();
    assert.equal(f.discovery.snapshot().stations.length, 0);
    assert.ok(f.destroyed() > 0);
  } finally {
    await f.discovery.close();
  }
});

test('发布不含配对秘密，名称/端口变更重新广播，关闭客户端发现保留中转站广播', async () => {
  const f = fixture();
  try {
    f.discovery.publish({ stationId, name: info.name, port: 42830, platform: 'Mac' });
    assert.deepEqual(Object.keys(f.publications[0].options.txt).sort(), [
      'app',
      'name',
      'platform',
      'stationId',
      'version',
    ]);
    f.discovery.publish({ stationId, name: '新名称', port: 42831, platform: 'Mac' });
    assert.equal(f.publications[0].stopped, true);
    assert.equal(f.publications[1].options.port, 42831);
    f.discovery.start();
    f.discovery.stop();
    assert.equal(f.publications[1].stopped, undefined);
    assert.equal(f.destroyed(), 0);
    f.discovery.publish(undefined);
    await tick();
    assert.equal(f.publications[1].stopped, true);
    assert.equal(f.destroyed(), 1);
  } finally {
    await f.discovery.close();
  }
});

test('UDP 错误回退到手动连接，并限制并行探测数和发现列表大小', async () => {
  let active = 0;
  const f = fixture((base, signal) => {
    active++;
    return new Promise((resolve, reject) =>
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }),
    );
  });
  try {
    f.discovery.start();
    for (let n = 0; n < 50; n++)
      f.browsers.at(-1).emit(
        'up',
        offer({
          fqdn: `${n}._relay3._tcp.local`,
          txt: { ...offer().txt, stationId: stationId.slice(0, -3) + String(n).padStart(3, '0') },
        }),
      );
    assert.equal(active, 4);
    assert.equal(f.discovery.snapshot().stations.length, 32);
    f.fail();
    assert.match(f.discovery.snapshot().error, /手动输入地址/);
  } finally {
    await f.discovery.close();
  }
});

test('HTTP 探测不携带凭证、不跟随跳转，并拒绝超大响应', async () => {
  let mode = 'ok';
  let headers;
  const server = createServer((request, response) => {
    headers = request.headers;
    assert.equal(request.url, '/api/info');
    if (mode === 'redirect') {
      response.writeHead(302, { Location: 'http://8.8.8.8/' });
      response.end();
    } else response.end(mode === 'big' ? 'x'.repeat(17000) : JSON.stringify(info));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    assert.deepEqual(await probeStation(base, new AbortController().signal, localFetch), info);
    assert.equal(headers.authorization, undefined);
    mode = 'redirect';
    await assert.rejects(probeStation(base, new AbortController().signal, localFetch));
    mode = 'big';
    await assert.rejects(probeStation(base, new AbortController().signal, localFetch));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
