import { writeFileSync } from 'node:fs';
writeFileSync(
  'dist-electron/preload.cjs',
  `
const { contextBridge, ipcRenderer, webUtils } = require('electron');
contextBridge.exposeInMainWorld('relay3', {
 pickFolderFile: () => ipcRenderer.invoke('pick-folder-file'),
 nativeHash: id => ipcRenderer.invoke('native-hash', id),
 releaseNative: id => ipcRenderer.invoke('native-release', id),
 cancelNative: id => ipcRenderer.invoke('native-cancel', id),
 uploadNative: input => ipcRenderer.invoke('native-upload', input),
 reuseSource: input => ipcRenderer.invoke('reuse-source', input),
 onNativeProgress: callback => { const h = (_e,data) => callback(data); ipcRenderer.on('native-progress',h); return () => ipcRenderer.removeListener('native-progress',h); },
 notifyStation: input => ipcRenderer.invoke('notify-station', input),
 onNotification: callback => { const h = (_e,data) => callback(data); ipcRenderer.on('notification-open',h); return () => ipcRenderer.removeListener('notification-open',h); },
 clientActivity: (id, active) => ipcRenderer.invoke('client-activity', id, active),
 diagnoseConnection: (raw, expected, id) => ipcRenderer.invoke('connection-diagnose', raw, expected, id),
 cancelDiagnosis: id => ipcRenderer.invoke('connection-diagnose-cancel', id),
 startDiscovery: () => ipcRenderer.invoke('discovery-start'),
 discoverySnapshot: () => ipcRenderer.invoke('discovery-snapshot'),
 refreshDiscovery: () => ipcRenderer.invoke('discovery-refresh'),
 stopDiscovery: () => ipcRenderer.invoke('discovery-stop'),
 diagnosticInfo: () => ipcRenderer.invoke('diagnostic-info'),
 exportDiagnostics: () => ipcRenderer.invoke('diagnostic-export'),
 clearDiagnostics: () => ipcRenderer.invoke('diagnostic-clear'),
 reportException: data => ipcRenderer.invoke('diagnostic-report', data),
 showAbout: () => ipcRenderer.invoke('show-about'),
 openGithub: () => ipcRenderer.invoke('open-github'),
 copyText: text => ipcRenderer.invoke('clipboard-write', text),
 chatIdentity: () => ipcRenderer.invoke('chat-identity'),
 bootstrap: () => ipcRenderer.invoke('bootstrap'),
 pickDirectory: () => ipcRenderer.invoke('pick-directory'),
 openDirectory: kind => ipcRenderer.invoke('open-directory', kind),
 rememberSource: input => { const path = webUtils.getPathForFile(input.file); return path ? ipcRenderer.invoke('remember-source', { stationId: input.stationId, fileId: input.fileId, path }) : Promise.resolve(false); },
 canRevealFile: input => ipcRenderer.invoke('can-reveal-file', input),
 revealFile: input => ipcRenderer.invoke('reveal-file', input),
 download: input => ipcRenderer.invoke('download', input),
 cancelDownload: (id, stationId) => ipcRenderer.invoke('cancel-download', id, stationId),
 onProgress: callback => { const handler = (_event, data) => callback(data); ipcRenderer.on('download-progress', handler); return () => ipcRenderer.removeListener('download-progress', handler); }
});
`,
);
