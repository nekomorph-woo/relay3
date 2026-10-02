import { writeFileSync } from 'node:fs';
writeFileSync('dist-electron/preload.cjs',`
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('relay3', {
 bootstrap: () => ipcRenderer.invoke('bootstrap'),
 pickDirectory: () => ipcRenderer.invoke('pick-directory'),
 openDirectory: kind => ipcRenderer.invoke('open-directory', kind),
 download: input => ipcRenderer.invoke('download', input),
 cancelDownload: id => ipcRenderer.invoke('cancel-download', id),
 onProgress: callback => { const handler = (_event, data) => callback(data); ipcRenderer.on('download-progress', handler); return () => ipcRenderer.removeListener('download-progress', handler); }
});
`);
