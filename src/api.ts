import type { Device, Transfer } from '../server/store';
export type { Device, Transfer };
export interface Session {
  base: string;
  token: string;
  id: string;
  stationId: string;
  stationName: string;
}
export interface HubState {
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
}
export interface AdminState {
  running: boolean;
  addresses: string[];
  pairingToken: string;
  settings: {
    stationId: string;
    deviceId: string;
    deviceName: string;
    cacheDir: string;
    receiveDir: string;
    port: number;
    retentionHours: number;
  };
  dataDir: string;
  databasePath: string;
  sizes: { database: number; wal: number; shm: number };
  devices: (Device & { online: boolean })[];
  connections: {
    id: number;
    deviceId: string;
    name: string;
    ip: string;
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
      bootstrap(): Promise<Bootstrap>;
      pickDirectory(): Promise<string | null>;
      openDirectory(kind: string): Promise<boolean>;
      download(input: {
        base: string;
        token: string;
        id: string;
        name: string;
        size: number;
        sha256: string;
      }): Promise<{ path: string; confirmed: boolean }>;
      cancelDownload(id: string): Promise<boolean>;
      onProgress(callback: (data: { id: string; bytes: number }) => void): () => void;
    };
  }
}
export async function request<T = any>(
  base: string,
  token: string,
  url: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(base + url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? '请求失败');
  return data;
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
  pending: '等待确认',
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
