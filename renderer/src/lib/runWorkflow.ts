import { ipc } from '@/lib/ipc'
import { normalizeSSHHost } from '@/lib/hosts'
import type { Workflow, WorkflowStep, SSHHost, TelnetHost } from '@/types'

// 工作流执行引擎(渲染层驱动,复用现有 SSH/Telnet 连接)。v1 只有「命令步骤」:
// 连主机 → 逐条发命令 → 用「静默超时」(N 秒无新输出视为该命令执行完)收集输出 → 关连接。
// 网络设备没有统一的命令结束标志,静默超时是最稳的通用判定;后续可加按提示符正则精确判定。

interface HostLeaf {
  id: string
  kind: 'ssh' | 'telnet'
  host: SSHHost | TelnetHost
  name: string
}

export interface StepResult {
  stepId: string
  title: string
  host: string
  output: string
  error?: string
}

function stripAnsi(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[0-~]/g, '')
    .replace(/\r/g, '')
}

export async function loadWorkflowHosts(): Promise<HostLeaf[]> {
  const [ssh, telnet] = await Promise.all([
    ipc.settings.get('sshHosts') as Promise<any[]>,
    ipc.settings.get('telnetHosts') as Promise<TelnetHost[]>
  ])
  return [
    ...((ssh as any[]) || []).map((raw) => {
      const h = normalizeSSHHost(raw)
      return { id: `ssh:${h.id}`, kind: 'ssh' as const, host: h, name: h.name }
    }),
    ...((telnet as TelnetHost[]) || []).map((h) => ({
      id: `telnet:${h.id}`,
      kind: 'telnet' as const,
      host: h,
      name: h.name
    }))
  ]
}

function cfgOf(leaf: HostLeaf): any {
  if (leaf.kind === 'ssh') {
    const h = leaf.host as SSHHost
    return {
      host: h.host,
      port: h.port,
      username: h.username,
      password: h.auth === 'password' ? h.password : undefined,
      privateKeyPath: h.auth === 'key' ? h.privateKeyPath : undefined,
      passphrase: h.auth === 'key' ? h.passphrase : undefined
    }
  }
  const h = leaf.host as TelnetHost
  return { host: h.host, port: h.port }
}

// 收集终端输出直到「静默 idleMs」或达到 maxMs 上限
function collectUntilIdle(id: string, idleMs: number, maxMs: number): Promise<string> {
  return new Promise((resolve) => {
    let buf = ''
    let done = false
    let idleTimer: ReturnType<typeof setTimeout>
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(idleTimer)
      clearTimeout(maxTimer)
      off()
      resolve(buf)
    }
    const off = ipc.term.onData(id, (data: string) => {
      buf += data
      clearTimeout(idleTimer)
      idleTimer = setTimeout(finish, idleMs)
    })
    idleTimer = setTimeout(finish, idleMs)
    const maxTimer = setTimeout(finish, maxMs)
  })
}

async function runStep(step: WorkflowStep, leaf: HostLeaf): Promise<StepResult> {
  const cfg = cfgOf(leaf)
  const conn = (leaf.kind === 'ssh' ? await ipc.ssh.connect(cfg) : await ipc.telnet.connect(cfg)) as { id: string }
  const id = conn.id
  const write = (data: string) => (leaf.kind === 'ssh' ? ipc.ssh.write(id, data) : ipc.telnet.write(id, data))
  let output = ''
  try {
    // 等初始 banner/登录提示符静默下来
    await collectUntilIdle(id, 1500, 8000)
    const cmds = step.commands
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
    for (const cmd of cmds) {
      write(cmd + '\n')
      const out = await collectUntilIdle(id, 1500, 30000)
      output += `$ ${cmd}\n${stripAnsi(out).trim()}\n\n`
    }
  } finally {
    if (leaf.kind === 'ssh') ipc.ssh.close(id)
    else ipc.telnet.close(id)
  }
  return { stepId: step.id, title: step.title, host: leaf.name, output: output.trim() }
}

export async function runWorkflow(
  wf: Workflow,
  onProgress: (stepId: string, status: 'running' | 'done' | 'error', result?: StepResult) => void
): Promise<StepResult[]> {
  const hosts = await loadWorkflowHosts()
  const results: StepResult[] = []
  for (const step of wf.steps) {
    onProgress(step.id, 'running')
    const leaf = hosts.find((h) => h.id === step.hostId)
    if (!leaf) {
      const r: StepResult = { stepId: step.id, title: step.title, host: step.hostId, output: '', error: '主机不存在(可能已删除)' }
      results.push(r)
      onProgress(step.id, 'error', r)
      continue
    }
    try {
      const r = await runStep(step, leaf)
      results.push(r)
      onProgress(step.id, 'done', r)
    } catch (e) {
      const r: StepResult = { stepId: step.id, title: step.title, host: leaf.name, output: '', error: (e as Error).message }
      results.push(r)
      onProgress(step.id, 'error', r)
    }
  }
  return results
}

// 把运行结果汇总成 markdown(供「存为笔记」)
export function resultsToMarkdown(wf: Workflow, results: StepResult[]): string {
  const lines = [`# 工作流运行报告:${wf.name}`, '']
  for (const r of results) {
    lines.push(`## ${r.title}　(${r.host})`)
    if (r.error) lines.push('', `> ⚠️ 执行出错:${r.error}`, '')
    else lines.push('', '```', r.output || '(无输出)', '```', '')
  }
  return lines.join('\n')
}
