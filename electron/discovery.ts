import Bonjour from 'bonjour-service';
import { isIPv4 } from 'node:net';
import { EventEmitter } from 'node:events';
import type { DiscoverySnapshot, DiscoveredStation } from '../src/discoveryTypes';
import { diagnostic } from '../server/diagnostics';

const serviceType = 'relay3';
type Hub = { stationId: string; name: string; port: number; platform: 'PC' | 'Mac' };
type Offer = { station: DiscoveredStation; addresses: string[]; seenAt: number; pending: boolean };

export function localAddress(address: string) {
  if (!isIPv4(address)) return false;
  const [a, b] = address.split('.').map(Number);
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || a === 127;
}

// 不发送凭证、不跟随重定向、不读取任意路径；响应体和等待时间均有上限。
export async function probeStation(
  base: string,
  signal: AbortSignal,
  fetchInfo = fetch,
): Promise<any> {
  const response = await fetchInfo(base + '/api/info', {
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.any([signal, AbortSignal.timeout(1800)]),
  });
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel();
    throw new Error('中转站未响应');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 16_384) throw new Error('中转站响应过大');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class StationDiscovery {
  private bonjour?: Bonjour;
  private published?: Bonjour.Service;
  private browser?: Bonjour.Browser;
  private hub?: Hub;
  private signature = '';
  private browsing = false;
  private timer?: NodeJS.Timeout;
  private offers = new Map<string, Offer>();
  private controllers = new Set<AbortController>();
  private stopping = new Set<Promise<void>>();
  private workers = 0;
  private generation = 0;
  private error?: string;

  constructor(
    private createBonjour = (onError: (error: Error) => void) => {
      const bonjour = new Bonjour({}, onError);
      // 1.4.4 的 errorCallback 只覆盖发送响应的错误，UDP bind 错误仍由底层发出。
      const mdns = (bonjour as unknown as { server: { mdns: EventEmitter } }).server.mdns;
      mdns.on('error', onError);
      mdns.on('warning', (error) => diagnostic('warn', 'discovery.udp-warning', { error }));
      return bonjour;
    },
    private probe = probeStation,
  ) {}

  private ensure() {
    if (!this.bonjour) {
      this.error = undefined;
      this.bonjour = this.createBonjour((error) => {
        this.error = '局域网发现不可用，请检查网络权限或手动输入地址。';
        diagnostic('warn', 'discovery.mdns-failed', { error });
      });
    }
    return this.bonjour;
  }

  publish(hub?: Hub) {
    const signature = JSON.stringify(hub);
    if (this.signature === signature) return;
    this.signature = signature;
    this.hub = hub;
    if (this.published) {
      const previous = this.published;
      previous.destroyed = true;
      const stopping = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 500);
        previous.stop(() => {
          clearTimeout(timer);
          resolve();
        });
      });
      this.stopping.add(stopping);
      void stopping.then(() => {
        this.stopping.delete(stopping);
        if (!this.hub && !this.browsing) this.destroySocket();
      });
    }
    this.published = undefined;
    if (hub) {
      try {
        this.published = this.ensure().publish({
          name: 'Relay3-' + hub.stationId,
          host: 'relay3-' + hub.stationId + '.local',
          type: serviceType,
          protocol: 'tcp',
          port: hub.port,
          disableIPv6: true,
          // stationId 为持久化随机 UUID，避免重复名称，也无需名称竞争探测。
          probe: false,
          txt: {
            app: 'Relay3',
            version: '1',
            stationId: hub.stationId,
            name: hub.name,
            platform: hub.platform,
          },
        });
        this.published.on('error', (error) => {
          diagnostic('warn', 'discovery.publish-failed', { error });
        });
      } catch (error) {
        diagnostic('warn', 'discovery.publish-failed', { error });
      }
    } else if (!this.browsing) this.destroySocket();
  }

  start() {
    if (!this.browsing) {
      this.browsing = true;
      this.scan();
      this.timer = setInterval(() => this.scan(), 10_000);
      this.timer.unref();
    }
    return this.snapshot();
  }

  refresh() {
    this.start();
    this.scan();
    return this.snapshot();
  }

  private scan() {
    if (!this.browsing) return;
    // 重新查询以接收网卡、IP 和 TXT 的变化，也避免依赖远端发送退出广播。
    this.browser?.stop();
    this.browser?.removeAllListeners();
    try {
      this.browser = this.ensure().find({ type: serviceType, protocol: 'tcp' });
      this.browser.on('up', (service) => this.offer(service));
      this.browser.on('txt-update', (service) => this.offer(service));
      this.browser.on('srv-update', (service) => this.offer(service));
      this.browser.on('down', (service) => this.offers.delete(service.fqdn));
    } catch (error) {
      this.error = '局域网发现不可用，请手动输入地址。';
      diagnostic('warn', 'discovery.browse-failed', { error });
    }
    for (const [key, offer] of this.offers) {
      if (Date.now() - offer.seenAt > 35_000) this.offers.delete(key);
      else offer.pending = true;
    }
    this.drain();
  }

  private offer(service: Bonjour.Service) {
    const txt = service.txt;
    if (
      !this.browsing ||
      service.type !== serviceType ||
      service.protocol !== 'tcp' ||
      txt?.app !== 'Relay3' ||
      txt?.version !== '1' ||
      typeof txt.stationId !== 'string' ||
      !/^[a-zA-Z0-9-]{16,80}$/.test(txt.stationId) ||
      typeof txt.name !== 'string' ||
      !txt.name.trim() ||
      txt.name.length > 80 ||
      !Number.isInteger(service.port) ||
      service.port < 1 ||
      service.port > 65535 ||
      typeof service.fqdn !== 'string' ||
      service.fqdn.length > 255 ||
      (!this.offers.has(service.fqdn) && this.offers.size >= 32)
    )
      return;
    const addresses = [...new Set([...(service.addresses ?? []), service.referer?.address ?? ''])]
      .filter(localAddress)
      .slice(0, 8)
      .map((ip) => `http://${ip}:${service.port}`);
    if (!addresses.length) return;
    const previous = this.offers.get(service.fqdn);
    this.offers.set(service.fqdn, {
      station: {
        stationId: txt.stationId,
        name: txt.name.trim(),
        platform: txt.platform === 'Mac' ? 'Mac' : 'PC',
        base: addresses.includes(previous?.station.base ?? '')
          ? previous!.station.base
          : addresses[0],
        state: 'checking',
      },
      addresses,
      seenAt: Date.now(),
      pending: true,
    });
    this.drain();
  }

  private drain() {
    while (this.browsing && this.workers < 4) {
      const next = [...this.offers.entries()].find(([, offer]) => offer.pending);
      if (!next) break;
      const [, offer] = next;
      offer.pending = false;
      this.workers++;
      const generation = this.generation;
      void this.verify(offer, generation).finally(() => {
        this.workers--;
        this.drain();
      });
    }
  }

  private async verify(offer: Offer, generation: number) {
    const candidates = [
      offer.station.base,
      ...offer.addresses.filter((base) => base !== offer.station.base),
    ];
    for (const base of candidates) {
      if (!this.browsing || generation !== this.generation) return;
      const controller = new AbortController();
      this.controllers.add(controller);
      try {
        const info = await this.probe(base, controller.signal);
        if (generation !== this.generation) return;
        if (
          info.app !== 'Relay3' ||
          info.running !== true ||
          info.stationId !== offer.station.stationId ||
          typeof info.name !== 'string' ||
          !info.name.trim() ||
          info.name.length > 80 ||
          !Number.isInteger(info.onlineDevices) ||
          info.onlineDevices < 0
        )
          continue;
        offer.station = {
          ...offer.station,
          base,
          name: info.name.trim(),
          state: 'ready',
          onlineDevices: info.onlineDevices,
        };
        return;
      } catch {
        // 某张网卡不可达时继续验证其他候选，不把广播当成连接成功。
      } finally {
        this.controllers.delete(controller);
      }
    }
    offer.station = { ...offer.station, state: 'unreachable', onlineDevices: undefined };
  }

  snapshot(): DiscoverySnapshot {
    const unique = new Map<string, DiscoveredStation>();
    for (const { station } of this.offers.values()) {
      const old = unique.get(station.stationId);
      if (!old || station.state === 'ready' || old.state === 'unreachable')
        unique.set(station.stationId, station);
    }
    return {
      stations: [...unique.values()].sort(
        (a, b) =>
          Number(b.state === 'ready') - Number(a.state === 'ready') ||
          a.name.localeCompare(b.name, 'zh-CN'),
      ),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  stop() {
    this.browsing = false;
    this.generation++;
    clearInterval(this.timer);
    this.browser?.stop();
    this.browser?.removeAllListeners();
    this.browser = undefined;
    for (const controller of this.controllers) controller.abort();
    this.offers.clear();
    if (!this.hub) this.destroySocket();
  }

  private destroySocket() {
    if (this.stopping.size) return;
    this.bonjour?.destroy();
    this.bonjour = undefined;
  }

  async close() {
    this.publish(undefined);
    this.stop();
    await Promise.all(this.stopping);
    this.destroySocket();
  }
}
