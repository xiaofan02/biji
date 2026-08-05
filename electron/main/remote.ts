import net from 'net'
import { spawn, ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'

// SSH(经 ssh_agent.py paramiko 子进程) + Telnet(裸 socket + IAC 协商)—— 由 main.js 移植
// 终端数据统一通过 `term:data:${id}` / `term:close:${id}` / `term:error:${id}` 推送到渲染层

interface SshSession {
  process: ChildProcess
  type: 'python'
}
interface TelnetSession {
  socket: net.Socket
}

const sshSessions = new Map<string, SshSession>()
const telnetSessions = new Map<string, TelnetSession>()

// ssh_agent.py 定位:开发态在项目根,打包态在 resources 下(electron-builder extraResources)
function getSshAgentPath(): string {
  const candidates = [
    join(process.cwd(), 'ssh_agent.py'),
    join(__dirname, '../../ssh_agent.py'),
    join(process.resourcesPath || '', 'ssh_agent.py'),
    join(app.getAppPath(), 'ssh_agent.py')
  ]
  for (const p of candidates) {
    try {
      if (existsSync(p)) return p
    } catch {
      /* ignore */
    }
  }
  return candidates[0]
}

interface SshConfig {
  host: string
  port?: number
  username: string
  password?: string
  privateKeyPath?: string
  passphrase?: string
}

function connectSSH(event: IpcMainInvokeEvent, config: SshConfig): Promise<{ id: string }> {
  return new Promise((resolve, reject) => {
    const id = `ssh-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const pythonScript = getSshAgentPath()
    console.log(`[SSH] Starting Python paramiko agent for ${config.host}:${config.port || 22}`)

    const proc = spawn('python', [pythonScript], { stdio: ['pipe', 'pipe', 'pipe'], shell: false })
    let resolved = false
    let stdoutBuffer = ''

    const timeout = setTimeout(() => {
      if (!resolved) {
        console.log('[SSH] Connection timeout')
        resolved = true
        reject(new Error('SSH connection timeout'))
        proc.kill()
      }
    }, 30000)

    const finishResolve = (val: { id: string }) => {
      clearTimeout(timeout)
      resolve(val)
    }
    const finishReject = (err: Error) => {
      clearTimeout(timeout)
      reject(err)
    }

    proc.stdout.on('data', (data: Buffer) => {
      // stdout 的 chunk 边界与 Python 写出的 JSON 行没有关系。保留最后一段
      // 不完整内容，避免 connected/data/error 消息跨 chunk 时被丢弃。
      stdoutBuffer += data.toString('utf-8')
      const lines = stdoutBuffer.split('\n')
      stdoutBuffer = lines.pop() || ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line)
          if (msg.type === 'connected') {
            if (!resolved) {
              resolved = true
              finishResolve({ id })
            }
          } else if (msg.type === 'data') {
            event.sender.send(`term:data:${id}`, msg.data)
          } else if (msg.type === 'closed') {
            event.sender.send(`term:close:${id}`)
            sshSessions.delete(id)
          } else if (msg.type === 'error') {
            event.sender.send(`term:error:${id}`, msg.msg)
            if (!resolved) {
              resolved = true
              finishReject(new Error(msg.msg))
            }
          }
        } catch {
          if (line.trim()) console.log('[SSH] Output:', line.slice(0, 100))
        }
      }
    })

    proc.stderr.on('data', (data: Buffer) => {
      console.log('[SSH] stderr:', data.toString('utf-8').slice(0, 100))
    })

    proc.on('error', (err) => {
      if (!resolved) {
        resolved = true
        finishReject(err)
      }
    })

    proc.on('exit', (code) => {
      console.log(`[SSH] Agent exited with code ${code}`)
      event.sender.send(`term:close:${id}`)
      sshSessions.delete(id)
    })

    sshSessions.set(id, { process: proc, type: 'python' })

    const connectCmd = {
      type: 'connect',
      host: config.host,
      port: config.port || 22,
      username: config.username,
      password: config.password || undefined,
      privateKeyPath: config.privateKeyPath || undefined,
      passphrase: config.passphrase || undefined
    }
    proc.stdin.write(JSON.stringify(connectCmd) + '\n')
  })
}

// Telnet IAC 协商:对所有 DO/DONT 回 WONT,对所有 WILL/WONT 回 DONT,剥离子协商,只透传纯数据
const IAC = 255,
  DONT = 254,
  DO = 253,
  WONT = 252,
  WILL = 251,
  SB = 250,
  SE = 240
function handleTelnetNegotiation(socket: net.Socket, data: Buffer): Buffer {
  const out: number[] = []
  let i = 0
  while (i < data.length) {
    if (data[i] === IAC) {
      if (i + 1 >= data.length) break
      const cmd = data[i + 1]
      if (cmd === DO || cmd === DONT) {
        if (i + 2 >= data.length) break
        socket.write(Buffer.from([IAC, WONT, data[i + 2]]))
        i += 3
      } else if (cmd === WILL || cmd === WONT) {
        if (i + 2 >= data.length) break
        socket.write(Buffer.from([IAC, DONT, data[i + 2]]))
        i += 3
      } else if (cmd === SB) {
        let j = i + 2
        while (j < data.length - 1 && !(data[j] === IAC && data[j + 1] === SE)) j++
        i = j + 2
      } else {
        i += 2
      }
    } else {
      out.push(data[i])
      i++
    }
  }
  return Buffer.from(out)
}

function connectTelnet(event: IpcMainInvokeEvent, config: { host: string; port?: number }): Promise<{ id: string }> {
  return new Promise((resolve, reject) => {
    const id = `telnet-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const socket = new net.Socket()
    socket.setTimeout(15000)

    socket.connect(config.port || 23, config.host, () => {
      socket.setTimeout(0)
      telnetSessions.set(id, { socket })
      resolve({ id })
    })
    socket.on('data', (data: Buffer) => {
      const processed = handleTelnetNegotiation(socket, data)
      if (processed.length) event.sender.send(`term:data:${id}`, processed.toString('utf-8'))
    })
    socket.on('error', (err) => {
      event.sender.send(`term:error:${id}`, err.message)
      reject(err)
    })
    socket.on('close', () => {
      event.sender.send(`term:close:${id}`)
      telnetSessions.delete(id)
    })
    socket.on('timeout', () => {
      event.sender.send(`term:error:${id}`, '连接超时')
      socket.destroy()
    })
  })
}

export function registerRemoteHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('ssh:connect', (event, config: SshConfig) => connectSSH(event, config))
  ipcMain.handle('ssh:write', (_e, id: string, data: string) => {
    const s = sshSessions.get(id)
    if (!s) return false
    s.process.stdin?.write(JSON.stringify({ type: 'write', data }) + '\n')
    return true
  })
  ipcMain.handle('ssh:resize', (_e, id: string, cols: number, rows: number) => {
    const s = sshSessions.get(id)
    if (!s) return false
    s.process.stdin?.write(JSON.stringify({ type: 'resize', cols, rows }) + '\n')
    return true
  })
  ipcMain.handle('ssh:close', (_e, id: string) => {
    const s = sshSessions.get(id)
    if (!s) return false
    s.process.stdin?.write(JSON.stringify({ type: 'close' }) + '\n')
    s.process.kill()
    sshSessions.delete(id)
    return true
  })

  ipcMain.handle('telnet:connect', (event, config: { host: string; port?: number }) => connectTelnet(event, config))
  ipcMain.handle('telnet:write', (_e, id: string, data: string) => {
    const s = telnetSessions.get(id)
    if (s) s.socket.write(data)
    return true
  })
  ipcMain.handle('telnet:close', (_e, id: string) => {
    const s = telnetSessions.get(id)
    if (s) {
      s.socket.destroy()
      telnetSessions.delete(id)
    }
    return true
  })
}

export function closeAllSessions(): void {
  sshSessions.forEach((s) => {
    try {
      s.process.kill()
    } catch {
      /* ignore */
    }
  })
  sshSessions.clear()
  telnetSessions.forEach((s) => {
    try {
      s.socket.destroy()
    } catch {
      /* ignore */
    }
  })
  telnetSessions.clear()
}
