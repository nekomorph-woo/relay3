import { EmojiButton } from '../emoji/EmojiButton';
import { EmojiText } from '../emoji/EmojiText';
import { FileTask, UnknownFile, type LocalFile } from '../components/FileTask';
import { Recipients, ReceiveBuffer } from '../components/Recipients';
import { deliverFile } from '../fileDelivery';
import { deliverPackage } from '../packageDelivery';
import { PackageDialog } from '../components/PackageDialog';
import { FileBox } from 'lucide-react';
import { FileUp, File } from 'lucide-react';
import type { Transfer } from '../api';
import type { SharedFile } from '../../server/files';
import { ScrollArea } from '../components/ScrollArea';
import { reportException } from '../diagnostics';
import { useEffect, useRef, useState } from 'react';
import {
  Copy,
  LockKeyhole,
  LockKeyholeOpen,
  Send,
  ChevronLeft,
  ChevronRight,
  X,
  MessageSquare,
  RefreshCw,
  Users,
  Unplug,
  History,
} from 'lucide-react';
import { request, stored, save, date, uuid, type Session } from '../api';
import { generateIdentity, validIdentity, encryptMessage, decryptMessage } from './crypto';
import { hiddenPhrase } from './phrases';
import type { ChatIdentity, ChatMessage, ChatDevice } from './types';
import { ChatCleanup } from './ChatCleanup';
import { ChatDialog } from './ChatDialog';
import { DeviceTag } from '../components/DeviceTag';
import { DeviceAvatar } from '../components/DeviceAvatar';
interface Info {
  stationId: string;
  stationName: string;
  devices: ChatDevice[];
  cursor: number;
  latestId: number;
  unread: number;
}
interface MessagePage {
  items: ChatMessage[];
  total: number;
  latestId: number;
}
export function ChatHall({
  session,
  localFiles = [],
  onFilesChanged,
  transfers,
  connected,
  visible,
  latestId,
  onDisconnect,
  onCopy,
  onRead,
  management,
  preserveView = false,
  supportsPackages = false,
}: {
  localFiles?: LocalFile[];
  onFilesChanged: () => void;
  transfers: Transfer[];
  session: Session;
  connected: boolean;
  visible: boolean;
  latestId: number;
  onDisconnect: () => void;
  onCopy: (text: string) => Promise<void>;
  onRead: () => void;
  management?: (url: string, body?: unknown) => Promise<any>;
  preserveView?: boolean;
  supportsPackages?: boolean;
}) {
  const [identity, setIdentity] = useState<ChatIdentity | null>(null),
    [info, setInfo] = useState<Info | null>(null);
  const [rows, setRows] = useState<ChatMessage[]>([]),
    [snapshot, setSnapshot] = useState({ cursor: 0, unread: 0 });
  const [plainText, setPlainText] = useState('');
  const [text, setText] = useState(''),
    [mode, setMode] = useState<'plain' | 'encrypted'>('plain');
  const [openedPackage, setOpenedPackage] = useState<string | null>(null);
  const [fileComposer, setFileComposer] = useState(false),
    [chatFiles, setChatFiles] = useState<File[]>([]),
    [fileRecipients, setFileRecipients] = useState<string[]>([]),
    [fileBuffer, setFileBuffer] = useState(stored('relay3-receive-buffer', 1440));
  const fileDraftIds = useRef(new WeakMap<File, string>());
  const [fileStates, setFileStates] = useState<Record<string, SharedFile>>({});
  const [remark, setRemark] = useState(''),
    [remarkStyle, setRemarkStyle] = useState<'hint' | 'note' | 'clue'>('note');
  const [selected, setSelected] = useState<string[]>([session.id]),
    [recent, setRecent] = useState<Record<string, number>>(
      stored(`relay3-chat-recent:${session.stationId}:${session.id}`, {}),
    );
  const [error, setErrorState] = useState(''),
    [busy, setBusy] = useState(false),
    [copied, setCopied] = useState<number | null>(null);
  function setError(message: string) {
    if (message) reportException('chat.operation-failed', new Error(message));
    setErrorState(message);
  }
  const [modal, setModal] = useState(false),
    [modalPage, setModalPage] = useState(0),
    [modalRange, setModalRange] = useState<{ after?: number; upper?: number }>({});
  const [cipherRows, setCipherRows] = useState<MessagePage>({ items: [], total: 0, latestId: 0 });
  const [infoExpanded, setInfoExpanded] = useState(false);
  const [cleanup, setCleanup] = useState(false),
    [tracking, setTracking] = useState(true);
  const feed = useRef<HTMLDivElement>(null),
    initialized = useRef(false),
    entry = useRef(false),
    sequence = useRef(0),
    phrases = useRef(new Map<number, string>());
  const plainInput = useRef<HTMLTextAreaElement>(null),
    encryptedInput = useRef<HTMLTextAreaElement>(null);
  const draftId = useRef(uuid());
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const scrollPosition = useRef(0);
  const positioningFeed = useRef(false);
  const cipherFeed = useRef<HTMLDivElement>(null);
  const api = <T,>(url: string, body?: unknown) =>
    request<T>(session.base, session.token, '/api/chat' + url, body);
  function display(m: ChatMessage) {
    if (m.mode === 'plain') return { text: m.content ?? '', open: true };
    const content =
      identity && m.envelope
        ? decryptMessage(m.envelope, identity, session.id, {
            stationId: session.stationId,
            senderId: m.senderId,
            remark: m.remark,
            remarkStyle: m.remarkStyle,
            ...(m.kind === 'file'
              ? { purpose: 'file-name' as const, fileId: m.fileId! }
              : m.kind === 'package'
                ? { purpose: 'file-package' as const, fileId: m.packageId! }
                : {}),
          })
        : null;
    if (content !== null) return { text: content, open: true };
    if (m.kind === 'file' || m.kind === 'package') return { text: '未知文件', open: false };
    if (!phrases.current.has(m.id)) phrases.current.set(m.id, hiddenPhrase());
    return { text: phrases.current.get(m.id)!, open: false };
  }
  useEffect(() => {
    if (!connected || !visible) return;
    let dead = false;
    const ids = [
      ...new Set(rows.filter((m) => m.kind === 'file' && m.fileId).map((m) => m.fileId!)),
    ];
    void Promise.all(
      ids.map(
        async (id) =>
          [id, await request<SharedFile>(session.base, session.token, `/api/files/${id}`)] as const,
      ),
    )
      .then((entries) => {
        if (!dead) setFileStates(Object.fromEntries(entries));
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [rows, transfers, connected, visible, session.token]);
  async function sendFiles() {
    if (!identity || !info || !chatFiles.length || !fileRecipients.length) return;
    setBusy(true);
    setError('');
    try {
      const recipients = [session.id, ...fileRecipients].map((id) => {
        const d = info.devices.find((d) => d.id === id);
        if (!d?.publicKey) throw new Error('设备公钥不可用，请刷新列表');
        return { id, publicKey: d.publicKey };
      });
      save('relay3-receive-buffer', fileBuffer);
      if (supportsPackages) {
        const result = await deliverPackage(session, chatFiles, fileRecipients, fileBuffer, {
          keys: recipients,
          remark,
          remarkStyle,
        });
        setChatFiles([]);
        if (result.state !== 'ready') setOpenedPackage(result.id);
      } else {
        for (const file of chatFiles) {
          const id = fileDraftIds.current.get(file) ?? uuid();
          fileDraftIds.current.set(file, id);
          const envelope = encryptMessage(
            file.name,
            recipients,
            {
              stationId: session.stationId,
              senderId: session.id,
              remark,
              remarkStyle,
              purpose: 'file-name',
              fileId: id,
            },
            id,
          );
          await deliverFile(session, file, fileRecipients, fileBuffer, {
            id,
            envelope,
            remark,
            remarkStyle,
          });
          setChatFiles((old) => old.filter((f) => f !== file));
        }
      }
      const nextRecent = { ...recent };
      for (const id of fileRecipients) nextRecent[id] = Date.now();
      setRecent(nextRecent);
      save(`relay3-chat-recent:${session.stationId}:${session.id}`, nextRecent);
      setFileComposer(false);
      setRemark('');
      onFilesChanged();
      setTracking(true);
      await load('', 'end', true);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function copyMessage(m: ChatMessage) {
    try {
      const value = display(m);
      await onCopy(value.open ? value.text : JSON.stringify(m.envelope));
      setCopied(m.id);
    } catch (e: any) {
      setError(e.message);
    }
  }
  async function refreshInfo() {
    const next = await api<Info>('/info');
    setInfo(next);
    return next;
  }
  async function acknowledge(id: number) {
    await api('/read', { messageId: id });
    onRead();
  }
  async function load(query = '', scroll: 'start' | 'end' = 'end', ack = false) {
    const current = ++sequence.current;
    const page = await api<MessagePage>('/messages?limit=50' + query);
    if (current !== sequence.current) return;
    if (!page.items.length && query && !ack) {
      setError('这个方向已没有更多消息');
      return;
    }
    positioningFeed.current = true;
    setRows(page.items);
    phrases.current.clear();
    if (ack && visibleRef.current) await acknowledge(page.items.at(-1)?.id ?? page.latestId);
    requestAnimationFrame(() => {
      if (current !== sequence.current) return;
      if (feed.current && visibleRef.current)
        feed.current.scrollTop = scroll === 'end' ? feed.current.scrollHeight : 0;
      requestAnimationFrame(() => {
        if (current === sequence.current) positioningFeed.current = false;
      });
    });
  }
  useEffect(() => {
    if (!connected) return;
    let dead = false;
    initialized.current = false;
    entry.current = false;
    setIdentity(null);
    async function init() {
      const keyName = `relay3-chat-key:${session.id}`;
      const key = window.relay3
        ? await window.relay3.chatIdentity()
        : (stored<ChatIdentity | null>(keyName, null) ?? generateIdentity());
      if (!validIdentity(key)) throw new Error('本机聊天密钥无法读取，请在设置中更换设备身份');
      if (!window.relay3) save(keyName, key);
      await api('/key', { publicKey: key.publicKey });
      const next = await api<Info>('/info');
      if (dead) return;
      setIdentity(key);
      setInfo(next);
      initialized.current = true;
    }
    void init().catch((e) => !dead && setError(e.message));
    const timer = setInterval(
      () =>
        void api<Info>('/info')
          .then((next) => !dead && setInfo(next))
          .catch((e) => !dead && setError(e.message)),
      30000,
    );
    return () => {
      dead = true;
      clearInterval(timer);
      initialized.current = false;
    };
  }, [session.base, session.id, session.token, connected]);
  useEffect(() => {
    if (!visible) {
      if (!preserveView) entry.current = false;
      sequence.current++;
      setModal(false);
      setCleanup(false);
      setInfoExpanded(false);
      setMode('plain');
      return;
    }
    if (!connected || !identity || !initialized.current || entry.current) return;
    entry.current = true;
    let dead = false;
    let loaded = false;
    void (async () => {
      const next = await refreshInfo();
      if (dead) return;
      setSnapshot({ cursor: next.cursor, unread: next.unread });
      setTracking(true);
      await load(`&upper=${next.latestId}`, 'end', true);
      if (dead) return;
      loaded = true;
      const encrypted = await api<MessagePage>(
        `/messages?mode=encrypted&after=${next.cursor}&upper=${next.latestId}&limit=20&page=0`,
      );
      if (!dead && encrypted.total > 0) {
        setModalRange({ after: next.cursor, upper: next.latestId });
        setModalPage(0);
        setModal(true);
      }
    })().catch((e) => !dead && setError(e.message));
    return () => {
      dead = true;
      if (!loaded) entry.current = false;
    };
  }, [visible, connected, identity, preserveView]);
  useEffect(() => {
    if (
      !visible ||
      !connected ||
      !identity ||
      !entry.current ||
      !tracking ||
      latestId <= (rows.at(-1)?.id ?? 0)
    )
      return;
    void load(`&upper=${latestId}`, 'end', true).catch((e) => setError(e.message));
  }, [latestId, visible, connected, identity, tracking]);
  useEffect(() => {
    if (visible && preserveView)
      requestAnimationFrame(() => {
        if (feed.current) feed.current.scrollTop = scrollPosition.current;
      });
  }, [visible]);
  useEffect(() => {
    if (!modal) return;
    let dead = false;
    const query = new URLSearchParams({ mode: 'encrypted', limit: '20', page: String(modalPage) });
    if (modalRange.after !== undefined) query.set('after', String(modalRange.after));
    if (modalRange.upper !== undefined) query.set('upper', String(modalRange.upper));
    void api<MessagePage>('/messages?' + query)
      .then((result) => {
        if (dead) return;
        setCipherRows(result);
        requestAnimationFrame(() => {
          if (!dead && cipherFeed.current) cipherFeed.current.scrollTop = 0;
        });
      })
      .catch((e) => !dead && setError(e.message));
    return () => {
      dead = true;
    };
  }, [modal, modalPage, modalRange]);
  const encryptedText = text;
  async function send(sendMode: 'plain' | 'encrypted') {
    const text = sendMode === 'plain' ? plainText : encryptedText;
    const mode = sendMode;
    if (!text.trim() || [...text].length > 10000 || [...remark].length > 1000 || !identity || !info)
      return;
    setBusy(true);
    setError('');
    try {
      if (
        mode === 'encrypted' &&
        selected.some((id) => !info.devices.some((d) => d.id === id && d.publicKey))
      )
        throw new Error('所选设备已被清除或密钥不可用，请刷新并重新选择接收设备');
      const recipients = info.devices
        .filter((d) => selected.includes(d.id) && d.publicKey)
        .map((d) => ({ id: d.id, publicKey: d.publicKey! }));
      if (
        mode === 'encrypted' &&
        (!recipients.length || !recipients.some((d) => d.id === session.id))
      )
        throw new Error('发送者密钥尚未就绪，请刷新设备列表');
      const base = {
        clientId: draftId.current,
        mode,
        remark: mode === 'encrypted' ? remark : '',
        remarkStyle,
      };
      const payload =
        mode === 'plain'
          ? { ...base, content: text }
          : {
              ...base,
              envelope: encryptMessage(
                text,
                recipients,
                { stationId: session.stationId, senderId: session.id, remark, remarkStyle },
                draftId.current,
              ),
            };
      await api('/messages', payload);
      if (mode === 'encrypted') {
        const next = { ...recent };
        for (const d of recipients) next[d.id] = Date.now();
        setRecent(next);
        save(`relay3-chat-recent:${session.stationId}:${session.id}`, next);
      }
      if (mode === 'plain') setPlainText('');
      else {
        setText('');
        setRemark('');
        setMode('plain');
      }
      draftId.current = uuid();
      setTracking(true);
      await load('', 'end', true);
      await refreshInfo();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  function renderComposer(encrypted: boolean) {
    return (
      <form
        className="chat-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send(encrypted ? 'encrypted' : 'plain');
        }}
      >
        <div className={encrypted ? 'chat-compose-body' : undefined}>
          {!encrypted && (
            <div className="chat-compose-options">
              <button
                type="button"
                className="chat-encrypt-action"
                onClick={() => setMode('encrypted')}
              >
                <LockKeyhole size={17} />
                <span>发送密文</span>
              </button>
              <button type="button" onClick={() => setFileComposer(true)}>
                <FileUp size={17} />
                <span>发送文件</span>
              </button>
              <span className="subtle">文字原样展示</span>
            </div>
          )}
          <label className="chat-message-label">
            <span className="chat-input-label">文字消息</span>
            <textarea
              ref={encrypted ? encryptedInput : plainInput}
              aria-label="文字消息"
              value={encrypted ? text : plainText}
              onChange={(e) => {
                (encrypted ? setText : setPlainText)(e.target.value);
                draftId.current = uuid();
              }}
              placeholder="输入纯文本、Markdown 或 HTML 原文"
              rows={4}
            />
          </label>
          {encrypted && (
            <>
              <Recipients
                devices={devices}
                selected={selected}
                onChange={(ids) => {
                  setSelected(ids);
                  draftId.current = uuid();
                }}
                encrypted
                disabled={busy}
                fixedIds={[session.id]}
                preserveOrder
              />
              <details className="chat-remark-editor">
                <summary>公开备注（可选）</summary>
                <div className="chat-remark-input">
                  <label>
                    公开备注样式
                    <select
                      value={remarkStyle}
                      onChange={(e) => {
                        setRemarkStyle(e.target.value as any);
                        draftId.current = uuid();
                      }}
                    >
                      <option value="hint">提示</option>
                      <option value="note">说明</option>
                      <option value="clue">线索</option>
                    </select>
                  </label>
                  <label>
                    公开备注
                    <textarea
                      aria-label="公开备注"
                      value={remark}
                      maxLength={1000}
                      onChange={(e) => {
                        setRemark(e.target.value);
                        draftId.current = uuid();
                      }}
                      placeholder="所有设备可见，不会授予解密权限"
                    />
                  </label>
                </div>
              </details>
            </>
          )}
        </div>
        <div className="chat-send-row">
          <EmojiButton
            onSelect={(emoji) => {
              const el = (encrypted ? encryptedInput : plainInput).current;
              const value = encrypted ? text : plainText;
              const start = el?.selectionStart ?? value.length,
                end = el?.selectionEnd ?? start;
              (encrypted ? setText : setPlainText)(
                value.slice(0, start) + emoji + value.slice(end),
              );
              draftId.current = uuid();
              requestAnimationFrame(() => {
                el?.focus();
                el?.setSelectionRange(start + emoji.length, start + emoji.length);
              });
            }}
          />
          <small
            className={[...(encrypted ? text : plainText)].length > 10000 ? 'error-text' : 'subtle'}
          >
            {[...(encrypted ? text : plainText)].length} / 10000 字符
            {!connected ? ' · 连接已断开' : ''}
          </small>
          <button
            type="submit"
            className="primary"
            disabled={
              busy ||
              !connected ||
              !identity ||
              !(encrypted ? text : plainText).trim() ||
              [...(encrypted ? text : plainText)].length > 10000 ||
              (encrypted && [...remark].length > 1000)
            }
          >
            <Send size={16} />
            {busy ? '发送中' : encrypted ? '发送密文消息' : '发送文字'}
          </button>
        </div>
      </form>
    );
  }
  function renderInfo() {
    return (
      <>
        {' '}
        <section className="panel">
          <h2>中转站信息</h2>
          <strong>{info?.stationName ?? session.stationName}</strong>
          <p>{session.base}</p>
          <p>
            {connected ? '已连接' : '已断开 · 设备信息暂未更新'} ·{' '}
            {devices.filter((d) => d.online).length} 台在线
          </p>
          <small>文字历史保存在中转站</small>
        </section>
        <section className="panel chat-devices-panel">
          <div className="section-head">
            <h2>连接设备</h2>
            <button
              title="刷新设备信息"
              aria-label="刷新设备信息"
              onClick={() => void refreshInfo().catch((e) => setError(e.message))}
            >
              <RefreshCw size={16} />
            </button>
          </div>
          <small>每 30 秒刷新</small>
          <ScrollArea
            memoryKey={`chat-devices:${session.stationId}`}
            className="chat-devices-list"
            tabIndex={0}
            aria-label="大厅设备信息"
          >
            {[true, false].map((online) => (
              <div className="chat-device-group" key={String(online)}>
                <h3>
                  {online ? '在线' : '离线'} · {devices.filter((d) => d.online === online).length}
                </h3>
                {devices
                  .filter((d) => d.online === online)
                  .map((d) => (
                    <div className="chat-device" key={d.id} data-scroll-id={d.id}>
                      <DeviceAvatar
                        id={d.id}
                        name={d.name}
                        size={28}
                        className="chat-device-avatar"
                      />
                      <div>
                        <strong>
                          {d.name}
                          <DeviceTag platform={d.platform} />
                        </strong>
                        <small>
                          {d.platform}
                          {d.publicKey ? ' · 已登记公钥' : ' · 暂无公钥'}
                        </small>
                      </div>
                    </div>
                  ))}
              </div>
            ))}
          </ScrollArea>
        </section>
      </>
    );
  }
  function renderMessage(m: ChatMessage) {
    const value = display(m);
    return (
      <article
        className={`bbs-message ${m.senderId === session.id ? 'own-message' : ''}`}
        key={m.id}
        data-message-id={m.id}
      >
        <DeviceAvatar id={m.senderId} name={m.senderName} className="bbs-avatar" />
        <div className="bbs-body">
          <header>
            <strong>
              {m.senderName}
              <DeviceTag
                platform={m.senderPlatform ?? devices.find((d) => d.id === m.senderId)?.platform}
              />
            </strong>
            {m.mode === 'encrypted' && (
              <span
                title={value.open ? '已在本机解密' : '未获授权或本机密钥不可用'}
                aria-label={value.open ? '已解密' : '密文锁定'}
              >
                {value.open ? <LockKeyholeOpen size={16} /> : <LockKeyhole size={16} />}
              </span>
            )}
            <time>{date(m.createdAt)}</time>
            <button
              className="bbs-copy"
              title={value.open ? '复制消息内容' : '复制实际密文'}
              aria-label={value.open ? '复制消息内容' : '复制实际密文'}
              onClick={() => void copyMessage(m)}
            >
              <Copy size={16} />
            </button>
          </header>
          {m.remark && (
            <aside className="chat-remark">
              <pre>
                <strong>{{ hint: '提示', note: '说明', clue: '线索' }[m.remarkStyle]}</strong>：
                {m.remark}
              </pre>
              <button
                title="复制公开备注"
                aria-label="复制公开备注"
                onClick={() => void onCopy(m.remark).catch((e) => setError(e.message))}
              >
                <Copy size={14} />
              </button>
            </aside>
          )}
          {m.kind === 'package' ? (
            <button
              className="chat-package-button"
              type="button"
              onClick={() => {
                if (value.open && m.packageId) setOpenedPackage(m.packageId);
              }}
              disabled={!value.open}
              aria-label={value.open ? '打开文件包' : '未知文件包'}
            >
              <FileBox size={24} />
              <span>{value.open ? '文件包 · 点击查看' : '未知文件包'}</span>
            </button>
          ) : m.kind === 'file' ? (
            <div className="chat-file-message">
              {value.open ? (
                <>
                  <strong>
                    <File size={18} />
                    {value.text}
                  </strong>
                  {transfers
                    .filter((t) => t.fileId === m.fileId)
                    .map((t) => (
                      <div key={t.id}>
                        <small>
                          {t.senderId === session.id ? `发送给 ${t.recipientName}` : ''}
                        </small>
                        <FileTask
                          t={t}
                          session={session}
                          localFiles={localFiles}
                          name={value.text}
                          onUpdated={onFilesChanged}
                          onError={setError}
                        />
                      </div>
                    ))}
                </>
              ) : (
                <UnknownFile cleaned={!!fileStates[m.fileId!]?.cleanedAt} />
              )}
            </div>
          ) : (
            <pre className={!value.open ? 'locked-text' : ''}>
              <EmojiText text={value.text} />
            </pre>
          )}
          {copied === m.id && (
            <small role="status">{value.open ? '已复制正文' : '已复制实际密文'}</small>
          )}
        </div>
      </article>
    );
  }
  const devices = [...(info?.devices ?? [])].sort(
    (a, b) =>
      Number(b.online) - Number(a.online) ||
      (recent[b.id] ?? 0) - (recent[a.id] ?? 0) ||
      a.name.localeCompare(b.name, 'zh-CN'),
  );
  return (
    <div hidden={!visible} className="chat-hall">
      {error && (
        <div className="notice error" role="alert">
          {error}
          <button aria-label="关闭聊天提示" onClick={() => setError('')}>
            <X size={16} />
          </button>
        </div>
      )}
      <div className="chat-layout">
        <section className="panel chat-main">
          <header className="chat-room-head">
            <div>
              <h1>群聊大厅</h1>
            </div>
            <div className="page-actions">
              <button
                className="chat-details-action"
                title="大厅信息"
                aria-label="大厅信息"
                onClick={() => setInfoExpanded(true)}
              >
                <Users size={20} />
              </button>
              <button
                className="chat-disconnect-action"
                aria-label="断开中转站"
                title="断开中转站"
                onClick={onDisconnect}
              >
                <Unplug size={16} />
              </button>
            </div>
          </header>
          <div className="chat-toolbar">
            <button
              disabled={!snapshot.unread || busy}
              onClick={() => {
                setTracking(false);
                void load(`&after=${snapshot.cursor}`, 'start').catch((e) => setError(e.message));
              }}
            >
              <History size={15} />
              跳转上次未读{snapshot.unread ? ` · ${snapshot.unread} 条` : ''}
            </button>
            <button
              onClick={() => {
                setModalRange({});
                setModalPage(0);
                setModal(true);
              }}
            >
              <LockKeyhole size={15} />
              密文消息
            </button>
            {management && (
              <button className="chat-clean-action" onClick={() => setCleanup(true)}>
                清理大厅历史
              </button>
            )}
          </div>
          <div
            className="chat-feed"
            ref={feed}
            onScroll={() => {
              const el = feed.current;
              if (el && visible) scrollPosition.current = el.scrollTop;
              if (el && !positioningFeed.current)
                setTracking(
                  (rows.at(-1)?.id ?? 0) >= latestId &&
                    el.scrollHeight - el.scrollTop - el.clientHeight < 80,
                );
            }}
          >
            {!rows.length ? (
              <p className="subtle chat-empty">大厅还没有消息，发一条文字开始交流。</p>
            ) : (
              rows.map(renderMessage)
            )}
          </div>
          <div className="chat-pagination">
            <button
              disabled={!rows.length}
              onClick={() => {
                setTracking(false);
                void load(`&before=${rows[0].id}`, 'end').catch((e) => setError(e.message));
              }}
            >
              <ChevronLeft size={16} />
              更早消息
            </button>
            <button
              disabled={!rows.length}
              onClick={() => {
                setTracking(false);
                void load(`&after=${rows.at(-1)!.id}`, 'start').catch((e) => setError(e.message));
              }}
            >
              较新消息
              <ChevronRight size={16} />
            </button>
            <button
              onClick={() => {
                setTracking(true);
                void load('', 'end', true).catch((e) => setError(e.message));
              }}
            >
              回到最新
            </button>
          </div>
          {renderComposer(false)}
        </section>
        <aside className="chat-info chat-info-desktop">{renderInfo()}</aside>
      </div>
      {openedPackage && visible && (
        <PackageDialog
          id={openedPackage}
          session={session}
          connected={connected}
          devices={info?.devices ?? []}
          localFiles={localFiles}
          onUpdated={onFilesChanged}
          onClose={() => setOpenedPackage(null)}
          onError={setError}
        />
      )}
      {fileComposer && visible && (
        <ChatDialog
          label="发送文件"
          dismissible={false}
          onClose={() => {
            if (!busy) setFileComposer(false);
          }}
        >
          <section className="chat-modal panel encrypted-compose-modal">
            <div className="dialog-head">
              <h2>
                <FileUp size={20} />
                发送文件
              </h2>
              <button
                aria-label="关闭文件发送"
                disabled={busy}
                onClick={() => setFileComposer(false)}
              >
                <X size={18} />
              </button>
            </div>
            <p className="subtle">文件名仅选中设备可解密，文件上传后可离线等待接收。</p>
            {error && (
              <p className="error-text" role="alert">
                {error}
              </p>
            )}
            <form
              className="chat-composer"
              onSubmit={(e) => {
                e.preventDefault();
                void sendFiles();
              }}
            >
              <div className="chat-compose-body">
                <label
                  className="dropzone compact-file-picker"
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const dropped = Array.from(e.dataTransfer.files);
                    setChatFiles((old) => [...old, ...dropped]);
                  }}
                >
                  <FileUp size={26} />
                  <strong>选择文件，或拖到这里</strong>
                  <span>可选择多个文件</span>
                  <input
                    aria-label="选择群聊文件"
                    type="file"
                    multiple
                    onChange={(e) => {
                      const picked = Array.from(e.target.files ?? []);
                      setChatFiles((old) => [...old, ...picked]);
                      e.target.value = '';
                    }}
                  />
                </label>
                <div className="chat-file-selection">
                  {chatFiles.map((f, i) => (
                    <div className="file-line" key={i}>
                      <File size={16} />
                      <span>{f.name}</span>
                      <button
                        type="button"
                        aria-label={`移除 ${f.name}`}
                        onClick={() => setChatFiles((old) => old.filter((_, j) => i !== j))}
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                </div>
                <Recipients
                  devices={devices.filter((d) => d.id !== session.id)}
                  selected={fileRecipients}
                  onChange={setFileRecipients}
                  encrypted
                  preserveOrder
                  disabled={busy}
                />
                <ReceiveBuffer value={fileBuffer} onChange={setFileBuffer} />
                <details className="chat-remark-editor">
                  <summary>公开备注（可选）</summary>
                  <div className="chat-remark-input">
                    <label>
                      备注样式
                      <select
                        value={remarkStyle}
                        onChange={(e) => setRemarkStyle(e.target.value as any)}
                      >
                        <option value="hint">提示</option>
                        <option value="note">说明</option>
                        <option value="clue">线索</option>
                      </select>
                    </label>
                    <label>
                      公开备注
                      <textarea
                        aria-label="文件公开备注"
                        value={remark}
                        maxLength={1000}
                        onChange={(e) => setRemark(e.target.value)}
                        placeholder="所有设备可见，不会授予解密权限"
                      />
                    </label>
                  </div>
                </details>
              </div>
              <div className="chat-send-row">
                <small>
                  {chatFiles.length} 个文件 · {fileRecipients.length} 台接收设备
                </small>
                <button
                  className="primary"
                  type="submit"
                  disabled={
                    busy ||
                    !connected ||
                    !chatFiles.length ||
                    !fileRecipients.length ||
                    fileBuffer < 10 ||
                    fileBuffer > 1440
                  }
                >
                  {busy ? '上传中' : '发送文件'}
                </button>
              </div>
            </form>
          </section>
        </ChatDialog>
      )}
      {mode === 'encrypted' && visible && (
        <ChatDialog
          label="发送密文"
          onClose={() => {
            if (!busy) setMode('plain');
          }}
        >
          <section className="chat-modal panel encrypted-compose-modal">
            <div className="dialog-head">
              <h2>
                <LockKeyhole size={20} />
                发送密文
              </h2>
              <button aria-label="关闭密文输入" disabled={busy} onClick={() => setMode('plain')}>
                <X size={18} />
              </button>
            </div>
            <p className="subtle">只有选中的设备可在本地解密，正文加密后才会发送到中转站。</p>
            {error && (
              <p className="error-text" role="alert">
                {error}
              </p>
            )}
            {renderComposer(true)}
          </section>
        </ChatDialog>
      )}
      {infoExpanded && visible && (
        <ChatDialog label="大厅信息" onClose={() => setInfoExpanded(false)}>
          <section className="chat-modal panel chat-info-drawer">
            <div className="dialog-head">
              <h2>大厅信息</h2>
              <button aria-label="关闭大厅信息" onClick={() => setInfoExpanded(false)}>
                <X size={18} />
              </button>
            </div>
            <div className="chat-info chat-modal-body">{renderInfo()}</div>
          </section>
        </ChatDialog>
      )}
      {modal && visible && (
        <ChatDialog label="密文消息汇总" onClose={() => setModal(false)}>
          <section className="chat-modal panel">
            <div className="dialog-head">
              <h2>
                <MessageSquare size={20} />
                密文消息汇总
              </h2>
              <button aria-label="关闭密文汇总" onClick={() => setModal(false)}>
                <X size={18} />
              </button>
            </div>
            <p className="subtle">
              {modalRange.after !== undefined ? '本次上线前未读的密文' : '全部历史密文'} ·{' '}
              {cipherRows.total} 条，每页 20 条；翻页不改变大厅阅读游标。
            </p>
            <div className="chat-modal-content chat-modal-body" ref={cipherFeed}>
              {cipherRows.items.map(renderMessage)}
              {!cipherRows.items.length && <p>暂无密文消息</p>}
            </div>
            <div className="chat-pagination chat-modal-footer">
              <button disabled={modalPage === 0} onClick={() => setModalPage((p) => p - 1)}>
                上一页
              </button>
              <span>
                {modalPage + 1} / {Math.max(1, Math.ceil(cipherRows.total / 20))}
              </span>
              <button
                disabled={(modalPage + 1) * 20 >= cipherRows.total}
                onClick={() => setModalPage((p) => p + 1)}
              >
                下一页
              </button>
            </div>
          </section>
        </ChatDialog>
      )}
      {cleanup && visible && management && (
        <ChatCleanup
          management={management}
          onClose={() => setCleanup(false)}
          onCleared={() => {
            void refreshInfo().catch((e) => setError(e.message));
            void load('', 'end', true).catch((e) => setError(e.message));
          }}
        />
      )}
    </div>
  );
}
