import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import os from 'node:os';
import path from 'node:path';

test('双站同时在线、后台传输与消息隔离、并行同 ID 下载、断线恢复及旧来源兼容', async () => {
  test.setTimeout(120000);
  const { RelayService } = await import('../dist-electron/index.js');
  const { generateIdentity, decryptMessage } = await import('../dist-electron/chatCrypto.js');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'relay3-multistation-'));
  const services: any[] = [],
    peers: any[] = [];
  let application: ElectronApplication | undefined;
  let page: Page;
  const errors: string[] = [];
  const peerId = randomUUID();
  async function call(service: any, route: string, token: string, payload?: any, method?: string) {
    const response = await service.hub.inject({
      method: method ?? (payload === undefined ? 'GET' : 'POST'),
      url: route,
      headers: {
        ...(token ? { authorization: 'Bearer ' + token } : {}),
        ...(Buffer.isBuffer(payload) ? { 'content-type': 'application/octet-stream' } : {}),
      },
      ...(payload === undefined ? {} : { payload }),
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }
  async function admin(route: string, body?: any) {
    return page.evaluate(
      async ({ route, body }) => {
        const boot = await window.relay3!.bootstrap();
        const response = await fetch(boot.controlUrl + '/admin' + route, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            Authorization: 'Bearer ' + boot.adminToken,
            'Content-Type': 'application/json',
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (!response.ok) throw new Error(await response.text());
        return response.json();
      },
      { route, body },
    );
  }
  async function launch() {
    application = await _electron.launch({
      ...(process.env.RELAY3_PACKAGED_PATH
        ? { executablePath: process.env.RELAY3_PACKAGED_PATH, args: [] }
        : { args: ['.'] }),
      cwd: process.cwd(),
      env: { ...process.env, RELAY3_DATA_DIR: path.join(dir, 'client') },
    });
    page = await application.firstWindow();
    page.on('pageerror', (e) => errors.push(e.message));
    await expect(page.getByRole('button', { name: '添加中转站连接' })).toBeVisible();
  }
  async function select(index: number) {
    await page.getByRole('button', { name: '切换中转站' }).click();
    await page
      .locator(`[role="option"][data-station-id="${services[index].store.settings.stationId}"]`)
      .click();
    await expect(page.locator('main')).toHaveAttribute('data-connected', 'true');
  }
  async function incoming(index: number, filename: string, content: Buffer, sharedId: string) {
    const service = services[index],
      peer = peers[index];
    const boot = await page.evaluate(() => window.relay3!.bootstrap());
    const broadcast = service.broadcast;
    service.broadcast = () => {};
    const initial = await call(service, '/api/transfers', peer.token, {
      name: filename,
      size: content.length,
      recipientId: boot.deviceId,
    });
    service.store.db.prepare('DELETE FROM transfers WHERE id=?').run(initial.id);
    const transfer = { ...initial, id: sharedId, status: 'accepted' };
    service.store.saveTransfer(transfer);
    await call(service, `/api/transfers/${sharedId}/upload`, peer.token, content, 'PUT');
    service.broadcast = broadcast;
    service.broadcast();
    return transfer;
  }
  try {
    for (const name of ['甲中转站', '乙中转站']) {
      const service = new RelayService(path.join(dir, name), path.resolve('dist'));
      service.store.saveSettings({ ...service.store.settings, port: 0, stationName: name });
      const originalBase = service.base.bind(service);
      service.base = async () => {
        const app = await originalBase();
        app.addHook('onSend', async (request: any, reply: any, payload: any) => {
          if (request.url.includes('/download') && payload?.pipe)
            return payload.pipe(
              new Transform({
                transform(chunk, enc, done) {
                  setTimeout(() => done(null, chunk), 50);
                },
              }),
            );
          return payload;
        });
        return app;
      };
      await service.startHub();
      const peer = await call(service, '/api/join', '', {
        id: peerId,
        name: '同名电脑',
        platform: 'PC',
        pairingToken: service.pairingToken,
      });
      peer.socket = await service.hub.injectWS('/api/ws?token=' + peer.token, {
        socket: { remoteAddress: '127.0.0.1' },
      });
      peer.identity = generateIdentity();
      await call(service, '/api/chat/key', peer.token, { publicKey: peer.identity.publicKey });
      peers.push(peer);
      services.push(service);
    }
    await launch();
    await admin('/settings', { receiveDir: path.join(dir, 'received') });
    for (const service of services) {
      await page.getByRole('button', { name: '添加中转站连接' }).click();
      await page
        .getByLabel('中转站地址或配对链接')
        .fill(
          `http://127.0.0.1:${service.hub.server.address().port}/#pair=${service.pairingToken}`,
        );
      await page.locator('dialog').getByRole('button', { name: '连接', exact: true }).click();
      await expect(page.locator('main')).toHaveAttribute('data-connected', 'true');
    }
    const boot = await page.evaluate(() => window.relay3!.bootstrap());
    await expect.poll(() => services.every((s) => s.clients.has(boot.deviceId))).toBe(true);
    await page.getByRole('button', { name: '切换中转站' }).click();
    await expect(page.getByRole('listbox', { name: '中转站列表' }).getByRole('option')).toHaveCount(
      2,
    );
    await page.getByRole('button', { name: '切换中转站' }).click();

    // 未查看的甲站收到消息，不应被乙站的阅读确认消费。
    await page.getByRole('button', { name: '群聊大厅', exact: true }).click();
    await call(services[0], '/api/chat/messages', peers[0].token, {
      clientId: randomUUID(),
      mode: 'plain',
      content: '甲站后台未读消息',
    });
    await expect.poll(() => services[0].chat.unread(boot.deviceId)).toBe(1);
    await expect(page.locator('.chat-hall:not([hidden]) .chat-feed')).not.toContainText(
      '甲站后台未读消息',
    );
    await page
      .getByLabel('文字消息', { exact: true })
      .filter({ visible: true })
      .fill('乙站独立消息');
    await page.getByRole('button', { name: '发送文字', exact: true }).click();
    await expect(page.locator('.chat-hall:not([hidden]) .chat-feed')).toContainText('乙站独立消息');
    await select(0);
    await expect(page.locator('.chat-hall:not([hidden]) .chat-feed')).toContainText(
      '甲站后台未读消息',
    );
    await expect(page.locator('.chat-hall:not([hidden]) .chat-feed')).not.toContainText(
      '乙站独立消息',
    );
    await page.getByLabel('文字消息', { exact: true }).filter({ visible: true }).fill('甲站草稿');
    await select(1);
    await page.getByLabel('文字消息', { exact: true }).filter({ visible: true }).fill('乙站草稿');
    await select(0);
    await expect(
      page.getByLabel('文字消息', { exact: true }).filter({ visible: true }),
    ).toHaveValue('甲站草稿');
    await page.getByRole('button', { name: '发送密文', exact: true }).click();
    await page
      .locator('.encrypted-compose-modal')
      .getByRole('checkbox', { name: /同名电脑/ })
      .check();
    await page
      .locator('.encrypted-compose-modal')
      .getByLabel('文字消息', { exact: true })
      .fill('只属于甲站的密文');
    await page.getByRole('button', { name: '发送密文消息', exact: true }).click();
    await expect.poll(() => services[0].chat.latest()).toBe(2);
    const cipher = (await call(services[0], '/api/chat/messages?mode=encrypted', peers[0].token))
      .items[0];
    expect(
      decryptMessage(cipher.envelope, peers[0].identity, peerId, {
        stationId: services[0].store.settings.stationId,
        senderId: boot.deviceId,
        remark: cipher.remark,
        remarkStyle: cipher.remarkStyle,
      }),
    ).toBe('只属于甲站的密文');
    expect(
      decryptMessage(cipher.envelope, peers[1].identity, peerId, {
        stationId: services[1].store.settings.stationId,
        senderId: boot.deviceId,
        remark: cipher.remark,
        remarkStyle: cipher.remarkStyle,
      }),
    ).toBe(null);

    // 先在甲站排队，再切到乙站；甲站接受后应在后台继续上传。
    await page.getByRole('button', { name: '文件传输', exact: true }).click();
    for (const index of [0, 1]) {
      await select(index);
      await page
        .locator('.delivery-recipients label')
        .filter({ hasText: '同名电脑' })
        .locator('input')
        .check();
      await page.getByLabel('选择待发送文件').setInputFiles({
        name: `发送到${index}.txt`,
        mimeType: 'text/plain',
        buffer: Buffer.from(`站${index}内容`),
      });
      await page.getByRole('button', { name: '发送', exact: true }).click();
    }
    for (const index of [0, 1]) {
      await expect
        .poll(() =>
          services[index].store
            .transfers()
            .some((t: any) => t.name === `发送到${index}.txt` && t.status === 'pending'),
        )
        .toBe(true);
      const transfer = services[index].store
        .transfers()
        .find((t: any) => t.name === `发送到${index}.txt`);
      await call(services[index], `/api/transfers/${transfer.id}/accept`, peers[index].token, {});
      await expect.poll(() => services[index].store.transfer(transfer.id).status).toBe('ready');
      expect(readFileSync(services[index].file(transfer)).toString()).toBe(`站${index}内容`);
    }

    // 两站使用相同传输 ID 并行接收，进度、临时文件与历史必须隔离。
    const id = randomUUID(),
      contents = [Buffer.alloc(2 * 1024 * 1024, 65), Buffer.alloc(2 * 1024 * 1024, 66)];
    for (const index of [0, 1]) await incoming(index, `收到${index}.bin`, contents[index], id);
    for (const index of [0, 1]) {
      await select(index);
      await page
        .locator('.transfer-row')
        .filter({ hasText: `收到${index}.bin` })
        .getByRole('button', { name: '下载文件', exact: true })
        .click();
    }
    await expect
      .poll(() => services.every((s) => s.store.transfer(id).status === 'completed'), {
        timeout: 15000,
      })
      .toBe(true);
    for (const index of [0, 1])
      expect(readFileSync(path.join(dir, 'received', `收到${index}.bin`))).toEqual(contents[index]);
    const receipts = (await admin('/received')).entries;
    expect(receipts.map((f: any) => f.stationId).sort()).toEqual(
      services.map((s) => s.store.settings.stationId).sort(),
    );
    await page.getByRole('button', { name: '收发记录', exact: true }).click();
    await expect(page.locator('.record-row')).toHaveCount(4);
    await expect(page.locator('.record-row').filter({ hasText: '收到0.bin' })).toContainText(
      '甲中转站',
    );
    await page
      .getByRole('combobox', { name: '按中转站筛选记录' })
      .selectOption(services[1].store.settings.stationId);
    await expect(page.locator('.record-row')).toHaveCount(2);
    await page.screenshot({ path: 'design/qa/multistation-history.png' });
    await page.getByRole('button', { name: '接收文件', exact: true }).click();
    await page
      .getByRole('combobox', { name: '按中转站筛选已接收文件' })
      .selectOption(services[0].store.settings.stationId);
    await expect(page.locator('.received-row')).toHaveCount(1);

    // 相同 ID 的下载取消只作用于指定站，另一站继续完成。
    const cancelId = randomUUID();
    for (const index of [0, 1])
      await incoming(index, `取消隔离${index}.bin`, contents[index], cancelId);
    const savedForCancel = Object.values(
      (await page.evaluate(() => window.relay3!.bootstrap())).savedHubs,
    );
    const sessions = services.map((s) =>
      savedForCancel.find((entry) => entry.stationId === s.store.settings.stationId)!,
    );
    const hashes = services.map((s) => s.store.transfer(cancelId).sha256);
    await page.evaluate(
      ({ sessions, hashes, id }) => {
        (window as any).parallelResults = Promise.all(
          sessions.map((session) =>
            window
              .relay3!.download({
                base: session.base,
                token: session.token,
                stationId: session.stationId,
                id,
                name: session.stationName + '-取消隔离.bin',
                size: 2 * 1024 * 1024,
                sha256: session.stationId === sessions[0].stationId ? hashes[0] : hashes[1],
              })
              .then(() => ({ stationId: session.stationId, ok: true }))
              .catch(() => ({ stationId: session.stationId, ok: false })),
          ),
        );
      },
      { sessions, hashes, id: cancelId },
    );
    await expect
      .poll(() => services.every((s) => s.store.transfer(cancelId).status === 'downloading'))
      .toBe(true);
    await page.evaluate(
      async ({ id, stationId }) => {
        await window.relay3!.cancelDownload(id, stationId);
      },
      { id: cancelId, stationId: services[0].store.settings.stationId },
    );
    const results = await page.evaluate(() => (window as any).parallelResults);
    expect(results.find((r: any) => r.stationId === services[0].store.settings.stationId).ok).toBe(
      false,
    );
    expect(results.find((r: any) => r.stationId === services[1].store.settings.stationId).ok).toBe(
      true,
    );
    expect(readFileSync(path.join(dir, 'received', '乙中转站-取消隔离.bin'))).toEqual(contents[1]);

    // 缺少来源的旧 JSON 不回填，以“其他”展示并筛选。
    const db = new DatabaseSync(path.join(dir, 'client', 'relay3.sqlite'));
    const oldRecord = {
      ...services[0].store.transfer(id),
      id: randomUUID(),
      stationId: randomUUID(),
    };
    delete oldRecord.stationName;
    db.prepare('INSERT INTO remote_records VALUES (?,?)').run('legacy', JSON.stringify(oldRecord));
    db.prepare('INSERT INTO received_files VALUES (?,?)').run(
      'legacy',
      JSON.stringify({
        id: 'legacy',
        name: '旧文件.txt',
        size: 1,
        path: '/tmp/legacy',
        receivedAt: Date.now(),
      }),
    );
    db.close();
    await page.getByRole('button', { name: '收发记录', exact: true }).click();
    await expect(
      page.getByRole('combobox', { name: '按中转站筛选记录' }).locator('option[value="other"]'),
    ).toHaveCount(1);
    await page.getByRole('combobox', { name: '按中转站筛选记录' }).selectOption('other');
    await expect(page.locator('.record-row')).toHaveCount(1);
    await expect(page.locator('.record-row')).toContainText('其他');

    // 被管理员断开后，使用原凭证显式重新连接，不影响另一站。
    services[0].detachDevice(boot.deviceId, 4003, '管理员断开连接');
    await page.getByRole('button', { name: '连接的中转站', exact: true }).click();
    await expect(page.locator('.connected-station').filter({ hasText: '甲中转站' })).toContainText(
      '需重新配对',
    );
    await page.getByRole('button', { name: '重新配对', exact: true }).click();
    await page.locator('dialog').getByRole('button', { name: '连接', exact: true }).click();
    await expect.poll(() => services.every((s) => s.clients.has(boot.deviceId))).toBe(true);
    await expect(page.locator('main')).toHaveAttribute('data-connected', 'true');
    await page.setViewportSize({ width: 800, height: 600 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    const footer = await page.locator('.sidebar-bottom').boundingBox();
    expect(footer!.y + footer!.height).toBeLessThanOrEqual(600);
    await page.screenshot({ path: 'design/qa/multistation-compact.png' });
    await page.setViewportSize({ width: 1220, height: 808 });

    // 单站断网/恢复时另一站仍在线，重启恢复两条连接和选中页面。
    await services[0].stopHub(true);
    await select(1);
    await expect(page.locator('main')).toHaveAttribute('data-connected', 'true');
    await page.getByRole('button', { name: '连接的中转站', exact: true }).click();
    await expect(page.locator('.connected-station').filter({ hasText: '甲中转站' })).toContainText(
      '重连中',
    );
    // 使用保存的原监听端口重新启动，客户端自动重连。
    const saved = Object.values(
      (await page.evaluate(() => window.relay3!.bootstrap())).savedHubs,
    ).find((s: any) => s.stationId === services[0].store.settings.stationId)!;
    services[0].store.settings.port = Number(new URL(saved.base).port);
    await services[0].startHub();
    await expect.poll(() => services[0].clients.has(boot.deviceId), { timeout: 15000 }).toBe(true);
    await page.screenshot({ path: 'design/qa/multistation-connections.png' });
    await select(1);
    await page.getByRole('button', { name: '群聊大厅', exact: true }).click();
    await application!.close();
    application = undefined;
    await launch();
    await expect.poll(() => services.every((s) => s.clients.has(boot.deviceId))).toBe(true);
    await expect(page.getByRole('button', { name: '切换中转站' })).toHaveAttribute(
      'data-station-id',
      services[1].store.settings.stationId,
    );
    await expect(page.locator('.chat-hall:not([hidden])')).toBeVisible();
    await page.getByRole('button', { name: '连接的中转站', exact: true }).click();
    await page.getByRole('button', { name: '断开甲中转站', exact: true }).click();
    await page.getByRole('button', { name: '取消传输并断开', exact: true }).click();
    await expect.poll(() => services[0].clients.has(boot.deviceId)).toBe(false);
    expect(services[1].clients.has(boot.deviceId)).toBe(true);
    await page.getByRole('button', { name: '忘记配对甲中转站' }).click();
    await page.getByRole('button', { name: '确认忘记配对' }).click();
    expect(
      Object.values((await page.evaluate(() => window.relay3!.bootstrap())).savedHubs).some(
        (s) => s.stationId === services[0].store.settings.stationId,
      ),
    ).toBe(false);
    expect((await admin('/records')).total).toBe(7);
    expect(errors).toEqual([]);
  } finally {
    await application?.close();
    for (const peer of peers) peer.socket.terminate();
    for (const service of services) await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
