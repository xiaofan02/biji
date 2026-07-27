import type { SSHHost } from '@/types'

// 兼容旧版(src/renderer)存储的 SSH 主机字段名:authMethod→auth, keyPath→privateKeyPath。
// 旧主机缺少 auth/privateKeyPath 字段会导致连接时密码/私钥取不到 → paramiko 报
// "No authentication methods available"。统一规范化为新 schema。
export function normalizeSSHHost(raw: any): SSHHost {
  const auth = (raw?.auth ?? raw?.authMethod ?? 'password') === 'key' ? 'key' : 'password'
  return {
    id: raw?.id ?? (crypto.randomUUID ? crypto.randomUUID() : 's_' + Date.now()),
    name: raw?.name ?? '',
    host: raw?.host ?? '',
    port: raw?.port ?? 22,
    username: raw?.username ?? '',
    auth,
    password: raw?.password ?? '',
    privateKeyPath: raw?.privateKeyPath ?? raw?.keyPath ?? '',
    passphrase: raw?.passphrase ?? '',
    group: raw?.group ?? ''
  }
}

// 列表中是否存在旧版字段(需要迁移落盘)
export function sshHostsNeedMigration(list: any[]): boolean {
  return list.some((h) => h && (h.authMethod !== undefined || h.keyPath !== undefined || h.auth === undefined))
}
