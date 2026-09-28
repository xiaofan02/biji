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

export interface WorkflowLogEntry {
  at: number
  stepId: string
  message: string
}

export interface WorkflowRunOptions {
  signal?: AbortSignal
  onLog?: (entry: WorkflowLogEntry) => void
}

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('运行已取消', 'AbortError')
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
function collectUntilIdle(id: string, idleMs: number, maxMs: number, signal?: AbortSignal): Promise<string> {
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
      signal?.removeEventListener('abort', finish)
      resolve(buf)
    }
    const off = ipc.term.onData(id, (data: string) => {
      buf += data
      clearTimeout(idleTimer)
      idleTimer = setTimeout(finish, idleMs)
    })
    idleTimer = setTimeout(finish, idleMs)
    const maxTimer = setTimeout(finish, maxMs)
    signal?.addEventListener('abort', finish, { once: true })
    if (signal?.aborted) finish()
  })
}

async function runStep(step: WorkflowStep, leaf: HostLeaf, options: WorkflowRunOptions): Promise<StepResult> {
  checkCancelled(options.signal)
  const cfg = cfgOf(leaf)
  const conn = (leaf.kind === 'ssh' ? await ipc.ssh.connect(cfg) : await ipc.telnet.connect(cfg)) as { id: string }
  const id = conn.id
  const write = (data: string) => (leaf.kind === 'ssh' ? ipc.ssh.write(id, data) : ipc.telnet.write(id, data))
  let output = ''
  try {
    checkCancelled(options.signal)
    // 等初始 banner/登录提示符静默下来
    await collectUntilIdle(id, 1500, 8000, options.signal)
    checkCancelled(options.signal)
    const cmds = step.commands
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
    for (const cmd of cmds) {
      checkCancelled(options.signal)
      options.onLog?.({ at: Date.now(), stepId: step.id, message: `发送命令：${cmd}` })
      await write(cmd + '\n')
      checkCancelled(options.signal)
      const out = await collectUntilIdle(id, 1500, 30000, options.signal)
      output += `$ ${cmd}\n${stripAnsi(out).trim()}\n\n`
      checkCancelled(options.signal)
    }
  } finally {
    if (leaf.kind === 'ssh') void ipc.ssh.close(id)
    else void ipc.telnet.close(id)
  }
  return { stepId: step.id, title: step.title, host: leaf.name, output: output.trim() }
}

export async function runWorkflow(
  wf: Workflow,
  onProgress: (stepId: string, status: 'running' | 'done' | 'error' | 'cancelled', result?: StepResult) => void,
  options: WorkflowRunOptions = {}
): Promise<StepResult[]> {
  checkCancelled(options.signal)
  const hosts = await loadWorkflowHosts()
  const results: StepResult[] = []
  for (const step of wf.steps) {
    if (options.signal?.aborted) break
    onProgress(step.id, 'running')
    options.onLog?.({ at: Date.now(), stepId: step.id, message: `开始步骤：${step.title}` })
    const leaf = hosts.find((h) => h.id === step.hostId)
    if (!leaf) {
      const r: StepResult = { stepId: step.id, title: step.title, host: step.hostId, output: '', error: '主机不存在(可能已删除)' }
      results.push(r)
      onProgress(step.id, 'error', r)
      options.onLog?.({ at: Date.now(), stepId: step.id, message: r.error! })
      continue
    }
    try {
      const r = await runStep(step, leaf, options)
      results.push(r)
      onProgress(step.id, 'done', r)
      options.onLog?.({ at: Date.now(), stepId: step.id, message: `步骤完成：${step.title}` })
    } catch (e) {
      const cancelled = options.signal?.aborted
      const r: StepResult = { stepId: step.id, title: step.title, host: leaf.name, output: '', error: cancelled ? '用户取消' : (e as Error).message }
      results.push(r)
      onProgress(step.id, cancelled ? 'cancelled' : 'error', r)
      options.onLog?.({ at: Date.now(), stepId: step.id, message: cancelled ? '运行已取消' : `步骤失败：${r.error}` })
      if (cancelled) break
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
