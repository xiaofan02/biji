import { contextBridge, ipcRenderer } from 'electron'

// 预加载桥 —— 由 preload.js 完整移植。导出 BijiApi 类型供渲染层 lib/ipc.ts 引用,形成类型化 IPC 契约。
const api = {
  settings: {
    get: (key: string) => ipcRenderer.invoke('settings:get', key),
    set: (key: string, value: unknown) => ipcRenderer.invoke('settings:set', key, value),
    all: () => ipcRenderer.invoke('settings:all')
  },
  fs: {
    list: (dir?: string) => ipcRenderer.invoke('fs:list', dir),
    read: (p: string) => ipcRenderer.invoke('fs:read', p),
    write: (p: string, content: string) => ipcRenderer.invoke('fs:write', p, content),
    create: (parent: string, name: string, isDir: boolean) => ipcRenderer.invoke('fs:create', parent, name, isDir),
    rename: (oldP: string, newP: string) => ipcRenderer.invoke('fs:rename', oldP, newP),
    delete: (p: string) => ipcRenderer.invoke('fs:delete', p),
    workspace: () => ipcRenderer.invoke('fs:workspace'),
    search: (q: string) => ipcRenderer.invoke('fs:search', q),
    saveImage: (notePath: string, data: Uint8Array, ext: string) => ipcRenderer.invoke('fs:save-image', notePath, data, ext)
  },
  ai: {
    chat: (payload: unknown) => ipcRenderer.invoke('ai:chat', payload),
    test: (provider: unknown) => ipcRenderer.invoke('ai:test', provider),
    onStream: (reqId: string, cb: (chunk: string) => void) => {
      const listener = (_e: unknown, chunk: string) => cb(chunk)
      ipcRenderer.on(`ai:stream:${reqId}`, listener)
      return () => ipcRenderer.removeListener(`ai:stream:${reqId}`, listener)
    },
    onDone: (reqId: string, cb: () => void) => {
      const listener = () => cb()
      ipcRenderer.once(`ai:done:${reqId}`, listener)
      return () => ipcRenderer.removeListener(`ai:done:${reqId}`, listener)
    }
  },
  ssh: {
    connect: (cfg: unknown) => ipcRenderer.invoke('ssh:connect', cfg),
    write: (id: string, data: string) => ipcRenderer.invoke('ssh:write', id, data),
    resize: (id: string, cols: number, rows: number) => ipcRenderer.invoke('ssh:resize', id, cols, rows),
    close: (id: string) => ipcRenderer.invoke('ssh:close', id)
  },
  telnet: {
    connect: (cfg: unknown) => ipcRenderer.invoke('telnet:connect', cfg),
    write: (id: string, data: string) => ipcRenderer.invoke('telnet:write', id, data),
    close: (id: string) => ipcRenderer.invoke('telnet:close', id)
  },
  term: {
    onData: (id: string, cb: (data: string) => void) => {
      const listener = (_e: unknown, data: string) => cb(data)
      ipcRenderer.on(`term:data:${id}`, listener)
      return () => ipcRenderer.removeListener(`term:data:${id}`, listener)
    },
    onClose: (id: string, cb: () => void) => {
      const listener = () => cb()
      ipcRenderer.on(`term:close:${id}`, listener)
      return () => ipcRenderer.removeListener(`term:close:${id}`, listener)
    },
    onError: (id: string, cb: (msg: string) => void) => {
      const listener = (_e: unknown, msg: string) => cb(msg)
      ipcRenderer.on(`term:error:${id}`, listener)
      return () => ipcRenderer.removeListener(`term:error:${id}`, listener)
    }
  },
  menu: {
    on: (channel: string, cb: (...args: unknown[]) => void) => {
      const listener = (_e: unknown, ...args: unknown[]) => cb(...args)
      ipcRenderer.on(channel, listener)
      return () => ipcRenderer.removeListener(channel, listener)
    }
  },
  sys: {
    openExternal: (url: string) => ipcRenderer.invoke('sys:open-external', url),
    showInFolder: (p: string) => ipcRenderer.invoke('sys:show-in-folder', p),
    chooseFile: () => ipcRenderer.invoke('sys:choose-file'),
    chooseFolder: () => ipcRenderer.invoke('sys:choose-folder'),
    chooseImage: () => ipcRenderer.invoke('sys:choose-image'),
    readFile: (p: string) => ipcRenderer.invoke('sys:read-file', p)
  },
  exporter: {
    saveText: (defaultName: string, content: string, filters: { name: string; extensions: string[] }[]) =>
      ipcRenderer.invoke('export:save-text', defaultName, content, filters),
    pdf: (defaultName: string, html: string) => ipcRenderer.invoke('export:pdf', defaultName, html)
  }
}

contextBridge.exposeInMainWorld('biji', api)

export type BijiApi = typeof api
