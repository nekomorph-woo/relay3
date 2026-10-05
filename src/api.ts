import { reportException, setDiagnosticTarget } from './diagnostics';
import type { Device, Transfer, SavedConnection } from '../server/store';
export type { Device, Transfer };
export type Session = SavedConnection;
export interface HubState {
  connectionHeartbeat?: boolean;
  chatLatestId?: number;
  chatUnread?: number;
  stationId: string;
  stationName: string;
  self: Device;
  devices: (Device & { online: boolean })[];
  transfers: Transfer[];
}
export interface Bootstrap {
  controlUrl: string;
  adminToken: string;
  deviceId: string;
  deviceName: string;
  platform: string;
  version: string;
  savedHubs: Record<string, Session>;
  clientView?: { stationId?: string; page?: string };
}
export interface AdminState {
  tasks: import('../server/tasks').BackgroundTask[];
  running: boolean;
  addresses: string[];
  pairingToken: string;
  pairingCode: string;
  pairingCodeExpiresAt: number;
  settings: {
    stationId: string;
    deviceId: string;
    deviceName: string;
    stationName: string;
    cacheDir: string;
    receiveDir: string;
    port: number;
    retentionHours: number;
  };
  dataDir: string;
  databasePath: string;
  sizes: { database: number; wal: number; shm: number };
  devices: (Device & { online: boolean; loginCount: number })[];
  connections: {
    id: number;
    deviceId: string;
    name: string;
    ip: string;
    platform?: string | null;
    connectedAt: number;
    disconnectedAt: number | null;
  }[];
}
export interface CacheState {
  path: string;
  totalBytes: number;
  freeBytes: number;
  entries: {
    id: string;
    folder: string;
    chatMessageId?: number;
    path: string;
    bytes: number;
    name: string;
    status: string;
    expiresAt: number | null;
    busy: boolean;
    createdAt: number;
  }[];
}
declare global {
  interface Window {
    relay3?: {
      startDiscovery(): Promise<import('./discoveryTypes').DiscoverySnapshot>;
      discoverySnapshot(): Promise<import('./discoveryTypes').DiscoverySnapshot>;
      refreshDiscovery(): Promise<import('./discoveryTypes').DiscoverySnapshot>;
      stopDiscovery(): Promise<void>;
      diagnosticInfo(): Promise<{ path: string; crashPath: string; files: number; bytes: number }>;
      exportDiagnostics(): Promise<string | null>;
      clearDiagnostics(): Promise<boolean>;
      reportException(data: Record<string, unknown>): Promise<void>;
      chatIdentity(): Promise<import('./chat/types').ChatIdentity>;
      showAbout(): Promise<void>;
      openGithub(): Promise<void>;
      copyText(text: string): Promise<boolean>;
      bootstrap(): Promise<Bootstrap>;
      pickDirectory(): Promise<string | null>;
      openDirectory(kind: string): Promise<boolean>;
      rememberSource(input: { stationId: string; fileId: string; file: File }): Promise<boolean>;
      canRevealFile(input: {
        kind: 'received' | 'cache' | 'source';
        id: string;
        stationId?: string;
      }): Promise<boolean>;
      revealFile(input: {
        kind: 'received' | 'cache' | 'source';
        id: string;
        stationId?: string;
      }): Promise<boolean>;
      download(input: {
        base: string;
        token: string;
        id: string;
        name: string;
        size: number;
        sha256: string;
        stationId?: string;
        stationName?: string;
      }): Promise<{ path: string; confirmed: boolean }>;
      cancelDownload(id: string, stationId?: string): Promise<boolean>;
      onProgress(
        callback: (data: { id: string; key?: string; stationId?: string; bytes: number }) => void,
      ): () => void;
    };
  }
}
export async function request<T = any>(
  base: string,
  token: string,
  url: string,
  body?: unknown,
): Promise<T> {
  setDiagnosticTarget(base, token);
  try {
    const response = await fetch(base + url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json();
    if (!response.ok)
      throw Object.assign(new Error(data.error ?? '请求失败'), { status: response.status });
    return data;
  } catch (error) {
    reportException('api.failed ' + url.split('?')[0], error, { base });
    throw error;
  }
}
export function uuid() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return [...b].map((v) => v.toString(16).padStart(2, '0')).join('');
}
export function stored<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback;
  } catch {
    return fallback;
  }
}
export function save(key: string, value: unknown) {
  localStorage.setItem(key, JSON.stringify(value));
}
export const sizes = (n: number) => {
  if (n === 0) return '0 B';
  const i = Math.min(4, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${['B', 'KB', 'MB', 'GB', 'TB'][i]}`;
};
export const date = (n: number | null) =>
  n ? new Date(n).toLocaleString('zh-CN', { hour12: false }) : '—';
export const duration = (n: number | null) =>
  n === null
    ? '—'
    : n < 1000
      ? `${n} 毫秒`
      : n < 60_000
        ? `${(n / 1000).toFixed(1)} 秒`
        : `${Math.floor(n / 60_000)} 分 ${Math.round((n % 60_000) / 1000)} 秒`;
export const labels: Record<string, string> = {
  pending: '待接收',
  expired: '超时未处理',
  'receive-expired': '接收超时未完成',
  waiting: '等待上传',
  cleaned: '中转缓存已清理',
  accepted: '等待上传',
  uploading: '上传中',
  ready: '等待接收',
  downloading: '下载中',
  'awaiting-confirm': '待确认收到',
  completed: '已完成',
  rejected: '已拒绝',
  cancelled: '已取消',
  failed: '失败',
  orphan: '未关联文件',
};
export const active = [
  'pending',
  'accepted',
  'uploading',
  'ready',
  'downloading',
  'awaiting-confirm',
];
