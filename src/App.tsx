import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
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

type Page = 'transfer' | 'station' | 'devices' | 'history' | 'storage' | 'settings';
const pageInfo: Record<Page, [string, string]> = {
  transfer: ['文件传输', '选择设备，把文件送过去。'],
  station: ['中转站', '让这台电脑成为局域网里的接力点。'],
  devices: ['连接设备', '查看当前连接与历史连接记录。'],
  history: ['收发记录', '每一次发送和接收，都留有记录。'],
  storage: ['文件存储', '查看占用空间，管理中转站暂存文件。'],
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
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  kind?: string;
  title?: string;
  type?: 'button' | 'submit';
}) {
  return (
    <button
      type={type}
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
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current!;
    d.showModal();
    return () => d.close();
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={onClose}
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
      {children}
    </dialog>
  );
}

export default function App() {
  const desktop = !!window.relay3;
  const [boot, setBoot] = useState<Bootstrap | null>(null),
    [admin, setAdmin] = useState<AdminState | null>(null),
    [page, setPage] = useState<Page>('transfer');
  const [session, setSession] = useState<Session | null>(null),
    [hub, setHub] = useState<HubState | null>(null),
    [connected, setConnected] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null),
    [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<
    | null
    | 'connect'
    | 'clearRecords'
    | 'clearDevices'
    | 'clearCache'
    | 'stop'
    | 'clearReceived'
    | 'resetIdentity'
    | 'removeDevice'
    | 'copy'
  >(null);
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
  const [recipient, setRecipient] = useState(''),
    [files, setFiles] = useState<File[]>([]),
    [progress, setProgress] = useState<Record<string, number>>({}),
    [savedPaths, setSavedPaths] = useState<Record<string, string>>({});
  const pendingFiles = useRef(new Map<string, File>()),
    uploads = useRef(new Map<string, XMLHttpRequest>()),
    socketRef = useRef<WebSocket | null>(null);
  const [received, setReceived] = useState<
      {
        id: string;
        name: string;
        path: string;
        size: number;
        receivedAt: number;
        exists: boolean;
      }[]
    >([]),
    [receivedSelected, setReceivedSelected] = useState<string[]>([]);
  const [cache, setCache] = useState<CacheState | null>(null),
    [selected, setSelected] = useState<string[]>([]);
  const [records, setRecords] = useState<Transfer[]>([]),
    [total, setTotal] = useState(0),
    [offset, setOffset] = useState(0),
    [search, setSearch] = useState('');
  const [qr, setQr] = useState(''),
    [address, setAddress] = useState(''),
    [filter, setFilter] = useState('all');
  const [form, setForm] = useState({
    deviceName: '',
    port: 42830,
    retentionHours: 1,
    cacheDir: '',
    receiveDir: '',
  });
  const [savedHubs, setSavedHubs] = useState<Record<string, Session>>(stored('relay3-hubs', {}));
  const sessionRef = useRef(session);
  sessionRef.current = session;
  function inform(text: string, error = false) {
    setNotice({ text, error });
  }
  async function run(fn: () => Promise<any>) {
    setBusy(true);
    try {
      await fn();
    } catch (e: any) {
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
      uploads.current.get(t.id)?.abort();
      await window.relay3?.cancelDownload(t.id);
      pendingFiles.current.delete(t.id);
    }
  }
  useEffect(() => {
    save('relay3-device-id', mobileId.current);
    if (desktop)
      window
        .relay3!.bootstrap()
        .then(setBoot)
        .catch((e) => inform(e.message, true));
    else {
      const old = stored<Session | null>('relay3-session', null);
      if (old?.base === location.origin) setSession(old);
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
    admin?.settings.port,
    admin?.settings.retentionHours,
    admin?.settings.cacheDir,
    admin?.settings.receiveDir,
  ]);
  useEffect(() => {
    if (!session) return;
    let dead = false,
      timer: ReturnType<typeof setTimeout>,
      attempt = 0;
    function connect() {
      if (dead) return;
      const ws = new WebSocket(
        session!.base.replace(/^http/, 'ws') +
          `/api/ws?token=${encodeURIComponent(session!.token)}`,
      );
      socketRef.current = ws;
      ws.onopen = () => {
        attempt = 0;
        setConnected(true);
      };
      ws.onmessage = (e) => {
        try {
          setHub(JSON.parse(e.data));
        } catch {}
      };
      ws.onclose = (e) => {
        if (dead) return;
        setConnected(false);
        if ([4001, 4002, 4003].includes(e.code)) {
          inform(
            e.code === 4001
              ? '连接凭证失效，请重新配对'
              : e.code === 4002
                ? '此设备已在另一窗口连接'
                : '中转站管理员已断开此设备',
            true,
          );
          return;
        }
        timer = setTimeout(connect, Math.min(30_000, 1000 * 2 ** attempt++));
      };
      ws.onerror = () => {};
    }
    connect();
    return () => {
      dead = true;
      clearTimeout(timer);
      socketRef.current?.close();
      setConnected(false);
    };
  }, [session?.base, session?.token]);
  useEffect(() => {
    if (!hub || !session) return;
    if (boot) void management('/remember', { records: hub.transfers }).catch(() => {});
    for (const t of hub.transfers) {
      if (
        t.status === 'accepted' &&
        t.senderId === session.id &&
        pendingFiles.current.has(t.id) &&
        !uploads.current.has(t.id)
      ) {
        const file = pendingFiles.current.get(t.id)!;
        const xhr = new XMLHttpRequest();
        uploads.current.set(t.id, xhr);
        xhr.open('PUT', `${session.base}/api/transfers/${t.id}/upload`);
        xhr.setRequestHeader('Authorization', `Bearer ${session.token}`);
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.upload.onprogress = (e) => setProgress((p) => ({ ...p, [t.id]: e.loaded }));
        xhr.onload = () => {
          uploads.current.delete(t.id);
          pendingFiles.current.delete(t.id);
          if (xhr.status >= 400) {
            try {
              inform(JSON.parse(xhr.responseText).error, true);
            } catch {
              inform('上传失败，请重新发送', true);
            }
          }
        };
        xhr.onerror = () => {
          uploads.current.delete(t.id);
          pendingFiles.current.delete(t.id);
          inform('上传连接中断，请重新发送', true);
        };
        xhr.onabort = () => {
          uploads.current.delete(t.id);
          pendingFiles.current.delete(t.id);
        };
        xhr.send(file);
      }
      if (!active.includes(t.status)) {
        pendingFiles.current.delete(t.id);
        if (uploads.current.has(t.id)) uploads.current.get(t.id)?.abort();
      }
    }
  }, [hub]);
  useEffect(
    () => window.relay3?.onProgress((p) => setProgress((old) => ({ ...old, [p.id]: p.bytes }))),
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
        const q = `?offset=${offset}&search=${encodeURIComponent(search)}&direction=${filter}`;
        const result = boot
          ? await management('/records' + q)
          : session
            ? await request(session.base, session.token, '/api/history' + q)
            : { items: [], total: 0 };
        if (!dead) {
          setRecords(result.items);
          setTotal(result.total);
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
  }, [page, boot, session, offset, search, filter]);
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
    const old = savedHubs[base];
    const id = boot?.deviceId ?? mobileId.current;
    const result = await request<any>(base, old?.token ?? '', '/api/join', {
      id,
      name: deviceName,
      platform:
        boot?.platform ??
        (/iPhone|iPad/.test(navigator.userAgent)
          ? 'iPhone'
          : /Android/.test(navigator.userAgent)
            ? 'Android'
            : '浏览器'),
      ...(/^\d{6}$/.test(code.trim()) ? { pairingCode: code.trim() } : { pairingToken: code }),
    });
    const next = {
      base,
      token: result.token,
      id,
      stationId: result.stationId,
      stationName: result.stationName,
    };
    setSession(next);
    setHub(result);
    save('relay3-session', next);
    const remembered = { ...savedHubs, [base]: next };
    setSavedHubs(remembered);
    save('relay3-hubs', remembered);
    save('relay3-device-name', deviceName);
    setModal(null);
    history.replaceState(null, '', location.pathname);
    inform('已连接中转站');
  }
  function disconnect() {
    for (const xhr of uploads.current.values()) xhr.abort();
    uploads.current.clear();
    pendingFiles.current.clear();
    setSession(null);
    setHub(null);
    save('relay3-session', null);
  }
  async function send() {
    if (!session || !connected || !recipient) return;
    for (const file of files) {
      const t = await request<Transfer>(session.base, session.token, '/api/transfers', {
        name: file.name,
        size: file.size,
        recipientId: recipient,
      });
      pendingFiles.current.set(t.id, file);
    }
    setFiles([]);
    inform('已发送请求，等待对方确认');
    const state = await request<HubState>(session.base, session.token, '/api/state');
    setHub(state);
  }
  async function receive(t: Transfer) {
    if (!session) return;
    if (window.relay3) {
      const result = await window.relay3.download({
        base: session.base,
        token: session.token,
        id: t.id,
        name: t.name,
        size: t.size,
        sha256: t.sha256!,
      });
      setSavedPaths((p) => ({ ...p, [t.id]: result.path }));
      inform(result.confirmed ? '文件已保存并校验完成' : '文件已保存，请点击“确认收到”完成记录');
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
    for (const t of transfers) await window.relay3?.cancelDownload(t.id);
    let remoteRevoked = true;
    if (session && connected) {
      try {
        await request(session.base, session.token, '/api/identity/reset', {});
      } catch {
        remoteRevoked = false;
      }
    }
    disconnect();
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
    { id: 'station' as Page, label: '中转站', icon: Radio },
    { id: 'devices' as Page, label: '连接设备', icon: Monitor },
    { id: 'history' as Page, label: '收发记录', icon: History },
    { id: 'storage' as Page, label: '文件存储', icon: HardDrive },
    { id: 'settings' as Page, label: '设置', icon: Settings },
  ].filter((n) => desktop || ['transfer', 'history', 'settings'].includes(n.id));
  const historyRows = records;
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <img src="/relay3.png" alt="relay3 图标" />
          <span>relay3</span>
        </div>
        <p className="brand-caption">文件，在设备间接力。</p>
        <nav aria-label="主导航">
          {nav.map(({ id, label, icon: Icon }) => (
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
              {id === 'transfer' && transfers.length > 0 && (
                <span className="count">{transfers.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="device-self">
            <Monitor size={18} />
            <div>
              <strong>{boot?.deviceName ?? deviceName}</strong>
              <small>{desktop ? '桌面终端' : '手机客户端'}</small>
            </div>
          </div>
          <span className="version">relay3 {boot?.version ?? '0.3.2'}</span>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="mobile-brand">
            <img src="/relay3.png" alt="" />
            relay3
          </div>
          <span className="connection-label">
            <span className={`dot ${connected ? 'on' : ''}`} />
            {session
              ? connected
                ? `已连接 · ${hub?.stationName ?? session.stationName}`
                : '连接已断开，正在等待重连'
              : '尚未连接中转站'}
          </span>
          <div className="top-actions">
            {session ? (
              <Button onClick={disconnect} title="断开当前中转站">
                <Unplug size={16} />
                <span>断开</span>
              </Button>
            ) : (
              <Button onClick={() => setModal('connect')}>
                <Link size={16} />
                连接
              </Button>
            )}
          </div>
        </header>
        <main>
          <div className="page-head">
            <div>
              <h1>{pageInfo[page][0]}</h1>
              <p>{pageInfo[page][1]}</p>
            </div>
            {page === 'transfer' && desktop && (
              <Button onClick={() => setPage('station')}>
                <Radio size={17} />
                管理中转站
              </Button>
            )}
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
          {page === 'transfer' && (
            <>
              {!session && (
                <section className="welcome panel">
                  <div className="welcome-symbol">
                    <ArrowLeftRight size={34} />
                  </div>
                  <h2>连接，然后开始传输。</h2>
                  <p>
                    {desktop
                      ? '开启本机中转站，或连接另一台电脑的中转站。'
                      : '扫描电脑上的二维码，或输入配对码连接中转站。'}
                  </p>
                  <div className="actions">
                    <Button kind="primary" onClick={() => setModal('connect')}>
                      <Link size={17} />
                      连接中转站
                    </Button>
                    {desktop && (
                      <Button
                        disabled={busy || !admin}
                        onClick={() =>
                          void run(async () => {
                            if (!admin?.running) setAdmin(await management('/station/start', {}));
                            setPage('station');
                          })
                        }
                      >
                        <Radio size={17} />
                        {admin?.running ? '查看本机中转站' : '开启本机中转站'}
                      </Button>
                    )}
                  </div>
                </section>
              )}
              {session && (
                <div className="transfer-layout">
                  <section className="panel composer">
                    <div className="section-head">
                      <h2>发送文件</h2>
                      <span className="subtle">{online.length} 台可接收设备</span>
                    </div>
                    <label>
                      接收设备
                      <select
                        value={recipient}
                        onChange={(e) => setRecipient(e.target.value)}
                        disabled={!connected}
                      >
                        <option value="">选择一台在线设备</option>
                        {online.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.name} · {d.platform}
                          </option>
                        ))}
                      </select>
                    </label>
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
                      <span>支持多个文件，大文件采用流式传输</span>
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
                    {files.length > 0 && (
                      <div className="selected-files">
                        {files.map((f, i) => (
                          <div className="file-line" key={i}>
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
                      </div>
                    )}
                    <div className="send-footer">
                      <span className="subtle">
                        {files.length
                          ? `${files.length} 个文件 · ${sizes(files.reduce((n, f) => n + f.size, 0))}`
                          : '文件只在你的局域网内传输'}
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
                  <section className="panel device-panel">
                    <div className="section-head">
                      <h2>在线设备</h2>
                      <Wifi size={18} />
                    </div>
                    {online.length ? (
                      online.map((d) => (
                        <button
                          className={`peer ${recipient === d.id ? 'chosen' : ''}`}
                          key={d.id}
                          onClick={() => setRecipient(d.id)}
                        >
                          <span className="device-icon">
                            {/iPhone|Android|手机/.test(d.platform) ? (
                              <Smartphone size={23} />
                            ) : (
                              <Monitor size={23} />
                            )}
                          </span>
                          <span>
                            <strong>{d.name}</strong>
                            <small>
                              {d.platform} · {d.ip}
                            </small>
                          </span>
                          <span className="dot on" />
                        </button>
                      ))
                    ) : (
                      <Empty icon={<Monitor size={26} />} title="等待其他设备加入">
                        让另一台设备连接同一个中转站。
                      </Empty>
                    )}
                    <div className="station-context">
                      <Radio size={16} />
                      <span>
                        {hub?.stationName}
                        <small>{session.base}</small>
                      </span>
                    </div>
                  </section>
                </div>
              )}
              <section className="transfer-queue">
                <div className="section-head">
                  <h2>当前传输</h2>
                  <span className="subtle">
                    {transfers.length ? `${transfers.length} 项` : '等待下一次接力'}
                  </span>
                </div>
                {transfers.length ? (
                  transfers.map((t) => {
                    const incoming = t.recipientId === session?.id;
                    const amount =
                      t.status === 'uploading'
                        ? Math.max(t.uploaded, progress[t.id] ?? 0)
                        : t.status === 'downloading'
                          ? Math.max(t.downloaded, progress[t.id] ?? 0)
                          : t.uploaded;
                    const percent = t.size
                      ? Math.min(100, Math.round((amount / t.size) * 100))
                      : t.status === 'pending'
                        ? 0
                        : 100;
                    return (
                      <article className="transfer-row" key={t.id}>
                        <div className={`direction ${incoming ? 'incoming' : ''}`}>
                          {incoming ? <ArrowDownLeft size={23} /> : <ArrowUpRight size={23} />}
                        </div>
                        <div className="transfer-details">
                          <strong>{t.name}</strong>
                          <p>
                            {sizes(t.size)} · {t.senderName} → {t.recipientName}
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
                          {savedPaths[t.id] && <small>{savedPaths[t.id]}</small>}
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
                              disabled={busy}
                              onClick={() => void run(() => receive(t))}
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
                    选择文件并发送，或等待其他设备发来文件。
                  </Empty>
                )}
              </section>
            </>
          )}
          {page === 'station' && admin && (
            <>
              <section className="panel station-panel">
                <div className="station-main">
                  <div className="section-head">
                    <span className="station-icon">
                      <Radio size={27} />
                    </span>
                    <Badge status={admin.running ? 'online' : 'offline'} />
                  </div>
                  <h2>{admin.running ? '中转站已开启' : '开启这台电脑的中转站'}</h2>
                  <p>
                    其他设备连接后，即可通过这台电脑互传文件。此电脑仍可作为客户端连接其他中转站。
                  </p>
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
                      <Button
                        disabled={busy}
                        onClick={() =>
                          void run(() =>
                            join(`http://127.0.0.1:${admin.settings.port}`, admin.pairingToken),
                          )
                        }
                      >
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
                            <option key={a}>{a}</option>
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
                            : `有效至 ${new Date(admin.pairingCodeExpiresAt).toLocaleTimeString('zh-CN', { hour12: false })}，成功配对后立即作废`}
                        </small>
                        <small>
                          其他终端输入中转站地址与这 6 位数字即可连接，无需传递完整链接。
                        </small>
                      </div>
                      <div className="actions">
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
              </section>
              <div className="note">
                <Wifi size={18} />
                <p>
                  设备需要连接同一个局域网。首次开启时，请允许系统防火墙接受局域网连接；访客网络可能禁止设备互访。
                </p>
              </div>
            </>
          )}
          {page === 'devices' && admin && (
            <>
              <section className="panel">
                <div className="section-head">
                  <h2>设备列表</h2>
                  <Button onClick={() => setModal('clearDevices')}>
                    <Trash2 size={16} />
                    清理离线历史
                  </Button>
                </div>
                {admin.devices.length ? (
                  <div className="device-list">
                    {admin.devices.map((d) => (
                      <div className="device-record" key={d.id}>
                        <span className="device-icon">
                          {/iPhone|Android|手机/.test(d.platform) ? (
                            <Smartphone size={23} />
                          ) : (
                            <Monitor size={23} />
                          )}
                        </span>
                        <div>
                          <strong>{d.name}</strong>
                          <p>
                            {d.platform} · {d.ip}
                          </p>
                          <small>
                            首次连接 {date(d.firstSeen)}
                            <br />
                            最近连接 {date(d.lastSeen)}
                            {d.disconnectedAt && <> · 断开 {date(d.disconnectedAt)}</>}
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
                  </div>
                ) : (
                  <Empty icon={<Monitor size={28} />} title="还没有连接记录">
                    开启中转站，让其他设备扫码连接。
                  </Empty>
                )}
              </section>
              <section className="panel connection-history">
                <div className="section-head">
                  <h2>连接时间线</h2>
                  <span className="subtle">显示最近 500 次，完整记录保存在数据库</span>
                </div>
                {admin.connections.length ? (
                  <div className="timeline">
                    {admin.connections.map((c) => (
                      <div key={c.id}>
                        <span className="dot" />
                        <strong>{c.name}</strong>
                        <span>{c.ip}</span>
                        <p>
                          {date(c.connectedAt)} 连接 →{' '}
                          {c.disconnectedAt ? `${date(c.disconnectedAt)} 断开` : '当前连接中'}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="subtle">设备连接与断开后会自动记录。</p>
                )}
              </section>
            </>
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
              <section className="panel records-panel">
                {historyRows.length ? (
                  <div className="record-table">
                    <div className="record-header">
                      <span>文件 / 大小</span>
                      <span>发送 → 接收</span>
                      <span>时间 / 耗时</span>
                      <span>状态</span>
                    </div>
                    {historyRows.map((t) => (
                      <div className="record-row" key={`${t.stationId}:${t.id}`}>
                        <div>
                          <strong>{t.name}</strong>
                          <small>{sizes(t.size)}</small>
                        </div>
                        <div>
                          {t.senderName}
                          <ArrowUpRight size={13} />
                          {t.recipientName}
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
                    记录会持续保存；中转文件清理后，记录仍然保留。
                  </Empty>
                )}
              </section>
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
                  <small>收发记录、设备历史与设置</small>
                </section>
              </div>
              <section className="panel paths">
                <div>
                  <h3>中转文件位置</h3>
                  <code>{admin.settings.cacheDir}</code>
                  <Button onClick={() => void run(() => window.relay3!.openDirectory('cache'))}>
                    <FolderOpen size={16} />
                    打开目录
                  </Button>
                </div>
                <div>
                  <h3>SQLite 数据库位置</h3>
                  <code>{admin.databasePath}</code>
                  <div className="actions">
                    <Button onClick={() => void run(() => window.relay3!.openDirectory('data'))}>
                      <FolderOpen size={16} />
                      打开目录
                    </Button>
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
                  </div>
                </div>
                <div>
                  <h3>接收文件位置</h3>
                  <code>{admin.settings.receiveDir}</code>
                  <Button onClick={() => void run(() => window.relay3!.openDirectory('receive'))}>
                    <FolderOpen size={16} />
                    打开目录
                  </Button>
                </div>
              </section>
              <section className="panel">
                <div className="section-head">
                  <div>
                    <h2>当前存储的文件</h2>
                    <p className="subtle">
                      传输完成后 {admin.settings.retentionHours} 小时自动清理，仅清理中转缓存。
                    </p>
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
                          cache.entries.filter((e) => !e.busy).every((e) => selected.includes(e.id))
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
                    {cache.entries.map((e) => (
                      <label className="cache-row" key={e.folder + e.id}>
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
                            {sizes(e.bytes)} · {e.folder === 'partial' ? '未完成上传' : '完整缓存'}
                            <br />
                            {e.expiresAt
                              ? `自动清理：${date(e.expiresAt)}`
                              : '尚未进入自动清理计时'}
                          </small>
                        </div>
                        <Badge status={e.status} />
                      </label>
                    ))}
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
                    <p className="subtle">这些是已保存的正式文件，不会自动清理。</p>
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
                {received.length ? (
                  received.map((f) => (
                    <label className="cache-row received-row" key={f.id}>
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
                          {sizes(f.size)} · {date(f.receivedAt)}
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
              </section>
              <p className="storage-footnote">
                手动清理缓存不会删除收发记录，也不会删除接收端已保存的文件。数据库历史如需清理，请到对应记录页面操作。
              </p>
            </>
          )}
          {page === 'settings' && (
            <section className="panel settings-panel">
              <h2>终端设置</h2>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    if (desktop) {
                      setAdmin(await management('/settings', form));
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
                    inform('设置已保存');
                  });
                }}
              >
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
                        <small>默认 1 小时，修改后适用于现有已完成缓存</small>
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
                            ? '迁移前需关闭中转站；请选择空目录，已有缓存会一并迁移。'
                            : '接收文件自动保存到此目录，同名文件会自动编号。'}
                        </small>
                      </label>
                    ))}
                  </>
                )}
                <Button type="submit" kind="primary" disabled={busy}>
                  保存设置
                </Button>
              </form>
              {!desktop && (
                <div className="note">
                  <Smartphone size={18} />
                  <p>
                    手机通过浏览器下载文件。保存位置由系统决定；确认收到后，中转站才开始清理计时。
                  </p>
                </div>
              )}
              <div className="identity-panel">
                <h3>设备身份</h3>
                <code>{boot?.deviceId ?? mobileId.current}</code>
                <p>
                  更换身份会断开当前连接、取消未完成传输，并清除本终端记住的配对凭证。设备名称、已接收文件和收发历史保留。
                </p>
                <Button kind="danger" disabled={busy} onClick={() => setModal('resetIdentity')}>
                  更换设备身份
                </Button>
              </div>
              <div className="settings-note">
                <h3>记录一直保留</h3>
                <p>收发记录和连接历史不自动清理。清理中转缓存只释放文件空间。</p>
              </div>
            </section>
          )}
        </main>
      </div>
      {modal === 'connect' && (
        <Modal title="连接中转站" onClose={() => setModal(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => join());
            }}
          >
            <label>
              中转站地址或配对链接
              <input
                required
                placeholder="http://192.168.1.8:42830"
                value={connectUrl}
                onChange={(e) => setConnectUrl(e.target.value)}
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
              <small>输入中转站地址后，填写其页面显示的 6 位数字。完整配对链接无需另外填写。</small>
            </label>
            <Button type="submit" kind="primary" disabled={busy}>
              连接
            </Button>
          </form>
          {Object.keys(savedHubs).length > 0 && (
            <div className="remembered">
              <h3>连接过的中转站</h3>
              {Object.values(savedHubs).map((s) => (
                <Button key={s.base} onClick={() => void run(() => join(s.base, ''))}>
                  {s.stationName}
                  <small>{s.base}</small>
                </Button>
              ))}
            </div>
          )}
        </Modal>
      )}
      {modal === 'copy' && (
        <Modal title="手动复制" onClose={() => setModal(null)}>
          <p>浏览器未允许自动复制，请长按或选中下面的内容复制。</p>
          <textarea
            aria-label="待复制内容"
            readOnly
            value={copyValue}
            onFocus={(e) => e.target.select()}
          />
          <Button onClick={() => setModal(null)}>完成</Button>
        </Modal>
      )}
      {modal && modal !== 'connect' && modal !== 'copy' && (
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
        >
          <p>
            {modal === 'resetIdentity'
              ? '更换后需要重新配对。当前连接和未完成传输会终止，收发记录及已接收文件保留。'
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
                    const stopped = await management<AdminState>('/station/stop', { force: true });
                    setAdmin(stopped);
                    if (session?.stationId === stopped.settings.stationId) disconnect();
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
        </Modal>
      )}
      {!desktop && !session && pairing && modal !== 'connect' && (
        <div className="join-banner">
          <span>已识别中转站配对码</span>
          <Button kind="primary" onClick={() => setModal('connect')}>
            连接设备
          </Button>
        </div>
      )}
    </div>
  );
}
