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
  connected,
  visible,
  latestId,
  onDisconnect,
  onCopy,
  onRead,
  management,
  preserveView = false,
}: {
  session: Session;
  connected: boolean;
  visible: boolean;
  latestId: number;
  onDisconnect: () => void;
  onCopy: (text: string) => Promise<void>;
  onRead: () => void;
  management?: (url: string, body?: unknown) => Promise<any>;
  preserveView?: boolean;
}) {
  const [identity, setIdentity] = useState<ChatIdentity | null>(null),
    [info, setInfo] = useState<Info | null>(null);
  const [rows, setRows] = useState<ChatMessage[]>([]),
    [snapshot, setSnapshot] = useState({ cursor: 0, unread: 0 });
  const [plainText, setPlainText] = useState('');
  const [text, setText] = useState(''),
    [mode, setMode] = useState<'plain' | 'encrypted'>('plain');
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
  const draftId = useRef(uuid());
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const scrollPosition = useRef(0);
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
          })
        : null;
    if (content !== null) return { text: content, open: true };
    if (!phrases.current.has(m.id)) phrases.current.set(m.id, hiddenPhrase());
    return { text: phrases.current.get(m.id)!, open: false };
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
    setRows(page.items);
    phrases.current.clear();
    if (ack && visibleRef.current) await acknowledge(page.items.at(-1)?.id ?? page.latestId);
    requestAnimationFrame(() => {
      if (feed.current && visibleRef.current)
        feed.current.scrollTop = scroll === 'end' ? feed.current.scrollHeight : 0;
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
  }, [latestId, visible, connected, identity]);
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
      .then((result) => !dead && setCipherRows(result))
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
        {!encrypted && (
          <div className="chat-compose-options">
            <button
              type="button"
              className="chat-encrypt-action"
              onClick={() => setMode('encrypted')}
            >
              <LockKeyhole size={17} /> 发送密文
            </button>
            <span className="subtle">文字原样展示</span>
          </div>
        )}
        <label className="chat-message-label">
          <span className="chat-input-label">文字消息</span>
          <textarea
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
            <fieldset className="chat-recipients">
              <legend>密文接收设备 · 含发送者</legend>
              {selected.some((id) => !devices.some((d) => d.id === id && d.publicKey)) && (
                <div className="notice">
                  接收名单包含已清除或密钥不可用的设备。
                  <button
                    type="button"
                    onClick={() => {
                      setSelected((ids) =>
                        ids.filter((id) => devices.some((d) => d.id === id && d.publicKey)),
                      );
                      draftId.current = uuid();
                    }}
                  >
                    移除失效接收设备
                  </button>
                </div>
              )}
              {devices.map((d) => (
                <label key={d.id}>
                  <input
                    type="checkbox"
                    checked={selected.includes(d.id)}
                    disabled={d.id === session.id || !d.publicKey || busy}
                    onChange={(e) => {
                      setSelected((ids) =>
                        e.target.checked ? [...ids, d.id] : ids.filter((id) => id !== d.id),
                      );
                      draftId.current = uuid();
                    }}
                  />
                  <DeviceAvatar id={d.id} name={d.name} size={28} />
                  <span>
                    {d.name}
                    <DeviceTag platform={d.platform} />
                    {d.id === session.id ? '（本机，固定包含）' : ''}
                    <small>
                      {d.online ? '在线' : '离线，上线后可读取'}
                      {!d.publicKey ? ' · 尚未登记公钥，不可选' : ''}
                      {recent[d.id] ? ' · 最近选过' : ''}
                    </small>
                  </span>
                </label>
              ))}
            </fieldset>
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

        <div className="chat-send-row">
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
        <section className="panel">
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
          {[true, false].map((online) => (
            <div className="chat-device-group" key={String(online)}>
              <h3>
                {online ? '在线' : '离线'} · {devices.filter((d) => d.online === online).length}
              </h3>
              {devices
                .filter((d) => d.online === online)
                .map((d) => (
                  <div className="chat-device" key={d.id}>
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
          <pre className={!value.open ? 'locked-text' : ''}>{value.text}</pre>
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
              if (el)
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
                void load(`&before=${rows[0].id}`, 'start').catch((e) => setError(e.message));
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
            <div className="chat-info">{renderInfo()}</div>
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
            <div className="chat-modal-content">
              {cipherRows.items.map(renderMessage)}
              {!cipherRows.items.length && <p>暂无密文消息</p>}
            </div>
            <div className="chat-pagination">
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
