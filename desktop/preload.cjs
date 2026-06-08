'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('trident', {
  // Task management
  runTask: (task, opts) => ipcRenderer.invoke('run-task', task, opts),
  abortTask: () => ipcRenderer.send('abort-task'),
  onTaskEvent: (cb) => {
    const listener = (_, e) => cb(e);
    ipcRenderer.on('task-event', listener);
    return listener;
  },
  offTaskEvent: (listener) => ipcRenderer.removeListener('task-event', listener),

  // Config
  getConfig: () => ipcRenderer.invoke('get-config'),
  setConfig: (cfg) => ipcRenderer.invoke('set-config', cfg),

  // Sessions
  listSessions: () => ipcRenderer.invoke('list-sessions'),

  // Memory
  getMemory: () => ipcRenderer.invoke('get-memory'),
  setMemory: (content) => ipcRenderer.invoke('set-memory', content),

  // Models
  listModels: () => ipcRenderer.invoke('list-models'),

  // Git
  shellGit: (args) => ipcRenderer.invoke('shell-git', args),

  // File system
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  getProjectTree: (cwd) => ipcRenderer.invoke('get-project-tree', cwd),

  // Utils
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  showNotification: (opts) => ipcRenderer.invoke('show-notification', opts),
  getCwd: () => ipcRenderer.invoke('get-cwd'),

  // Permit rules
  getPermits: () => ipcRenderer.invoke('get-permits'),
  setPermits: (rules) => ipcRenderer.invoke('set-permits', rules),

  // Window controls
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),

  platform: process.platform,
});
