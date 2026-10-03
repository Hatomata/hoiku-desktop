const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopAPI', {
  // projects (stored as real files in the data folder)
  listProjects: () => ipcRenderer.invoke('projects:list'),
  createProject: (name) => ipcRenderer.invoke('projects:create', name),
  loadProject: (id) => ipcRenderer.invoke('projects:load', id),
  saveProject: (id, project, opts) => ipcRenderer.invoke('projects:save', id, project, opts),
  deleteProject: (id) => ipcRenderer.invoke('projects:delete', id),

  // data folder
  getDataDir: () => ipcRenderer.invoke('data:getDir'),
  openDataDir: () => ipcRenderer.invoke('data:openDir'),
  openBackups: (id) => ipcRenderer.invoke('data:openBackups', id),
  chooseDataDir: () => ipcRenderer.invoke('data:chooseDir'),

  // single-file save (sheet export)
  saveJson: (suggestedName, text, existingPath) => ipcRenderer.invoke('file:saveJson', suggestedName, text, existingPath),

  // app + updates
  getVersion: () => ipcRenderer.invoke('app:version'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateStatus: (cb) => ipcRenderer.on('update:status', (_e, status) => cb(status)),

  // window closing: the page saves, then calls flushDone()
  onFlushRequest: (cb) => ipcRenderer.on('app:flush', () => cb()),
  flushDone: () => ipcRenderer.send('app:flush-done'),

  // screen patches: the page reports it started properly; announcements of new screens
  uiReady: () => ipcRenderer.send('ui:ready'),
  applyUiUpdate: () => ipcRenderer.invoke('ui:apply'),
  onUiStatus: (cb) => ipcRenderer.on('ui:status', (_e, status) => cb(status)),

  // where the ExcelJS copy installed with the app lives (works for patched screens too)
  exceljsUrl: ipcRenderer.sendSync('app:exceljs-url')
});
