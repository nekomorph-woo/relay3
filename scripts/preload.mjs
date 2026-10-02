import { writeFileSync } from 'node:fs';
writeFileSync(
  'dist-electron/preload.cjs',
  `
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('relay3', {
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
 download: input => ipcRenderer.invoke('download', input),
 cancelDownload: id => ipcRenderer.invoke('cancel-download', id),
 onProgress: callback => { const handler = (_event, data) => callback(data); ipcRenderer.on('download-progress', handler); return () => ipcRenderer.removeListener('download-progress', handler); }
});
`,
);
