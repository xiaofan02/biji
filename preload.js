const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('biji', {
  settings: {
    get: (key) => ipcRenderer.invoke('settings:get', key),
    set: (key, value) => ipcRenderer.invoke('settings:set', key, value),
    all: () => ipcRenderer.invoke('settings:all')
  },
  fs: {
    list: (dir) => ipcRenderer.invoke('fs:list', dir),
    read: (p) => ipcRenderer.invoke('fs:read', p),
    write: (p, content) => ipcRenderer.invoke('fs:write', p, content),
    create: (parent, name, isDir) => ipcRenderer.invoke('fs:create', parent, name, isDir),
    rename: (oldP, newP) => ipcRenderer.invoke('fs:rename', oldP, newP),
    delete: (p) => ipcRenderer.invoke('fs:delete', p),
    workspace: () => ipcRenderer.invoke('fs:workspace'),
    search: (q) => ipcRenderer.invoke('fs:search', q),
    saveImage: (notePath, data, ext) => ipcRenderer.invoke('fs:save-image', notePath, data, ext)
  },
  ai: {
    chat: (payload) => ipcRenderer.invoke('ai:chat', payload),
    test: (provider) => ipcRenderer.invoke('ai:test', provider),
    onStream: (reqId, cb) => {
      const listener = (_e, chunk) => cb(chunk);
      ipcRenderer.on(`ai:stream:${reqId}`, listener);
      return () => ipcRenderer.removeListener(`ai:stream:${reqId}`, listener);
    },
    onDone: (reqId, cb) => {
      const listener = () => cb();
      ipcRenderer.once(`ai:done:${reqId}`, listener);
      return () => ipcRenderer.removeListener(`ai:done:${reqId}`, listener);
    }
  },
  ssh: {
    connect: (cfg) => ipcRenderer.invoke('ssh:connect', cfg),
    write: (id, data) => ipcRenderer.invoke('ssh:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.invoke('ssh:resize', id, cols, rows),
    close: (id) => ipcRenderer.invoke('ssh:close', id)
  },
  telnet: {
    connect: (cfg) => ipcRenderer.invoke('telnet:connect', cfg),
    write: (id, data) => ipcRenderer.invoke('telnet:write', id, data),
    close: (id) => ipcRenderer.invoke('telnet:close', id)
  },
  term: {
    onData: (id, cb) => {
      const listener = (_e, data) => cb(data);
      ipcRenderer.on(`term:data:${id}`, listener);
      return () => ipcRenderer.removeListener(`term:data:${id}`, listener);
    },
    onClose: (id, cb) => {
      const listener = () => cb();
      ipcRenderer.on(`term:close:${id}`, listener);
      return () => ipcRenderer.removeListener(`term:close:${id}`, listener);
    },
    onError: (id, cb) => {
      const listener = (_e, msg) => cb(msg);
      ipcRenderer.on(`term:error:${id}`, listener);
      return () => ipcRenderer.removeListener(`term:error:${id}`, listener);
    }
  },
  menu: {
    on: (channel, cb) => {
      const listener = (_e, ...args) => cb(...args);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    }
  },
  sys: {
    openExternal: (url) => ipcRenderer.invoke('sys:open-external', url),
    showInFolder: (p) => ipcRenderer.invoke('sys:show-in-folder', p),
    chooseFile: () => ipcRenderer.invoke('sys:choose-file'),
    chooseFolder: () => ipcRenderer.invoke('sys:choose-folder'),
    chooseImage: () => ipcRenderer.invoke('sys:choose-image'),
    readFile: (p) => ipcRenderer.invoke('sys:read-file', p)
  },
  md: {
    render: (text) => ipcRenderer.invoke('md:render', text)
  }
});
