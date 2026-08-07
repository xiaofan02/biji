import { contextBridge, ipcRenderer } from 'electron'

// 预加载桥 —— 由 preload.js 完整移植。导出 BijiApi 类型供渲染层 lib/ipc.ts 引用,形成类型化 IPC 契约。
const api = {
  update: {
    getStatus: () => ipcRenderer.invoke('update:get-status'),
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.invoke('update:install') as Promise<boolean>,
    onStatus: (cb: (status: unknown) => void) => {
      const listener = (_e: unknown, status: unknown) => cb(status)
      ipcRenderer.on('update:status', listener)
      return () => {
        ipcRenderer.removeListener('update:status', listener)
      }
    }
  },
  settings: {
    get: (key: string) => ipcRenderer.invoke('settings:get', key),
    set: (key: string, value: unknown) => ipcRenderer.invoke('settings:set', key, value),
    all: () => ipcRenderer.invoke('settings:all')
  },
  // 安全存储(登录令牌经 safeStorage 加密)
  secure: {
    get: (key: string) => ipcRenderer.invoke('secure:get', key) as Promise<string | null>,
    set: (key: string, value: string) => ipcRenderer.invoke('secure:set', key, value) as Promise<boolean>,
    clear: (key: string) => ipcRenderer.invoke('secure:clear', key) as Promise<boolean>
  },
  fs: {
    list: (dir?: string) => ipcRenderer.invoke('fs:list', dir),
    read: (p: string) => ipcRenderer.invoke('fs:read', p),
    readBinary: (p: string) => ipcRenderer.invoke('fs:read-binary', p) as Promise<Uint8Array>,
    writeBinary: (p: string, data: Uint8Array) => ipcRenderer.invoke('fs:write-binary', p, data),
    write: (p: string, content: string) => ipcRenderer.invoke('fs:write', p, content),
    create: (parent: string, name: string, isDir: boolean) => ipcRenderer.invoke('fs:create', parent, name, isDir),
    rename: (oldP: string, newP: string) => ipcRenderer.invoke('fs:rename', oldP, newP),
    delete: (p: string) => ipcRenderer.invoke('fs:delete', p),
    workspace: () => ipcRenderer.invoke('fs:workspace'),
    search: (q: string) => ipcRenderer.invoke('fs:search', q),
    saveImage: (notePath: string, data: Uint8Array, ext: string) => ipcRenderer.invoke('fs:save-image', notePath, data, ext)
  },
  log: {
    start: (id: string, suggestedName: string) => ipcRenderer.invoke('log:start', id, suggestedName),
    append: (id: string, text: string) => ipcRenderer.invoke('log:append', id, text),
    stop: (id: string) => ipcRenderer.invoke('log:stop', id)
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
  serial: {
    list: () => ipcRenderer.invoke('serial:list'),
    connect: (cfg: unknown) => ipcRenderer.invoke('serial:connect', cfg),
    write: (id: string, data: string) => ipcRenderer.invoke('serial:write', id, data),
    close: (id: string) => ipcRenderer.invoke('serial:close', id)
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
    setWindowTheme: (theme: 'light' | 'paper' | 'dark') => ipcRenderer.invoke('window:set-theme', theme),
    openExternal: (url: string) => ipcRenderer.invoke('sys:open-external', url),
    openPath: (p: string) => ipcRenderer.invoke('sys:open-path', p) as Promise<boolean>,
    openDataFile: (name: string, dataUrl: string) =>
      ipcRenderer.invoke('sys:open-data-file', name, dataUrl) as Promise<boolean>,
    showInFolder: (p: string) => ipcRenderer.invoke('sys:show-in-folder', p),
    chooseFile: () => ipcRenderer.invoke('sys:choose-file'),
    chooseSessionFiles: () => ipcRenderer.invoke('sys:choose-session-files') as Promise<string[]>,
    chooseSessionFolder: () => ipcRenderer.invoke('sys:choose-session-folder') as Promise<{ root: string; files: string[] } | null>,
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
