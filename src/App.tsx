import { ScrollArea } from './components/ScrollArea';
import { version as appVersion } from '../package.json';
import { reportException } from './diagnostics';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  MessageSquare,
  Info,
  Github,
  ArrowUpRight,
  ArrowDownLeft,
  ArrowLeftRight,
  HardDrive,
  Radio,
  Monitor,
  Smartphone,
  History,
  Settings,
  FolderOpen,
  Upload,
  File,
  X,
  Check,
  Unplug,
  RefreshCw,
  Copy,
  Search,
  Trash2,
  Link,
  Wifi,
  AlertCircle,
  Download,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import QRCode from 'qrcode';
import { browserPlatformInfo } from './devicePlatform';
import { DeviceTag, browserPlatform } from './components/DeviceTag';
import { DeviceSelect } from './components/DeviceSelect';
import { SavedStations } from './components/SavedStations';
import { NearbyStations } from './components/NearbyStations';
import { useConnections } from './useConnections';
import { ConnectedStations, connectionLabels } from './components/ConnectedStations';
import type { DiscoveredStation } from './discoveryTypes';
import { DeviceAvatar } from './components/DeviceAvatar';
import { ChatHall } from './chat/ChatHall';
import {
  request,
  uuid,
  stored,
  save,
  sizes,
  date,
  duration,
  labels,
  active,
  type Session,
  type HubState,
  type Bootstrap,
  type AdminState,
  type CacheState,
  type Transfer,
  type Device,
} from './api';

type Page =
  'chat' | 'transfer' | 'station' | 'devices' | 'history' | 'storage' | 'settings' | 'connections';
