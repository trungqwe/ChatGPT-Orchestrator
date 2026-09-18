const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  selectFolder: () => ipcRenderer.invoke('dialog:openDirectory'),
  sendToIde: (prompt, projectKeyword) => ipcRenderer.invoke('antigravity:sendToIde', { prompt, projectKeyword })
});
