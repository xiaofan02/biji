import type { SSHHost, TelnetHost } from '@/types'

export interface ImportedSessions {
  ssh: SSHHost[]
  telnet: TelnetHost[]
}

const blank = (): ImportedSessions => ({ ssh: [], telnet: [] })
const id = () => crypto.randomUUID()
const fileStem = (path: string) => path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') || '导入会话'

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const cleaned = value.replace(/^0x/i, '').trim()
  const parsed = /^[0-9a-f]{8}$/i.test(cleaned) ? parseInt(cleaned, 16) : parseInt(cleaned, 10)
  return Number.isFinite(parsed) && parsed > 0 && parsed < 65536 ? parsed : fallback
}

function parseMoqi(text: string): ImportedSessions | null {
  try {
    const data = JSON.parse(text)
    if (data?.format !== 'moqi-sessions' || !Array.isArray(data.sessions)) return null
    const result = blank()
    for (const item of data.sessions) {
      if (!item?.host) continue
      if (item.kind === 'telnet') {
        result.telnet.push({ id: id(), name: item.name || item.host, host: item.host, port: parsePort(String(item.port || ''), 23), group: item.group || '' })
      } else {
        result.ssh.push({
          id: id(), name: item.name || item.host, host: item.host, port: parsePort(String(item.port || ''), 22),
          username: item.username || '', auth: 'password', password: '', group: item.group || ''
        })
      }
    }
    return result
  } catch {
    return null
  }
}

function secureCrtValue(text: string, key: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.match(new RegExp(`^[SD]:"${escaped}"=(.*)$`, 'mi'))?.[1]?.trim().replace(/^"|"$/g, '') || ''
}

function parseSecureCrt(path: string, text: string): ImportedSessions | null {
  const host = secureCrtValue(text, 'Hostname')
  if (!host) return null
  const protocol = secureCrtValue(text, 'Protocol Name').toLowerCase()
  const isTelnet = protocol.includes('telnet')
  const group = 'SecureCRT'
  if (isTelnet) {
    return { ssh: [], telnet: [{ id: id(), name: fileStem(path), host, port: parsePort(secureCrtValue(text, '[Telnet] Port'), 23), group }] }
  }
  return {
    telnet: [],
    ssh: [{
      id: id(), name: fileStem(path), host, port: parsePort(secureCrtValue(text, '[SSH2] Port'), 22),
      username: secureCrtValue(text, 'Username'), auth: 'password', password: '', group
    }]
  }
}

function parseMoba(text: string): ImportedSessions | null {
  if (!/^\[Bookmarks/m.test(text) && !/#(?:109|98)#0%/.test(text)) return null
  const result = blank()
  let group = 'MobaXterm'
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.startsWith('SubRep=')) group = ['MobaXterm', line.slice(7).trim()].filter(Boolean).join('/')
    const eq = line.indexOf('=')
    if (eq < 1) continue
    const name = line.slice(0, eq).trim()
    const encoded = line.slice(eq + 1)
    const match = encoded.match(/^#(109|98)#0%([^%]+)%([^%]*)%([^%]*)/)
    if (!match) continue
    const [, kind, host, portText, username] = match
    if (kind === '98') {
      result.telnet.push({ id: id(), name, host, port: parsePort(portText, 23), group })
    } else {
      result.ssh.push({ id: id(), name, host, port: parsePort(portText, 22), username, auth: 'password', password: '', group })
    }
  }
  return result.ssh.length || result.telnet.length ? result : null
}

export function importSessionText(path: string, text: string): ImportedSessions {
  return parseMoqi(text) || parseSecureCrt(path, text) || parseMoba(text) || blank()
}

export function exportMoqiSessions(ssh: SSHHost[], telnet: TelnetHost[]): string {
  return JSON.stringify({
    format: 'moqi-sessions',
    version: 1,
    exportedAt: new Date().toISOString(),
    note: '出于安全考虑，导出文件不包含密码和私钥口令。',
    sessions: [
      ...ssh.map((host) => ({ kind: 'ssh', name: host.name, host: host.host, port: host.port, username: host.username, group: host.group || '' })),
      ...telnet.map((host) => ({ kind: 'telnet', name: host.name, host: host.host, port: host.port, group: host.group || '' }))
    ]
  }, null, 2)
}