const pageInfo: Record<Page, [string, string]> = {
  chat: ['群聊大厅', '连接设备的文字交流与历史。'],
  transfer: ['文件传输', '选择设备，把文件送过去。'],
  connections: ['连接的中转站', '管理各中转站的连接与配对。'],
  station: ['本机中转站', '让这台电脑成为局域网里的接力点。'],
  devices: ['连接设备', '查看当前连接与历史连接记录。'],
  history: ['收发记录', '每一次发送和接收，都留有记录。'],
  storage: ['本机存储', '查看占用空间，管理中转站暂存文件。'],
  settings: ['应用设置', '设备名称、保存位置与清理规则。'],
};
function Empty({
  icon = <File size={28} />,
  title,
  children,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      {icon}
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  );
}
function Badge({ status }: { status: string }) {
  return (
    <span
      className={`badge ${status === 'completed' || status === 'online' ? 'positive' : status === 'failed' ? 'negative' : ''}`}
    >
      {status === 'online'
        ? '已连接'
        : status === 'offline'
          ? '已断开'
          : (labels[status] ?? status)}
    </span>
  );
}
function Button({
  children,
  onClick,
  disabled = false,
  kind = '',
  title,
  type = 'button',
  form,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  kind?: string;
  title?: string;
  type?: 'button' | 'submit';
  form?: string;
}) {
  return (
    <button
      type={type}
      form={form}
      title={title}
      className={`button ${kind}`}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
function Modal({
  title,
  children,
  actions,
  onClose,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current!;
    const opener = document.activeElement as HTMLElement | null;
    d.showModal();
    return () => {
      d.close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="app-dialog"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="dialog-head">
        <h2>{title}</h2>
        <Button title="关闭" onClick={onClose}>
          <X size={18} />
        </Button>
      </div>
      <div className="dialog-body">{children}</div>
      {actions && <div className="dialog-footer">{actions}</div>}
    </dialog>
  );
}

export default function App() {
  const desktop = !!window.relay3;
  const [boot, setBoot] = useState<Bootstrap | null>(null),
    [admin, setAdmin] = useState<AdminState | null>(null),
    [page, setPage] = useState<Page>('transfer');
  const multi = useConnections(desktop, inform);
  const { session, hub, connected } = multi;
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!notice || notice.error) return;
    const timer = setTimeout(() => setNotice(null), 3500);
    return () => clearTimeout(timer);
  }, [notice]);
  const [modal, setModal] = useState<
    | null
    | 'about'
    | 'connect'
    | 'clearRecords'
    | 'clearDevices'
    | 'clearCache'
    | 'stop'
    | 'clearReceived'
    | 'resetIdentity'
    | 'removeDevice'
    | 'copy'
    | 'storageLocations'
    | 'disconnectStation'
    | 'forgetStation'
  >(null);
  const [targetStation, setTargetStation] = useState('');
  const [historyStation, setHistoryStation] = useState('all');
  const [historyStations, setHistoryStations] = useState<{ id: string; name: string }[]>([]);
  const [receivedStation, setReceivedStation] = useState('all');
  const [clearHours, setClearHours] = useState(24);
  const [removeDevice, setRemoveDevice] = useState<Device | null>(null);
  const [copyValue, setCopyValue] = useState('');
  const mobileId = useRef(stored('relay3-device-id', '') || uuid()),
    [deviceName, setDeviceName] = useState(
      stored(
        'relay3-device-name',
        /iPhone|iPad/.test(navigator.userAgent)
          ? '我的 iPhone'
          : /Android/.test(navigator.userAgent)
            ? '我的手机'
            : '浏览器设备',
      ),
    );
  const [connectUrl, setConnectUrl] = useState(desktop ? '' : location.origin),
    [pairing, setPairing] = useState(new URLSearchParams(location.hash.slice(1)).get('pair') ?? '');
  const [discoveredSelection, setDiscoveredSelection] = useState<DiscoveredStation | null>(null);
  const [transferDrafts, setTransferDrafts] = useState<
    Record<string, { recipient: string; files: File[] }>
  >({});
  const recipient = transferDrafts[multi.activeId]?.recipient ?? '';
  const files = transferDrafts[multi.activeId]?.files ?? [];
  const setRecipient = (recipient: string) =>
    setTransferDrafts((old) => ({
      ...old,
      [multi.activeId]: { files: old[multi.activeId]?.files ?? [], recipient },
    }));
  const setFiles = (files: File[] | ((old: File[]) => File[])) =>
    setTransferDrafts((old) => ({
      ...old,
      [multi.activeId]: {
        recipient: old[multi.activeId]?.recipient ?? '',
        files: typeof files === 'function' ? files(old[multi.activeId]?.files ?? []) : files,
      },
    }));
  const [progress, setProgress] = useState<Record<string, number>>({}),
    [savedPaths, setSavedPaths] = useState<Record<string, string>>({});
  const [receivingKeys, setReceivingKeys] = useState<string[]>([]);
  const pendingFiles = useRef(new Map<string, File>()),
    uploads = useRef(new Map<string, XMLHttpRequest>());
  const [received, setReceived] = useState<
      {
        id: string;
        name: string;
        path: string;
        size: number;
        receivedAt: number;
        exists: boolean;
        stationId?: string;
        stationName?: string;
      }[]
    >([]),
    [receivedSelected, setReceivedSelected] = useState<string[]>([]);
  const [cache, setCache] = useState<CacheState | null>(null),
    [selected, setSelected] = useState<string[]>([]);
  const [records, setRecords] = useState<Transfer[]>([]),
    [total, setTotal] = useState(0),
    [offset, setOffset] = useState(0),
    [search, setSearch] = useState('');
  const [historyLoadedKey, setHistoryLoadedKey] = useState('');

  const [qr, setQr] = useState(''),
    [address, setAddress] = useState(''),
    [filter, setFilter] = useState('all');
  const historyScrollKey = `history:${historyStation}:${filter}:${search}:${offset}`;
  const [form, setForm] = useState({
    deviceName: '',
    stationName: '',
    port: 42830,
    retentionHours: 1,
    cacheDir: '',
    receiveDir: '',
  });
  const [diagnosticState, setDiagnosticState] = useState<{
    path: string;
    crashPath: string;
    bytes: number;
  } | null>(null);
  useEffect(() => {
    if (page === 'settings' && window.relay3)
      void run(async () => setDiagnosticState(await window.relay3!.diagnosticInfo()));
  }, [page]);
  const [savedHubs, setSavedHubs] = useState<Record<string, Session>>(stored('relay3-hubs', {}));
  const restored = useRef(false);
  function inform(text: string, error = false) {
    setNotice({ text, error });
  }
  async function run(fn: () => Promise<any>) {
    setBusy(true);
    try {
      await fn();
    } catch (e: any) {
      reportException('ui.operation-failed', e);
      inform(e.message, true);
    } finally {
      setBusy(false);
    }
  }
  async function management<T = any>(url: string, body?: unknown) {
    if (!boot) throw new Error('桌面管理服务尚未就绪');
    return request<T>(boot.controlUrl, boot.adminToken, '/admin' + url, body);
  }
  async function refreshAdmin() {
    if (boot) setAdmin(await management<AdminState>('/status'));
  }
  async function action(t: Transfer, a: string) {
    if (!session) return;
    await request(session.base, session.token, `/api/transfers/${t.id}/${a}`, {});
    if (a === 'cancel') {
      uploads.current.get(`${session.stationId}:${t.id}`)?.abort();
      await window.relay3?.cancelDownload(t.id, session.stationId);
      pendingFiles.current.delete(`${session.stationId}:${t.id}`);
    }
  }
  useEffect(() => {
    save('relay3-device-id', mobileId.current);
    if (desktop)
      window
        .relay3!.bootstrap()
        .then((next) => {
          const migrated = Object.fromEntries(
            Object.entries(savedHubs).filter(([, s]) => s.id === next.deviceId),
          );
          setSavedHubs({ ...migrated, ...next.savedHubs });
          setBoot(next);
          if (!restored.current) {
            restored.current = true;
            for (const saved of Object.values(next.savedHubs))
              if (saved.autoConnect) multi.add(saved, null, false);
            if (
              next.clientView?.stationId &&
              Object.values(next.savedHubs).some(
                (s) => s.autoConnect && s.stationId === next.clientView!.stationId,
              )
            )
              multi.select(next.clientView.stationId);
            if (next.clientView?.page && next.clientView.page in pageInfo)
              setPage(next.clientView.page as Page);
          }
        })
        .catch((e) => inform(e.message, true));
    else {
      const old = stored<Session | null>('relay3-session', null);
      if (old?.base === location.origin) multi.add(old);
    }
  }, []);
  useEffect(() => {
    if (!boot) return;
    setDeviceName(boot.deviceName);
    const poll = () => refreshAdmin().catch((e) => inform(e.message, true));
    void poll();
    const timer = setInterval(poll, 2000);
    return () => clearInterval(timer);
  }, [boot]);
  useEffect(() => {
    if (admin) setForm({ ...admin.settings });
  }, [
    admin?.settings.deviceName,
    admin?.settings.stationName,
    admin?.settings.port,
    admin?.settings.retentionHours,
    admin?.settings.cacheDir,
    admin?.settings.receiveDir,
  ]);
  useEffect(() => {
    if (desktop && boot && restored.current) {
      save('relay3-session', session);
      void management('/client/view', { stationId: multi.activeId, page }).catch(() => {});
    }
  }, [desktop, boot, multi.activeId, page]);
  useEffect(() => {
    for (const connection of Object.values(multi.connections)) {
      const { hub, session } = connection;
      if (!hub) continue;
      if (boot) void management('/remember', { records: hub.transfers }).catch(() => {});
      for (const t of hub.transfers) {
        const key = `${session.stationId}:${t.id}`;
        if (
          t.status === 'accepted' &&
          t.senderId === session.id &&
          pendingFiles.current.has(key) &&
          !uploads.current.has(key)
        ) {
          const file = pendingFiles.current.get(key)!;
          const xhr = new XMLHttpRequest();
          uploads.current.set(key, xhr);
          xhr.open('PUT', `${session.base}/api/transfers/${t.id}/upload`);
          xhr.setRequestHeader('Authorization', `Bearer ${session.token}`);
          xhr.setRequestHeader('Content-Type', 'application/octet-stream');
          xhr.upload.onprogress = (e) => setProgress((p) => ({ ...p, [key]: e.loaded }));
          xhr.onload = () => {
            uploads.current.delete(key);
            pendingFiles.current.delete(key);
            if (xhr.status >= 400) {
              try {
                inform(JSON.parse(xhr.responseText).error, true);
              } catch {
                inform('上传失败，请重新发送', true);
              }
            }
          };
          xhr.onerror = () => {
            uploads.current.delete(key);
            pendingFiles.current.delete(key);
            inform('上传连接中断，请重新发送', true);
          };
          xhr.onabort = () => {
            uploads.current.delete(key);
            pendingFiles.current.delete(key);
          };
          xhr.send(file);
        }
        if (!active.includes(t.status)) {
          pendingFiles.current.delete(key);
          if (uploads.current.has(key)) uploads.current.get(key)?.abort();
        }
      }
    }
  }, [multi.connections, boot]);
  useEffect(
    () =>
      window.relay3?.onProgress((p) =>
        setProgress((old) => ({ ...old, [p.key ?? `${p.stationId}:${p.id}`]: p.bytes })),
      ),
    [],
  );
  useEffect(() => {
    if (page !== 'storage' || !boot) return;
    const poll = () =>
      Promise.all([
        management<CacheState>('/cache').then(setCache),
        management('/received').then((r) => setReceived(r.entries)),
      ]).catch((e) => inform(e.message, true));
    void poll();
    const timer = setInterval(poll, 2000);
    return () => clearInterval(timer);
  }, [page, boot]);
  useEffect(() => {
    if (page !== 'history') return;
    let dead = false;
    const poll = async () => {
      try {
        const q = `?offset=${offset}&search=${encodeURIComponent(search)}&direction=${filter}&station=${encodeURIComponent(historyStation === 'all' ? '' : historyStation)}`;
        const result = boot
          ? await management('/records' + q)
          : session
            ? await request(session.base, session.token, '/api/history' + q)
            : { items: [], total: 0 };
        if (!dead) {
          setRecords(result.items);
          setHistoryLoadedKey(historyScrollKey);
          setTotal(result.total);
          setHistoryStations(result.stations ?? []);
        }
      } catch (e: any) {
        if (!dead) inform(e.message, true);
      }
    };
    void poll();
    const timer = setInterval(poll, 2000);
    return () => {
      dead = true;
      clearInterval(timer);
    };
  }, [page, boot, session, offset, search, filter, historyStation]);
  useEffect(() => {
    if (!admin?.running) {
      setQr('');
      return;
    }
    const a = admin.addresses.includes(address)
      ? address
      : (admin.addresses[0] ?? `http://127.0.0.1:${admin.settings.port}`);
    setAddress(a);
    QRCode.toDataURL(`${a}/#pair=${admin.pairingToken}`, {
      width: 220,
      margin: 1,
      color: { dark: '#263544', light: '#fafbfc' },
    }).then(setQr);
  }, [admin?.running, admin?.pairingToken, JSON.stringify(admin?.addresses), address]);
  async function join(baseInput = connectUrl, codeInput = pairing) {
    let u: URL;
    try {
      u = new URL(baseInput);
    } catch {
      throw new Error('请输入完整地址，例如 http://192.168.1.8:42830');
    }
    if (u.protocol !== 'http:') throw new Error('请输入局域网 HTTP 地址');
    const base = u.origin,
      code = new URLSearchParams(u.hash.slice(1)).get('pair') ?? codeInput;
    const id = boot?.deviceId ?? mobileId.current;
    const discovered = discoveredSelection?.base === base ? discoveredSelection : null;
    if (discovered) {
      const response = await fetch(base + '/api/info', {
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(3500),
      });
      const info = await response.json();
      if (
        !response.ok ||
        info.app !== 'Relay3' ||
        info.running !== true ||
        info.stationId !== discovered.stationId
      )
        throw new Error('中转站已变化或无法访问，请刷新附近中转站后重试');
    }
    const old = discovered
      ? Object.values(savedHubs).find((s) => s.id === id && s.stationId === discovered.stationId)
      : savedHubs[base]?.id === id
        ? savedHubs[base]
        : undefined;
    const body = {
      id,
      name: deviceName,
      ...(boot
        ? { platform: boot.platform, platformSource: 'native' }
        : {
            platform: browserPlatformInfo().platform,
            platformSource: browserPlatformInfo().source,
          }),
    };
    const pairingBody = /^\d{6}$/.test(code.trim())
      ? { pairingCode: code.trim() }
      : { pairingToken: code };
    let result;
    try {
      result = await request<any>(base, old?.token ?? '', '/api/join', {
        ...body,
        ...(old?.token ? {} : pairingBody),
      });
    } catch (e: any) {
      if (!old?.token || e.status !== 401 || !code.trim()) throw e;
      result = await request<any>(base, '', '/api/join', { ...body, ...pairingBody });
    }
    await rememberConnection(base, result);
  }
  async function joinLocal() {
    const result = await management('/client/join-local', {});
    await rememberConnection(result.base, result);
  }
  async function rememberConnection(base: string, result: any) {
    const id = boot?.deviceId ?? mobileId.current;
    const next = {
      base,
      token: result.token,
      id,
      stationId: result.stationId,
      stationName: result.stationName,
      autoConnect: desktop,
    };
    if (desktop) await management('/client/session', next);
    multi.add(next, result);
    save('relay3-session', next);
    const remembered = {
      ...Object.fromEntries(
        Object.entries(savedHubs).filter(([, s]) => s.stationId !== next.stationId),
      ),
      [base]: next,
    };
    setSavedHubs(remembered);
    save('relay3-hubs', remembered);
    save('relay3-device-name', deviceName);
    setModal(null);
    history.replaceState(null, '', location.pathname);
    inform('已连接中转站');
  }
  async function disconnectStation(id: string) {
    const connection = multi.current.current[id];
    if (!connection) return;
    if (desktop) await management('/client/state', { stationId: id, autoConnect: false });
    for (const t of connection.hub?.transfers ?? []) {
      if (!active.includes(t.status)) continue;
      const key = `${id}:${t.id}`;
      uploads.current.get(key)?.abort();
      uploads.current.delete(key);
      pendingFiles.current.delete(key);
      await window.relay3?.cancelDownload(t.id, id);
      if (connection.status === 'connected')
        await request(
          connection.session.base,
          connection.session.token,
          `/api/transfers/${t.id}/cancel`,
          {},
        ).catch(() => {});
    }
    multi.remove(id);
    if (!desktop) save('relay3-session', null);
    setSavedHubs((old) =>
      Object.fromEntries(
        Object.entries(old).map(([base, s]) => [
          base,
          s.stationId === id ? { ...s, autoConnect: false } : s,
        ]),
      ),
    );
  }
  function disconnect(id = multi.activeId) {
    if (!id) return;
    const active = multi.current.current[id]?.hub?.transfers.some((t) =>
      ['pending', 'accepted', 'uploading', 'downloading', 'ready', 'awaiting-confirm'].includes(
        t.status,
      ),
    );
    if (active) {
      setTargetStation(id);
      setModal('disconnectStation');
    } else void run(() => disconnectStation(id));
  }
  async function send() {
    if (!session || !connected || !recipient) return;
    for (const file of files) {
      const t = await request<Transfer>(session.base, session.token, '/api/transfers', {
        name: file.name,
        size: file.size,
        recipientId: recipient,
      });
      pendingFiles.current.set(`${session.stationId}:${t.id}`, file);
    }
    setFiles([]);
    inform('已发送请求，等待对方确认');
    const state = await request<HubState>(session.base, session.token, '/api/state');
    multi.updateHub(session.stationId, state);
  }
  async function receive(t: Transfer) {
    if (!session) return;
    if (window.relay3) {
      const key = `${session.stationId}:${t.id}`;
      if (receivingKeys.includes(key)) return;
      setReceivingKeys((old) => [...old, key]);
      try {
        const result = await window.relay3.download({
          base: session.base,
          token: session.token,
          id: t.id,
          name: t.name,
          size: t.size,
          sha256: t.sha256!,
          stationId: session.stationId,
          stationName: t.stationName ?? session.stationName,
        });
        setSavedPaths((p) => ({ ...p, [`${session.stationId}:${t.id}`]: result.path }));
        inform(
          `${session.stationName}：` +
            (result.confirmed ? '文件已保存并校验完成' : '文件已保存，请点击“确认收到”完成记录'),
        );
      } finally {
        setReceivingKeys((old) => old.filter((id) => id !== key));
      }
    } else {
      const a = document.createElement('a');
      a.href = `${session.base}/api/transfers/${t.id}/download?token=${encodeURIComponent(session.token)}`;
      a.download = t.name;
      a.click();
      inform('下载后请点击“确认收到”');
    }
  }
  async function copy(text: string) {
    if (window.relay3) {
      await window.relay3.copyText(text);
      inform('已复制');
      return;
    }
    try {
      if (!navigator.clipboard?.writeText) throw new Error('剪贴板不可用');
      await navigator.clipboard.writeText(text);
      inform('已复制');
      return;
    } catch {}
    const el = document.createElement('textarea');
    el.value = text;
    el.className = 'clipboard-fallback';
    document.body.append(el);
    el.focus();
    el.select();
    el.setSelectionRange(0, text.length);
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch {}
    el.remove();
    if (copied) inform('已复制');
    else {
      setCopyValue(text);
      setModal('copy');
    }
  }
  async function resetIdentity() {
    let remoteRevoked = true;
    for (const connection of Object.values(multi.current.current)) {
      const s = connection.session;
      if (connection.status === 'connected') {
        try {
          await request(s.base, s.token, '/api/identity/reset', {});
        } catch {
          remoteRevoked = false;
        }
      } else remoteRevoked = false;
      await disconnectStation(s.stationId);
    }
    setSavedHubs({});
    save('relay3-hubs', {});
    setPairing('');
    history.replaceState(null, '', location.pathname);
    if (desktop) {
      const next = await management<AdminState>('/identity/reset', {});
      setAdmin(next);
      setBoot(await window.relay3!.bootstrap());
    } else {
      mobileId.current = uuid();
      save('relay3-device-id', mobileId.current);
      setRecords([]);
      setTotal(0);
    }
    setFiles([]);
    setRecipient('');
    inform(
      '设备身份已更换，请使用新的配对码重新连接' +
        (remoteRevoked ? '' : '；原中转站不可达，可在其设备列表清除旧身份'),
    );
  }
  const online = hub?.devices.filter((d) => d.id !== session?.id) ?? [];
  const transfers = hub?.transfers.filter((t) => active.includes(t.status)) ?? [];
  const nav = [
    { id: 'transfer' as Page, label: '文件传输', icon: ArrowLeftRight },
    { id: 'chat' as Page, label: '群聊大厅', icon: MessageSquare },
    { id: 'history' as Page, label: '收发记录', icon: History },
    { id: 'connections' as Page, label: '连接的中转站', icon: Link },
    { id: 'station' as Page, label: '本机中转站', icon: Radio },
    { id: 'devices' as Page, label: '连接设备', icon: Monitor },
    { id: 'storage' as Page, label: '本机存储', icon: HardDrive },
    { id: 'settings' as Page, label: '设置', icon: Settings },
  ].filter((n) => desktop || ['transfer', 'chat', 'history', 'settings'].includes(n.id));
  const historyRows = records;
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="device-self">
          <DeviceAvatar
            id={boot?.deviceId ?? mobileId.current}
            name={boot?.deviceName ?? deviceName}
          />
          <div>
            <strong>
              {boot?.deviceName ?? deviceName}
              <DeviceTag platform={boot?.platform ?? browserPlatform()} />
            </strong>
            <small>{desktop ? '桌面终端' : '手机客户端'}</small>
          </div>
        </div>
        {desktop && (
          <div className="station-switcher">
            <label htmlFor="active-station">当前中转站</label>
            <select
              id="active-station"
              aria-label="切换中转站"
              value={multi.activeId}
              disabled={!Object.keys(multi.connections).length}
              onChange={(event) => multi.select(event.target.value)}
            >
              {!Object.keys(multi.connections).length && <option value="">选择中转站</option>}
              {Object.values(multi.connections).map((c) => (
                <option key={c.session.stationId} value={c.session.stationId}>
                  {c.session.stationName} · {connectionLabels[c.status]}
                  {c.hub?.chatUnread ? ` · ${c.hub.chatUnread} 未读` : ''}
                </option>
              ))}
            </select>
            <button type="button" onClick={() => setModal('connect')} aria-label="添加中转站连接">
              <Link size={14} />
              连接其他中转站
            </button>
          </div>
        )}
        <nav aria-label="主导航">
          {nav.map(({ id, label, icon: Icon }) => (
            <div key={id} className="nav-entry">
              {desktop && id === 'transfer' && (
                <span className="nav-group-label">中转站客户端</span>
              )}
              {desktop && id === 'station' && (
                <span className="nav-group-label">本机中转站管理</span>
              )}
              {desktop && id === 'storage' && <span className="nav-group-label">本机</span>}
              <button
                key={id}
                aria-label={label}
                title={label}
                className={page === id ? 'nav-item active' : 'nav-item'}
                onClick={() => setPage(id)}
                aria-current={page === id ? 'page' : undefined}
              >
                <Icon size={19} />
                <span>{label}</span>
                {id === 'chat' &&
                  Object.values(multi.connections).some((c) => (c.hub?.chatUnread ?? 0) > 0) && (
                    <span className="count">
                      {Object.values(multi.connections).reduce(
                        (n, c) => n + (c.hub?.chatUnread ?? 0),
                        0,
                      )}
                    </span>
                  )}
                {id === 'transfer' && transfers.length > 0 && (
                  <span className="count">{transfers.length}</span>
                )}
              </button>
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="version">Relay3 {boot?.version ?? appVersion}</span>
          <div className="sidebar-utilities">
            <button title="关于 Relay3" aria-label="关于 Relay3" onClick={() => setModal('about')}>
              <Info size={17} />
            </button>
            <button
              title="项目 GitHub"
              aria-label="项目 GitHub"
              onClick={() =>
                desktop
                  ? void run(() => window.relay3!.openGithub())
                  : window.open(
                      'https://github.com/nekomorph-woo/relay3',
                      '_blank',
                      'noopener,noreferrer',
                    )
              }
            >
              <Github size={17} />
            </button>
          </div>
        </div>
      </aside>
      <div className="workspace">
        <main
          className={`native-page ${page}-workspace`}
          data-connected={connected ? 'true' : 'false'}
        >
          <div className="page-head" hidden={page === 'chat' && !!session}>
            <h1>{pageInfo[page][0]}</h1>
            <div className="page-actions">
              {session ? (
                <Button onClick={() => disconnect()} title="断开当前中转站">
                  <Unplug size={16} />
                  断开中转站
                </Button>
              ) : (
                <Button onClick={() => setModal('connect')}>
                  <Link size={16} />
                  连接中转站
                </Button>
              )}
              {page === 'transfer' && desktop && (
                <Button onClick={() => setPage('station')}>
                  <Radio size={17} />
                  管理中转站
                </Button>
              )}
              {desktop && session && (
                <Button onClick={() => setModal('connect')}>
                  <Link size={16} />
                  连接其他中转站
                </Button>
              )}
            </div>
          </div>
          {notice && (
            <div
              className={`notice ${notice.error ? 'error' : ''}`}
              role={notice.error ? 'alert' : 'status'}
            >
              <AlertCircle size={17} />
              <span>{notice.text}</span>
              <button aria-label="关闭提示" onClick={() => setNotice(null)}>
                <X size={16} />
              </button>
            </div>
          )}
          {Object.values(multi.connections).map((connection) => (
            <ChatHall
              key={`${connection.session.stationId}:${connection.session.id}`}
              session={connection.session}
              connected={connection.status === 'connected'}
              visible={page === 'chat' && connection.session.stationId === multi.activeId}
              preserveView={desktop}
              latestId={connection.hub?.chatLatestId ?? 0}
              onDisconnect={() => disconnect(connection.session.stationId)}
              onCopy={copy}
              onRead={() => {
                const s = connection.session;
                void request<HubState>(s.base, s.token, '/api/state')
                  .then((next) => multi.updateHub(s.stationId, next))
                  .catch(() => {});
              }}
              management={
                admin?.settings.stationId === connection.session.stationId ? management : undefined
              }
            />
          ))}
          {page === 'chat' && !session && (
            <Empty icon={<MessageSquare size={28} />} title="连接中转站后加入大厅">
              请先连接一个中转站。每个中转站有独立的消息历史。
            </Empty>
          )}
          {page === 'connections' && desktop && (
            <ConnectedStations
              connections={multi.connections}
              saved={Object.values(savedHubs)}
              activeId={multi.activeId}
              busy={busy}
              onSelect={(id) => {
                multi.select(id);
                setPage('transfer');
              }}
              onJoin={(base) => {
                setConnectUrl(base);
                setPairing('');
                setDiscoveredSelection(null);
                setModal('connect');
              }}
              onDisconnect={disconnect}
              onForget={(id) => {
                setTargetStation(id);
                setModal('forgetStation');
              }}
            />
          )}
          {page === 'transfer' && (
            <>
              <div className={`transfer-screen ${session ? 'has-session' : ''}`}>
                <section className="panel transfer-queue">
                  <div className="section-head">
                    <h2>当前传输</h2>
                    <span className="subtle">
                      {transfers.length ? `${transfers.length} 项` : '0 项'}
                    </span>
                  </div>
                  <ScrollArea
                    memoryKey={`transfer:${multi.activeId}`}
                    className="transfer-items"
                    tabIndex={0}
                    aria-label="当前传输列表"
                  >
                    {transfers.length ? (
                      transfers.map((t) => {
                        const incoming = t.recipientId === session?.id;
                        const amount =
                          t.status === 'uploading'
                            ? Math.max(t.uploaded, progress[`${session?.stationId}:${t.id}`] ?? 0)
                            : t.status === 'downloading'
                              ? Math.max(
                                  t.downloaded,
                                  progress[`${session?.stationId}:${t.id}`] ?? 0,
                                )
                              : t.uploaded;
                        const percent = t.size
                          ? Math.min(100, Math.round((amount / t.size) * 100))
                          : t.status === 'pending'
                            ? 0
                            : 100;
                        return (
                          <article className="transfer-row" key={t.id} data-scroll-id={t.id}>
                            <div className={`direction ${incoming ? 'incoming' : ''}`}>
                              {incoming ? <ArrowDownLeft size={23} /> : <ArrowUpRight size={23} />}
                            </div>
                            <div className="transfer-details">
                              <strong>{t.name}</strong>
                              <p>
                                {sizes(t.size)} ·{' '}
                                <span className="device-name-tag">
                                  {t.senderName}
                                  <DeviceTag
                                    platform={
                                      t.senderPlatform ??
                                      hub?.devices.find((d) => d.id === t.senderId)?.platform
                                    }
                                  />
                                </span>{' '}
                                →{' '}
                                <span className="device-name-tag">
                                  {t.recipientName}
                                  <DeviceTag
                                    platform={
                                      t.recipientPlatform ??
                                      hub?.devices.find((d) => d.id === t.recipientId)?.platform
                                    }
                                  />
                                </span>
                              </p>
                              {['uploading', 'downloading'].includes(t.status) && (
                                <>
                                  <progress
                                    value={percent}
                                    max="100"
                                    aria-label={`${t.name} 传输进度`}
                                  />
                                  <small>
                                    {percent}% · {sizes(amount)} / {sizes(t.size)}
                                  </small>
                                </>
                              )}
                              {t.error && <small className="error-text">{t.error}</small>}
                              {savedPaths[`${session?.stationId}:${t.id}`] && (
                                <small>{savedPaths[`${session?.stationId}:${t.id}`]}</small>
                              )}
                            </div>
                            <div className="transfer-actions">
                              <Badge status={t.status} />
                              {incoming && t.status === 'pending' && (
                                <>
                                  <Button
                                    kind="primary"
                                    disabled={busy}
                                    onClick={() => void run(() => action(t, 'accept'))}
                                  >
                                    <Check size={16} />
                                    接收
                                  </Button>
                                  <Button
                                    disabled={busy}
                                    onClick={() => void run(() => action(t, 'reject'))}
                                  >
                                    拒绝
                                  </Button>
                                </>
                              )}
                              {incoming && ['ready', 'awaiting-confirm'].includes(t.status) && (
                                <Button
                                  kind="primary"
                                  disabled={
                                    busy || receivingKeys.includes(`${session?.stationId}:${t.id}`)
                                  }
                                  onClick={() =>
                                    void receive(t).catch((error) => {
                                      reportException('download.failed', error, {
                                        stationId: session?.stationId,
                                        base: session?.base,
                                      });
                                      inform(error.message, true);
                                    })
                                  }
                                >
                                  <Download size={16} />
                                  {t.status === 'ready' ? '下载文件' : '重新下载'}
                                </Button>
                              )}
                              {incoming && t.status === 'awaiting-confirm' && (
                                <Button
                                  disabled={busy}
                                  onClick={() => void run(() => action(t, 'complete'))}
                                >
                                  <Check size={16} />
                                  确认收到
                                </Button>
                              )}
                              <Button
                                disabled={busy && t.status !== 'downloading'}
                                title="取消传输"
                                onClick={() => void run(() => action(t, 'cancel'))}
                              >
                                <X size={16} />
                              </Button>
                            </div>
                          </article>
                        );
                      })
                    ) : (
                      <Empty icon={<ArrowLeftRight size={28} />} title="还没有进行中的传输">
                        {session ? '选择文件发送，或等待接收。' : '连接中转站后即可收发文件。'}
                      </Empty>
                    )}
                  </ScrollArea>
                </section>{' '}
                {session && (
                  <section className="panel composer">
                    <div className="section-head">
                      <h2>发送文件</h2>
                      <span className="subtle">{online.length} 台可接收设备</span>
                    </div>
                    <DeviceSelect
                      label="接收设备"
                      value={recipient}
                      onChange={setRecipient}
                      devices={online}
                      placeholder="选择一台在线设备"
                      disabled={!connected}
                    />
                    <label
                      className="dropzone"
                      onDragOver={(e) => {
                        e.preventDefault();
                        e.currentTarget.classList.add('dragging');
                      }}
                      onDragLeave={(e) => e.currentTarget.classList.remove('dragging')}
                      onDrop={(e) => {
                        e.preventDefault();
                        e.currentTarget.classList.remove('dragging');
                        const dropped = Array.from(e.dataTransfer.files);
                        setFiles((old) => [...old, ...dropped]);
                      }}
                    >
                      <Upload size={28} />
                      <strong>选择文件，或拖到这里</strong>
                      <span>可选择多个文件</span>
                      <input
                        aria-label="选择待发送文件"
                        type="file"
                        multiple
                        onChange={(e) => {
                          const picked = Array.from(e.target.files ?? []);
                          setFiles((old) => [...old, ...picked]);
                          e.target.value = '';
                        }}
                      />
                    </label>
                    <ScrollArea
                      memoryKey={`selected-files:${multi.activeId}`}
                      className="selected-files"
                      tabIndex={0}
                      aria-label="待发送文件列表"
                    >
                      {files.map((f, i) => (
                        <div
                          className="file-line"
                          key={i}
                          data-scroll-id={`${f.name}:${f.lastModified}:${i}`}
                        >
                          <File size={17} />
                          <span>{f.name}</span>
                          <small>{sizes(f.size)}</small>
                          <button
                            aria-label={`移除 ${f.name}`}
                            onClick={() => setFiles(files.filter((_, j) => i !== j))}
                          >
                            <X size={16} />
                          </button>
                        </div>
                      ))}
                    </ScrollArea>
                    <div className="send-footer">
                      <span className="subtle">
                        {files.length
                          ? `${files.length} 个文件 · ${sizes(files.reduce((n, f) => n + f.size, 0))}`
                          : '选择接收设备和文件'}
                      </span>
                      <Button
                        kind="primary"
                        disabled={
                          busy ||
                          !connected ||
                          !files.length ||
                          !online.some((d) => d.id === recipient)
                        }
                        onClick={() => void run(send)}
                      >
                        <ArrowUpRight size={18} />
                        发送
                      </Button>
                    </div>
                  </section>
                )}
              </div>
            </>
          )}
          {page === 'station' && admin && (
            <>
              <ScrollArea
                as="section"
                memoryKey="local-station"
                className="panel station-panel"
                tabIndex={0}
                aria-label="本机中转站信息"
              >
                <div className="station-main">
                  <div className="section-head">
                    <span className="station-icon">
                      <Radio size={27} />
                    </span>
                    <Badge status={admin.running ? 'online' : 'offline'} />
                  </div>
                  <h2>{admin.running ? '中转站已开启' : '开启这台电脑的中转站'}</h2>
                  <strong className="station-name">{admin.settings.stationName}</strong>
                  <p>让同一局域网的电脑和手机加入，互传文件与文字。</p>
                  <div className="actions">
                    <Button
                      kind={admin.running ? '' : 'primary'}
                      disabled={busy}
                      onClick={() =>
                        admin.running
                          ? setModal('stop')
                          : void run(async () => setAdmin(await management('/station/start', {})))
                      }
                    >
                      {admin.running ? (
                        <>
                          <Unplug size={17} />
                          关闭中转站
                        </>
                      ) : (
                        <>
                          <Radio size={17} />
                          开启中转站
                        </>
                      )}
                    </Button>
                    {admin.running && (
                      <Button disabled={busy} onClick={() => void run(() => joinLocal())}>
                        <Link size={17} />
                        本机加入
                      </Button>
                    )}
                  </div>
                  <dl className="station-facts">
                    <div>
                      <dt>监听端口</dt>
                      <dd>{admin.settings.port}</dd>
                    </div>
                    <div>
                      <dt>在线设备</dt>
                      <dd>{admin.devices.filter((d) => d.online).length}</dd>
                    </div>
                    <div>
                      <dt>文件保留</dt>
                      <dd>完成后 {admin.settings.retentionHours} 小时</dd>
                    </div>
                  </dl>
                </div>
                <div className="pairing-panel">
                  {admin.running ? (
                    <>
                      <h3>手机扫码连接</h3>
                      {qr && <img className="qr" src={qr} alt="中转站配对二维码" />}
                      <label>
                        局域网地址
                        <select
                          aria-label="选择局域网地址"
                          value={address}
                          onChange={(e) => setAddress(e.target.value)}
                        >
                          {(admin.addresses.length
                            ? admin.addresses
                            : [`http://127.0.0.1:${admin.settings.port}`]
                          ).map((a) => (
                            <option key={a} value={a}>
                              {admin.settings.stationName} · {a}
                            </option>
                          ))}
                        </select>
                      </label>
                      <div className="numeric-pairing">
                        <div>
                          <strong>一次性配对码</strong>
                          <code>{admin.pairingCode}</code>
                        </div>
                        <div className="actions">
                          <Button onClick={() => void run(() => copy(admin.pairingCode))}>
                            复制数字
                          </Button>
                          <Button
                            onClick={() =>
                              void run(async () => setAdmin(await management('/pairing/code', {})))
                            }
                          >
                            生成新码
                          </Button>
                        </div>
                        <small>
                          {Date.now() >= admin.pairingCodeExpiresAt
                            ? '配对码已过期，请生成新码'
                            : `有效至 ${new Date(admin.pairingCodeExpiresAt).toLocaleTimeString('zh-CN', { hour12: false })} · 一次有效`}
                        </small>
                      </div>
                      <div className="actions pairing-link-actions">
                        <Button
                          onClick={() =>
                            void run(() => copy(`${address}/#pair=${admin.pairingToken}`))
                          }
                        >
                          <Copy size={15} />
                          复制配对链接
                        </Button>
                        <Button
                          title="刷新配对码，已连接设备不受影响"
                          disabled={busy}
                          onClick={() =>
                            void run(async () => setAdmin(await management('/pairing/rotate', {})))
                          }
                        >
                          <RefreshCw size={16} />
                        </Button>
                      </div>
                      {!admin.addresses.length && (
                        <p className="error-text">未检测到局域网地址，请连接 Wi-Fi 或有线网络。</p>
                      )}
                    </>
                  ) : (
                    <Empty icon={<Smartphone size={30} />} title="开启后显示配对二维码">
                      手机只需浏览器，无需安装应用。
                    </Empty>
                  )}
                </div>
              </ScrollArea>
              <div className="note">
                <Wifi size={18} />
                <p>请允许防火墙接受连接；访客网络可能隔离设备。</p>
              </div>
            </>
          )}
          {page === 'devices' && admin && (
            <div className="devices-layout">
              <section className="panel">
                <div className="section-head">
                  <h2>设备列表</h2>
                  <Button onClick={() => setModal('clearDevices')}>
                    <Trash2 size={16} />
                    清理离线历史
                  </Button>
                </div>
                {admin.devices.length ? (
                  <ScrollArea
                    memoryKey="local-devices"
                    className="device-list"
                    tabIndex={0}
                    aria-label="设备列表"
                  >
                    {admin.devices.map((d) => (
                      <div className="device-record" key={d.id} data-scroll-id={d.id}>
                        <DeviceAvatar id={d.id} name={d.name} size={40} />
                        <div>
                          <strong>
                            {d.name}
                            <DeviceTag platform={d.platform} />
                          </strong>
                          <p>{d.ip}</p>
                          <small
                            title={`首次连接 ${date(d.firstSeen)}${d.disconnectedAt ? ` · 断开 ${date(d.disconnectedAt)}` : ''} `}
                          >
                            登录 {d.loginCount} 次 · 最近连接 {date(d.lastSeen)}
                          </small>
                        </div>
                        <div className="device-record-actions">
                          <Badge status={d.online ? 'online' : 'offline'} />
                          <Button
                            kind="danger"
                            title="清除设备"
                            onClick={() => {
                              setRemoveDevice(d);
                              setModal('removeDevice');
                            }}
                          >
                            <Trash2 size={16} />
                            清除
                          </Button>
                          {d.online && (
                            <Button
                              title="断开设备连接"
                              onClick={() =>
                                void run(() => management('/device/disconnect', { id: d.id }))
                              }
                            >
                              <Unplug size={16} />
                            </Button>
                          )}
                        </div>
                      </div>
                    ))}
                  </ScrollArea>
                ) : (
                  <Empty icon={<Monitor size={28} />} title="还没有连接记录">
                    开启中转站，让其他设备扫码连接。
                  </Empty>
                )}
              </section>
              <section className="panel connection-history">
                <div className="section-head">
                  <h2>连接时间线</h2>
                  <span className="subtle">最近 500 次</span>
                </div>
                {admin.connections.length ? (
                  <ScrollArea
                    memoryKey="local-timeline"
                    className="timeline"
                    tabIndex={0}
                    aria-label="连接时间线"
                  >
                    {admin.connections.map((c) => (
                      <div key={c.id} data-scroll-id={c.id}>
                        <span className="dot" />
                        <strong>
                          {c.name}
                          <DeviceTag platform={c.platform} />
                        </strong>
                        <span>{c.ip}</span>
                        {c.deviceId === boot?.deviceId && (
                          <span className="badge local-device-tag">本机</span>
                        )}
                        <p>
                          {date(c.connectedAt)} 连接 →{' '}
                          {c.disconnectedAt ? `${date(c.disconnectedAt)} 断开` : '当前连接中'}
                        </p>
                      </div>
                    ))}
                  </ScrollArea>
                ) : (
                  <p className="subtle">设备连接与断开后会自动记录。</p>
                )}
              </section>
            </div>
          )}
          {page === 'history' && (
            <>
              <div className="history-toolbar">
                <div className="tabs">
                  {[
                    ['all', '全部'],
                    ['send', '我发送的'],
                    ['receive', '我接收的'],
                  ].map(([v, l]) => (
                    <button
                      className={filter === v ? 'selected' : ''}
                      key={v}
                      onClick={() => {
                        setFilter(v);
                        setOffset(0);
                      }}
                    >
                      {l}
                    </button>
                  ))}
                </div>
                {desktop && (
                  <select
                    aria-label="按中转站筛选记录"
                    value={historyStation}
                    onChange={(event) => {
                      setHistoryStation(event.target.value);
                      setOffset(0);
                    }}
                  >
                    <option value="all">全部中转站</option>
                    {historyStations.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                )}
                <label className="search">
                  <Search size={17} />
                  <input
                    aria-label="搜索收发记录"
                    placeholder="搜索文件或设备"
                    value={search}
                    onChange={(e) => {
                      setSearch(e.target.value);
                      setOffset(0);
                    }}
                  />
                </label>
                {desktop && (
                  <Button
                    title="手动清理已结束且缓存已清除的记录"
                    onClick={() => setModal('clearRecords')}
                  >
                    <Trash2 size={16} />
                  </Button>
                )}
              </div>
              <ScrollArea
                as="section"
                memoryKey={historyScrollKey}
                ready={historyLoadedKey === historyScrollKey}
                resetOnKeyChange
                className="panel records-panel"
                tabIndex={0}
                aria-label="收发记录列表"
              >
                {historyRows.length ? (
                  <div className="record-table">
                    <div className="record-header">
                      <span>文件 / 大小</span>
                      <span>发送 → 接收</span>
                      <span>时间 / 耗时</span>
                      <span>状态</span>
                    </div>
                    {historyRows.map((t) => (
                      <div
                        className="record-row"
                        key={`${t.stationId}:${t.id}`}
                        data-scroll-id={`${t.stationId}:${t.id}`}
                      >
                        <div>
                          <strong>{t.name}</strong>
                          <small>{sizes(t.size)}</small>
                          {desktop && (
                            <small className="record-station">
                              <Radio size={12} />
                              {t.stationName || '其他'}
                            </small>
                          )}
                        </div>
                        <div>
                          <span className="device-name-tag">
                            {t.senderName}
                            <DeviceTag
                              platform={
                                t.senderPlatform ??
                                admin?.devices.find((d) => d.id === t.senderId)?.platform
                              }
                            />
                          </span>
                          <ArrowUpRight size={13} />
                          <span className="device-name-tag">
                            {t.recipientName}
                            <DeviceTag
                              platform={
                                t.recipientPlatform ??
                                admin?.devices.find((d) => d.id === t.recipientId)?.platform
                              }
                            />
                          </span>
                        </div>
                        <div>
                          <span>{date(t.createdAt)}</span>
                          <small>耗时 {duration(t.duration)}</small>
                        </div>
                        <div>
                          <Badge status={t.status} />
                          {t.cleanedAt && <small>缓存已清理</small>}
                          {t.error && <small className="error-text">{t.error}</small>}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <Empty
                    icon={<History size={28} />}
                    title={search ? '没有匹配的记录' : '还没有收发记录'}
                  >
                    收发记录永久保留。
                  </Empty>
                )}
              </ScrollArea>
              <div className="pagination">
                <span>
                  共 {total} 条 · 当前 {total ? offset + 1 : 0}–{Math.min(offset + 50, total)}
                </span>
                <div className="actions">
                  <Button
                    title="上一页"
                    disabled={offset === 0}
                    onClick={() => setOffset(Math.max(0, offset - 50))}
                  >
                    <ChevronLeft size={17} />
                  </Button>
                  <Button
                    title="下一页"
                    disabled={offset + 50 >= total}
                    onClick={() => setOffset(offset + 50)}
                  >
                    <ChevronRight size={17} />
                  </Button>
                </div>
              </div>
            </>
          )}
          {page === 'storage' && admin && (
            <>
              <div className="storage-summary">
                <section className="panel">
                  <HardDrive size={23} />
                  <p>中转文件占用</p>
                  <strong>{sizes(cache?.totalBytes ?? 0)}</strong>
                  <small>磁盘可用 {sizes(cache?.freeBytes ?? 0)}</small>
                </section>
                <section className="panel">
                  <History size={23} />
                  <p>数据库占用</p>
                  <strong>{sizes(admin.sizes.database + admin.sizes.wal + admin.sizes.shm)}</strong>
                  <small>消息、记录与设置</small>
                </section>
              </div>
              <Button onClick={() => setModal('storageLocations')}>
                <FolderOpen size={16} />
                存储位置与数据库整理
              </Button>
              <div className="storage-files">
                <section className="panel">
                  <div className="section-head">
                    <div>
                      <h2>当前存储的文件</h2>
                      <p className="subtle">完成后 {admin.settings.retentionHours} 小时清理缓存</p>
                    </div>
                    <Button
                      kind="danger"
                      disabled={!selected.length || busy}
                      onClick={() => setModal('clearCache')}
                    >
                      <Trash2 size={16} />
                      清理所选{selected.length ? ` (${selected.length})` : ''}
                    </Button>
                  </div>
                  {cache?.entries.length ? (
                    <>
                      <label className="select-all">
                        <input
                          type="checkbox"
                          checked={
                            cache.entries.filter((e) => !e.busy).length > 0 &&
                            cache.entries
                              .filter((e) => !e.busy)
                              .every((e) => selected.includes(e.id))
                          }
                          onChange={(e) =>
                            setSelected(
                              e.target.checked
                                ? cache.entries.filter((x) => !x.busy).map((x) => x.id)
                                : [],
                            )
                          }
                        />
                        选择所有可清理文件
                      </label>
                      <ScrollArea
                        memoryKey={`cache:${admin.settings.cacheDir}`}
                        className="storage-list"
                        tabIndex={0}
                        aria-label="中转缓存列表"
                      >
                        {cache.entries.map((e) => (
                          <label
                            className="cache-row"
                            key={e.folder + e.id}
                            data-scroll-id={e.folder + e.id}
                          >
                            <input
                              type="checkbox"
                              disabled={e.busy}
                              checked={selected.includes(e.id)}
                              onChange={(ev) =>
                                setSelected(
                                  ev.target.checked
                                    ? [...selected, e.id]
                                    : selected.filter((id) => id !== e.id),
                                )
                              }
                            />
                            <File size={20} />
                            <div>
                              <strong>{e.name}</strong>
                              <small>
                                {sizes(e.bytes)} ·{' '}
                                {e.folder === 'partial' ? '未完成上传' : '完整缓存'}
                                <br />
                                {e.expiresAt
                                  ? `自动清理：${date(e.expiresAt)}`
                                  : '尚未进入自动清理计时'}
                              </small>
                            </div>
                            <Badge status={e.status} />
                          </label>
                        ))}
                      </ScrollArea>
                    </>
                  ) : (
                    <Empty icon={<HardDrive size={28} />} title="缓存目录是空的">
                      传输经过本机中转站后，文件会显示在这里。
                    </Empty>
                  )}
                </section>
                <section className="panel received-panel">
                  <div className="section-head">
                    <div>
                      <h2>本机已接收文件</h2>
                      <p className="subtle">正式文件，不会自动清理。</p>
                    </div>
                    <Button
                      kind="danger"
                      disabled={!receivedSelected.length || busy}
                      onClick={() => setModal('clearReceived')}
                    >
                      <Trash2 size={16} />
                      删除所选文件
                    </Button>
                  </div>
                  <select
                    aria-label="按中转站筛选已接收文件"
                    value={receivedStation}
                    onChange={(event) => {
                      setReceivedStation(event.target.value);
                      setReceivedSelected([]);
                    }}
                  >
                    <option value="all">全部中转站</option>
                    {[
                      ...new Map(
                        received.map((f) => [
                          f.stationId && f.stationName ? f.stationId : 'other',
                          {
                            id: f.stationId && f.stationName ? f.stationId : 'other',
                            name: f.stationName || '其他',
                          },
                        ]),
                      ).values(),
                    ].map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                  <ScrollArea
                    memoryKey={`received:${receivedStation}`}
                    resetOnKeyChange
                    className="storage-list"
                    tabIndex={0}
                    aria-label="已接收文件列表"
                  >
                    {received.length ? (
                      received
                        .filter(
                          (f) =>
                            receivedStation === 'all' ||
                            (f.stationId && f.stationName ? f.stationId : 'other') ===
                              receivedStation,
                        )
                        .map((f) => (
                          <label
                            className="cache-row received-row"
                            key={f.id}
                            data-scroll-id={f.id}
                          >
                            <input
                              type="checkbox"
                              checked={receivedSelected.includes(f.id)}
                              onChange={(e) =>
                                setReceivedSelected(
                                  e.target.checked
                                    ? [...receivedSelected, f.id]
                                    : receivedSelected.filter((id) => id !== f.id),
                                )
                              }
                            />
                            <File size={20} />
                            <div>
                              <strong>{f.name}</strong>
                              <small>
                                {sizes(f.size)} · {date(f.receivedAt)} · {f.stationName || '其他'}
                                <br />
                                {f.path}
                              </small>
                            </div>
                            <span className="badge">{f.exists ? '已保存' : '已移走或删除'}</span>
                          </label>
                        ))
                    ) : (
                      <Empty icon={<Download size={28} />} title="还没有本机接收文件">
                        通过桌面应用接收的文件会列在这里。
                      </Empty>
                    )}
                  </ScrollArea>
                </section>
              </div>
              <p className="storage-footnote">清理缓存保留历史和已接收文件。</p>
            </>
          )}
          {page === 'settings' && (
            <>
              <div className="identity-panel">
                <div className="identity-heading">
                  <DeviceAvatar
                    id={boot?.deviceId ?? mobileId.current}
                    name={boot?.deviceName ?? deviceName}
                    size={40}
                  />
                  <div>
                    <h3>设备身份</h3>
                    <strong>
                      {boot?.deviceName ?? deviceName}
                      <DeviceTag platform={boot?.platform ?? browserPlatform()} />
                    </strong>
                  </div>
                </div>
                <div className="identity-details">
                  <div className="identity-code">
                    <code>{boot?.deviceId ?? mobileId.current}</code>
                    <Button
                      title="复制设备标识符"
                      onClick={() => void run(() => copy(boot?.deviceId ?? mobileId.current))}
                    >
                      <Copy size={16} />
                    </Button>
                  </div>
                  <p>更换后需重新配对，旧身份的密文无法解密。文件与收发历史保留。</p>
                </div>
                <Button kind="danger" disabled={busy} onClick={() => setModal('resetIdentity')}>
                  更换设备身份
                </Button>
              </div>
              <section className="panel settings-panel">
                <ScrollArea
                  memoryKey="settings"
                  className="settings-body"
                  tabIndex={0}
                  aria-label="设置内容"
                >
                  <form
                    id="settings-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void run(async () => {
                        let warning: string | undefined;
                        if (desktop) {
                          const updated = await management('/settings', form);
                          setAdmin(updated);
                          warning = updated.warning;
                          if (session && connected)
                            await request(session.base, session.token, '/api/device', {
                              name: form.deviceName,
                            }).catch(() => {});
                          setDeviceName(form.deviceName);
                          setBoot((b) => (b ? { ...b, deviceName: form.deviceName } : b));
                        } else {
                          save('relay3-device-name', deviceName);
                          if (session && connected)
                            await request(session.base, session.token, '/api/device', {
                              name: deviceName,
                            }).catch(() => {});
                        }
                        inform(warning ?? '设置已保存', !!warning);
                      });
                    }}
                  >
                    <div className={desktop ? 'form-grid' : 'device-name-field'}>
                      <label>
                        设备名称
                        <input
                          required
                          maxLength={80}
                          value={desktop ? form.deviceName : deviceName}
                          onChange={(e) =>
                            desktop
                              ? setForm({ ...form, deviceName: e.target.value })
                              : setDeviceName(e.target.value)
                          }
                        />
                      </label>
                      {desktop && (
                        <label>
                          中转站名称
                          <input
                            aria-label="中转站名称"
                            required
                            maxLength={80}
                            value={form.stationName}
                            onChange={(e) => setForm({ ...form, stationName: e.target.value })}
                          />
                          <small>供连接的设备识别，与本机设备名称独立。</small>
                        </label>
                      )}
                    </div>
                    {desktop && (
                      <>
                        <div className="form-grid">
                          <label>
                            中转站端口
                            <input
                              type="number"
                              min={1024}
                              max={65535}
                              required
                              disabled={admin?.running}
                              value={form.port}
                              onChange={(e) => setForm({ ...form, port: Number(e.target.value) })}
                            />
                            <small>关闭中转站后可修改</small>
                          </label>
                          <label>
                            完成后保留时间（小时）
                            <input
                              type="number"
                              min={0.01}
                              max={720}
                              step="any"
                              required
                              value={form.retentionHours}
                              onChange={(e) =>
                                setForm({ ...form, retentionHours: Number(e.target.value) })
                              }
                            />
                            <small>应用于已完成缓存</small>
                          </label>
                        </div>
                        {(['cacheDir', 'receiveDir'] as const).map((k) => (
                          <label key={k}>
                            {k === 'cacheDir' ? '中转缓存位置' : '接收文件保存位置'}
                            <div className="path-input">
                              <input readOnly value={form[k]} />
                              <Button
                                disabled={k === 'cacheDir' && admin?.running}
                                onClick={() =>
                                  void run(async () => {
                                    const p = await window.relay3!.pickDirectory();
                                    if (p) setForm((f) => ({ ...f, [k]: p }));
                                  })
                                }
                              >
                                <FolderOpen size={17} />
                                选择
                              </Button>
                            </div>
                            <small>
                              {k === 'cacheDir'
                                ? '关闭中转站后可迁移到空目录。'
                                : '同名文件自动编号。'}
                            </small>
                          </label>
                        ))}
                      </>
                    )}
                  </form>
                  {desktop && (
                    <details className="note diagnostic-panel">
                      <summary>诊断日志</summary>
                      <p>
                        异常自动记录在本机，日志轮转保留约 30
                        MB。导出包含系统信息和已有崩溃转储，不自动上传。
                      </p>
                      <small>崩溃转储可能包含进程内存，请仅分享给信任的排查人员。</small>
                      <div className="identity-code">
                        <Button
                          title="复制日志路径"
                          onClick={() => void run(() => copy(diagnosticState?.path ?? ''))}
                        >
                          <Copy size={16} />
                        </Button>
                        <code>{diagnosticState?.path}</code>
                      </div>
                      <small>占用 {sizes(diagnosticState?.bytes ?? 0)}</small>
                      <div className="actions">
                        <Button
                          onClick={() => void run(() => window.relay3!.openDirectory('logs'))}
                        >
                          打开日志目录
                        </Button>
                        <Button
                          onClick={() =>
                            void run(async () => {
                              const saved = await window.relay3!.exportDiagnostics();
                              if (saved) inform('诊断日志已导出');
                            })
                          }
                        >
                          导出诊断日志
                        </Button>
                        <Button
                          kind="danger"
                          onClick={() =>
                            void run(async () => {
                              if (await window.relay3!.clearDiagnostics()) {
                                setDiagnosticState(await window.relay3!.diagnosticInfo());
                                inform('诊断日志已清理');
                              }
                            })
                          }
                        >
                          清理日志
                        </Button>
                      </div>
                    </details>
                  )}
                  {!desktop && (
                    <div className="note">
                      <Smartphone size={18} />
                      <p>下载位置由系统决定，保存后请确认收到。</p>
                    </div>
                  )}
                </ScrollArea>
                <div className="settings-actions">
                  <Button type="submit" form="settings-form" kind="primary" disabled={busy}>
                    保存设置
                  </Button>
                </div>
              </section>
            </>
          )}
        </main>
      </div>
      {modal === 'connect' && (
        <Modal
          title="连接中转站"
          onClose={() => setModal(null)}
          actions={
            <Button type="submit" form="connect-station-form" kind="primary" disabled={busy}>
              连接
            </Button>
          }
        >
          {desktop && (
            <NearbyStations
              selectedBase={connectUrl}
              busy={busy}
              onSelect={(station) => {
                setConnectUrl(station.base);
                setPairing('');
                setDiscoveredSelection(station);
              }}
            />
          )}
          <form
            id="connect-station-form"
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => join());
            }}
          >
            {desktop && discoveredSelection && (
              <button
                type="button"
                className="discovery-manual-action"
                onClick={() => setDiscoveredSelection(null)}
              >
                手动输入地址或配对链接
              </button>
            )}
            <label hidden={desktop && !!discoveredSelection}>
              中转站地址或配对链接
              <input
                required
                placeholder="http://192.168.1.8:42830"
                value={connectUrl}
                onChange={(e) => {
                  setConnectUrl(e.target.value);
                  setDiscoveredSelection(null);
                }}
              />
            </label>
            <label>
              设备名称
              <input
                required
                maxLength={80}
                value={deviceName}
                onChange={(e) => setDeviceName(e.target.value)}
              />
            </label>
            <label>
              配对码
              <input
                aria-label="配对码"
                value={pairing}
                placeholder="输入 6 位一次性数字，或扫码自动填入"
                onChange={(e) => setPairing(e.target.value)}
              />
              <small>
                {desktop
                  ? '填写中转站页面显示的 6 位数字，已配对的中转站可直接连接。'
                  : '输入中转站地址后，填写其页面显示的 6 位数字。完整配对链接无需另外填写。'}
              </small>
            </label>
          </form>
          {Object.keys(savedHubs).length > 0 && !(desktop && discoveredSelection) && (
            <SavedStations
              stations={Object.values(savedHubs)}
              busy={busy}
              onJoin={(base) => void run(() => join(base, ''))}
            />
          )}
        </Modal>
      )}
      {modal === 'storageLocations' && admin && (
        <Modal title="存储位置与数据库整理" onClose={() => setModal(null)}>
          <div className="storage-locations">
            <div className="paths">
              {[
                {
                  key: 'cache' as const,
                  title: '中转文件位置',
                  remark: '暂存传输文件，完成后按保留时间清理。',
                  path: admin.settings.cacheDir,
                },
                {
                  key: 'data' as const,
                  title: 'SQLite 数据库位置',
                  remark: '保存文字消息、设备连接、收发记录与设置。',
                  path: admin.databasePath,
                },
                {
                  key: 'receive' as const,
                  title: '接收文件位置',
                  remark: '保存本机已接收的正式文件，不会自动清理。',
                  path: admin.settings.receiveDir,
                },
              ].map((location) => (
                <section className="panel storage-location-card" key={location.key}>
                  <h3>{location.title}</h3>
                  <p className="subtle">{location.remark}</p>
                  <div className="storage-location-path">
                    <Button
                      title={`复制${location.title}`}
                      onClick={() => void run(() => copy(location.path))}
                    >
                      <Copy size={16} />
                    </Button>
                    <code>{location.path}</code>
                  </div>
                  <div className="storage-location-actions">
                    <Button
                      onClick={() => void run(() => window.relay3!.openDirectory(location.key))}
                    >
                      <FolderOpen size={16} />
                      打开目录
                    </Button>
                    {location.key === 'data' && (
                      <Button
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await management('/database/compact', {});
                            await refreshAdmin();
                            inform('数据库已整理，历史记录保留');
                          })
                        }
                      >
                        整理空间
                      </Button>
                    )}
                  </div>
                </section>
              ))}
            </div>
          </div>
        </Modal>
      )}
      {modal === 'copy' && (
        <Modal
          title="手动复制"
          onClose={() => setModal(null)}
          actions={<Button onClick={() => setModal(null)}>完成</Button>}
        >
          <p>浏览器未允许自动复制，请长按或选中下面的内容复制。</p>
          <textarea
            aria-label="待复制内容"
            readOnly
            value={copyValue}
            onFocus={(e) => e.target.select()}
          />
        </Modal>
      )}
      {modal === 'about' && (
        <Modal
          title="关于 Relay3"
          onClose={() => setModal(null)}
          actions={
            <div className="dialog-actions">
              {desktop ? (
                <Button onClick={() => void run(() => window.relay3!.openGithub())}>
                  <Github size={16} /> GitHub 项目
                </Button>
              ) : (
                <a
                  className="button"
                  href="https://github.com/nekomorph-woo/relay3"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Github size={16} /> GitHub 项目
                </a>
              )}
              <Button kind="primary" onClick={() => setModal(null)}>
                知道了
              </Button>
            </div>
          }
        >
          <div className="about-content">
            <div className="about-brand">
              <img src="/relay3.png" alt="Relay3 Logo" />
              <div>
                <h2>Relay3</h2>
                <p className="subtle">版本 {boot?.version ?? appVersion}</p>
                <p>局域网里的文件互传与文字交流。</p>
              </div>
            </div>
            <section className="about-section" aria-label="主要功能">
              <h3>主要功能</h3>
              <ul>
                <li>
                  <strong>文件互传</strong>电脑与手机互传文件，查看进度与永久保留的收发记录。
                </li>
                <li>
                  <strong>文字群聊</strong>支持普通消息和密文消息，历史保存在中转站。
                </li>
                <li>
                  <strong>多站与管理</strong>PC / Mac
                  可同时连接多个中转站，管理设备、缓存与已接收文件。
                </li>
              </ul>
            </section>
            <section className="about-section" aria-label="三步上手">
              <h3>三步上手</h3>
              <ol>
                <li>
                  <strong>开启中转站</strong>在一台 PC / Mac
                  的“本机中转站”页面开启服务，让设备连到同一局域网。
                </li>
                <li>
                  <strong>连接设备</strong>
                  电脑选择附近的中转站并输入配对码，也可使用配对链接；手机扫描二维码。
                </li>
                <li>
                  <strong>开始使用</strong>在“文件传输”选择接收设备和文件，或到“群聊大厅”发送文字。
                </li>
              </ol>
            </section>
          </div>
        </Modal>
      )}
      {(modal === 'disconnectStation' || modal === 'forgetStation') && (
        <Modal
          title={modal === 'forgetStation' ? '忘记中转站配对' : '断开中转站'}
          onClose={() => setModal(null)}
          actions={
            <div className="dialog-actions">
              <Button onClick={() => setModal(null)}>取消</Button>
              <Button
                kind="danger"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await disconnectStation(targetStation);
                    if (modal === 'forgetStation') {
                      await management('/client/forget', { stationId: targetStation });
                      const next = Object.fromEntries(
                        Object.entries(savedHubs).filter(([, s]) => s.stationId !== targetStation),
                      );
                      setSavedHubs(next);
                      save('relay3-hubs', next);
                    }
                    setModal(null);
                  })
                }
              >
                {modal === 'forgetStation' ? '确认忘记配对' : '取消传输并断开'}
              </Button>
            </div>
          }
        >
          <p>
            {modal === 'forgetStation'
              ? '删除本机保存的配对凭证，收发记录与已接收文件保留。'
              : '此中转站还有未结束的传输，断开将取消这些传输。'}
            其他中转站的连接继续运行。
          </p>
        </Modal>
      )}
      {modal &&
        modal !== 'storageLocations' &&
        modal !== 'about' &&
        modal !== 'connect' &&
        modal !== 'copy' &&
        modal !== 'disconnectStation' &&
        modal !== 'forgetStation' && (
          <Modal
            title={
              modal === 'resetIdentity'
                ? '更换设备身份'
                : modal === 'removeDevice'
                  ? `清除设备：${removeDevice?.name ?? ''}`
                  : modal === 'stop'
                    ? '关闭中转站'
                    : modal === 'clearCache'
                      ? '清理所选文件'
                      : modal === 'clearDevices'
                        ? '清理离线设备历史'
                        : modal === 'clearReceived'
                          ? '删除本机已接收文件'
                          : '清理收发历史'
            }
            onClose={() => setModal(null)}
            actions={
              <div className="dialog-actions">
                <Button onClick={() => setModal(null)}>取消</Button>
                <Button
                  kind="danger"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      if (modal === 'resetIdentity') {
                        await resetIdentity();
                      } else if (modal === 'removeDevice' && removeDevice) {
                        await management('/device/delete', { id: removeDevice.id });
                        await refreshAdmin();
                        inform('设备及连接历史已清除，收发记录保留');
                      } else if (modal === 'stop') {
                        const stopped = await management<AdminState>('/station/stop', {
                          force: true,
                        });
                        setAdmin(stopped);
                        if (multi.current.current[stopped.settings.stationId])
                          await disconnectStation(stopped.settings.stationId);
                      } else if (modal === 'clearCache') {
                        const result = await management('/cache/delete', { ids: selected });
                        const failed = result.results.filter((r: any) => !r.ok);
                        if (failed.length) inform(failed.map((r: any) => r.error).join('；'), true);
                        else inform('缓存已清理，记录保留');
                        setSelected([]);
                        setCache(await management('/cache'));
                      } else if (modal === 'clearReceived') {
                        const r = await management('/received/delete', { ids: receivedSelected });
                        setReceived((await management('/received')).entries);
                        setReceivedSelected([]);
                        inform(`已删除 ${r.deleted} 个本机接收文件，收发记录保留`);
                      } else if (modal === 'clearDevices') {
                        const r = await management('/devices/clear', { hours: clearHours });
                        inform(`已清理 ${r.deleted} 台离线设备的历史`);
                        await refreshAdmin();
                      } else {
                        const r = await management('/records/clear', {});
                        inform(`已清理 ${r.deleted} 条记录`);
                        const result = await management('/records');
                        setRecords(result.items);
                        setTotal(result.total);
                        setHistoryStations(result.stations ?? []);
                        setOffset(0);
                      }
                      setModal(null);
                    })
                  }
                >
                  {modal === 'resetIdentity'
                    ? '确认更换'
                    : modal === 'stop'
                      ? '关闭中转站'
                      : '确认清理'}
                </Button>
              </div>
            }
          >
            <p>
              {modal === 'resetIdentity'
                ? '更换后需要重新配对，新的聊天密钥无法解密发给旧身份的密文。当前连接和未完成传输会终止，收发记录及已接收文件保留。'
                : modal === 'removeDevice'
                  ? '清除该设备及连接历史，无论是否在线。在线设备会被断开，未完成传输会取消，旧凭证立即失效，收发记录和文件保留。'
                  : modal === 'stop'
                    ? '关闭后所有连接设备都会断开。正在传输的文件会中断，可重新发送或下载。'
                    : modal === 'clearCache'
                      ? '所选中转缓存将从磁盘删除。尚未接收的文件将无法继续下载，收发记录保留。'
                      : modal === 'clearReceived'
                        ? '所选正式文件将从接收目录永久删除，无法撤销。收发历史仍然保留。'
                        : modal === 'clearDevices'
                          ? '按最近一次连接的时间清理符合条件的离线设备及其连接历史，在线设备保留。未完成传输将取消，收发记录与文件保留。'
                          : '删除已结束且本机缓存已清理的收发记录，以及已结束的客户端历史。进行中的传输与仍有缓存的记录保留。此操作无法撤销。'}
            </p>
            {modal === 'clearDevices' && (
              <label>
                最近连接时间早于
                <select value={clearHours} onChange={(e) => setClearHours(Number(e.target.value))}>
                  <option value={1}>1 小时前</option>
                  <option value={24}>24 小时前</option>
                  <option value={168}>7 天前</option>
                  <option value={720}>30 天前</option>
                </select>
              </label>
            )}
          </Modal>
        )}
    </div>
  );
}
