const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  selectFolder: () => ipcRenderer.invoke('dialog:openDirectory'),
  openFolder: (folderPath) => ipcRenderer.invoke('shell:openPath', folderPath),
  sendToIde: (prompt, projectKeyword) => ipcRenderer.invoke('antigravity:sendToIde', { prompt, projectKeyword })
});
