export interface DiscoveredStation {
  stationId: string;
  name: string;
  base: string;
  platform: 'PC' | 'Mac';
  state: 'checking' | 'ready' | 'unreachable';
  onlineDevices?: number;
}

export interface DiscoverySnapshot {
  stations: DiscoveredStation[];
  error?: string;
}
