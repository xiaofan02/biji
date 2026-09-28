import { useEffect, useRef, useState } from 'react'
import { useWorkflows } from '@/store/useWorkflows'
import { useTabs } from '@/store/useTabs'
import { runWorkflow, resultsToMarkdown, loadWorkflowHosts, type StepResult, type WorkflowLogEntry } from '@/lib/runWorkflow'
import { toast } from '@/store/useToast'
import { Icon } from '@/components/common/Icon'
import type { Workflow } from '@/types'
import './workflow.css'

type Prog = { status: 'running' | 'done' | 'error' | 'cancelled'; result?: StepResult }

export function WorkflowPanel() {
  const list = useWorkflows((s) => s.list)
  const loaded = useWorkflows((s) => s.loaded)
  const upsert = useWorkflows((s) => s.upsert)
  const remove = useWorkflows((s) => s.remove)
  const runs = useWorkflows((s) => s.runs)
  const addRun = useWorkflows((s) => s.addRun)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hosts, setHosts] = useState<{ id: string; name: string; kind: string }[]>([])
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<Record<string, Prog>>({})
  const [results, setResults] = useState<StepResult[] | null>(null)
  const [logs, setLogs] = useState<WorkflowLogEntry[]>([])
  const [runStatus, setRunStatus] = useState<'running' | 'success' | 'partial' | 'failed' | 'cancelled' | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const logsRef = useRef<WorkflowLogEntry[]>([])

  useEffect(() => () => abortRef.current?.abort(), [])

  useEffect(() => {
    if (!loaded) void useWorkflows.getState().load()
  }, [loaded])
  useEffect(() => {
    void loadWorkflowHosts().then((hs) => setHosts(hs.map((h) => ({ id: h.id, name: h.name || h.id, kind: h.kind }))))
  }, [])
  useEffect(() => {
    if (!selectedId && list.length) setSelectedId(list[0].id)
  }, [list, selectedId])

  const current = list.find((w) => w.id === selectedId) || null

  const newWorkflow = () => {
    const wf: Workflow = { id: crypto.randomUUID(), name: '新工作流', steps: [], createdAt: Date.now(), updatedAt: Date.now() }
    upsert(wf)
    setSelectedId(wf.id)
  }
  const newFromTemplate = (kind: string) => {
    if (!kind) return
    const first = hosts.find((host) => kind === 'linux-health' ? host.kind === 'ssh' : true)
    const definitions: Record<string, { name: string; title: string; commands: string }> = {
      'network-backup': { name: '网络设备配置备份', title: '采集运行配置', commands: 'terminal length 0\nshow running-config' },
      'network-health': { name: '网络设备健康检查', title: '采集设备状态', commands: 'show version\nshow interfaces status\nshow ip route' },
      'linux-health': { name: 'Linux 主机健康检查', title: '采集系统状态', commands: 'uptime\ndf -h\nfree -m\nip addr' }
    }
    const definition = definitions[kind]
    if (!definition) return
    const now = Date.now()
    const wf: Workflow = {
      id: crypto.randomUUID(), name: definition.name, createdAt: now, updatedAt: now,
      steps: [{ id: crypto.randomUUID(), title: definition.title, hostId: first?.id || '', commands: definition.commands }],
      schedule: { enabled: false, mode: 'manual' }
    }
    upsert(wf)
    setSelectedId(wf.id)
  }
  const patch = (wf: Workflow, changes: Partial<Workflow>) => upsert({ ...wf, ...changes, updatedAt: Date.now() })
  const addStep = () => {
    if (!current) return
    patch(current, {
      steps: [
        ...current.steps,
        { id: crypto.randomUUID(), title: `步骤 ${current.steps.length + 1}`, hostId: hosts[0]?.id || '', commands: '' }
      ]
    })
  }
  const updateStep = (sid: string, changes: Partial<Workflow['steps'][number]>) => {
    if (!current) return
    patch(current, { steps: current.steps.map((s) => (s.id === sid ? { ...s, ...changes } : s)) })
  }
  const removeStep = (sid: string) => {
    if (!current) return
    patch(current, { steps: current.steps.filter((s) => s.id !== sid) })
  }

  const run = async () => {
    if (!current || running) return
    if (current.steps.length === 0) {
      toast('请先添加步骤', 'error')
      return
    }
    setRunning(true)
    setProgress({})
    setResults(null)
    setLogs([])
    logsRef.current = []
    setRunStatus('running')
    const controller = new AbortController()
    abortRef.current = controller
    const startedAt = Date.now()
    try {
      const res = await runWorkflow(
        current,
        (stepId, status, result) => setProgress((p) => ({ ...p, [stepId]: { status, result } })),
        { signal: controller.signal, onLog: (entry) => {
          logsRef.current.push(entry)
          setLogs([...logsRef.current])
        } }
      )
      setResults(res)
      const failed = res.filter((item) => item.error).length
      const status = controller.signal.aborted ? 'cancelled' : failed === 0 ? 'success' : failed === res.length ? 'failed' : 'partial'
      setRunStatus(status)
      addRun({
        id: crypto.randomUUID(), workflowId: current.id, workflowName: current.name,
        startedAt, finishedAt: Date.now(), status, results: res,
        logs: [...logsRef.current]
      })
      toast(status === 'cancelled' ? '工作流已取消' : '工作流运行完成', status === 'cancelled' ? 'info' : 'success')
    } catch (e) {
      const cancelled = controller.signal.aborted
      const status = cancelled ? 'cancelled' : 'failed'
      const message = cancelled ? '运行已取消' : `运行失败：${(e as Error).message}`
      const entry = { at: Date.now(), stepId: '', message }
      logsRef.current.push(entry)
      setLogs([...logsRef.current])
      setResults([])
      setRunStatus(status)
      addRun({
        id: crypto.randomUUID(), workflowId: current.id, workflowName: current.name,
        startedAt, finishedAt: Date.now(), status, results: [], logs: [...logsRef.current]
      })
      toast(message, cancelled ? 'info' : 'error')
    } finally {
      setRunning(false)
      abortRef.current = null
    }
  }

  const saveReport = () => {
    if (!current || !results) return
    const tabs = useTabs.getState()
    const active = tabs.tabs.find((t) => t.path === tabs.activePath)
    if (!active || active.kind !== 'bnote') {
      toast('请先打开一篇笔记,报告会插入到该笔记末尾', 'error')
      return
    }
    window.dispatchEvent(
      new CustomEvent('biji:save-to-note', { detail: { markdown: resultsToMarkdown(current, results) } })
    )
  }

  const statusText = (s: Prog['status']) => (s === 'running' ? '运行中…' : s === 'done' ? '✓ 完成' : s === 'cancelled' ? '已取消' : '✗ 出错')

  return (
    <div className="wf-panel">
      <div className="wf-list">
        <div className="wf-list-head">
          <span>工作流</span>
          <button className="icon-btn small" title="新建工作流" onClick={newWorkflow} disabled={running}>
            <Icon name="plus" size={15} />
          </button>
        </div>
        <div className="wf-list-body">
          {list.length === 0 ? (
            <div className="wf-empty-hint">点上方 + 新建工作流</div>
          ) : (
            list.map((w) => (
              <div
                key={w.id}
                className={`wf-list-item${selectedId === w.id ? ' active' : ''}`}
                onClick={() => { if (!running) setSelectedId(w.id) }}
              >
                <Icon name="workflow" size={14} />
                <span className="wf-list-name">{w.name}</span>
                <button
                  className="wf-list-del"
                  title="删除"
                  disabled={running}
                  onClick={(e) => {
                    e.stopPropagation()
                    remove(w.id)
                    if (selectedId === w.id) setSelectedId(null)
                  }}
                >
                  <Icon name="trash" size={13} />
                </button>
              </div>
            ))
          )}
          {runs.length > 0 && <div className="wf-history-title">最近运行</div>}
          {runs.slice(0, 8).map((record) => (
            <button className="wf-history-item" key={record.id} disabled={running} onClick={() => {
              setSelectedId(record.workflowId)
              setResults(record.results)
              setLogs(record.logs || [])
              setRunStatus(record.status)
              setProgress(Object.fromEntries(record.results.map((r) => [r.stepId, { status: r.error ? record.status === 'cancelled' ? 'cancelled' : 'error' : 'done', result: r }])))
            }}>
              <span className={`wf-history-dot ${record.status}`} />
              <span>{record.workflowName}</span>
              <small>{new Date(record.finishedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</small>
            </button>
          ))}
        </div>
      </div>

      <div className="wf-editor">
        {!current ? (
          <div className="wf-empty">新建或选择一个工作流开始编排</div>
        ) : (
          <>
            <div className="wf-editor-head">
              <input className="wf-name" value={current.name} disabled={running} onChange={(e) => patch(current, { name: e.target.value })} />
              <select className="wf-template-select" defaultValue="" disabled={running} onChange={(event) => { newFromTemplate(event.target.value); event.target.value = '' }}>
                <option value="">任务模板…</option>
                <option value="network-backup">网络设备配置备份</option>
                <option value="network-health">网络设备健康检查</option>
                <option value="linux-health">Linux 健康检查</option>
              </select>
              <button className="btn primary" onClick={run} disabled={running}>
                <Icon name="play" size={14} /> {running ? '运行中…' : '运行'}
              </button>
              {running && <button className="btn wf-cancel" onClick={() => abortRef.current?.abort()}>取消运行</button>}
              {results && (
                <button className="btn" onClick={saveReport} title="把运行报告插入当前笔记">
                  <Icon name="file-plus" size={14} /> 存为报告
                </button>
              )}
            </div>
            {hosts.length === 0 && (
              <div className="wf-tip">尚未配置主机。请先在“远程终端”中新建 SSH 或 Telnet 会话，工作流即可选择目标设备。</div>
            )}
            <div className="wf-schedule">
              <label><input type="checkbox" disabled={running} checked={!!current.schedule?.enabled} onChange={(event) => patch(current, { schedule: { ...(current.schedule || { mode: 'manual' }), enabled: event.target.checked } })} /> 定时运行</label>
              <select value={current.schedule?.mode || 'manual'} disabled={running} onChange={(event) => patch(current, { schedule: { ...(current.schedule || { enabled: false }), mode: event.target.value as 'manual' | 'daily' | 'interval' } })}>
                <option value="manual">仅手动</option><option value="daily">每天</option><option value="interval">按间隔</option>
              </select>
              {current.schedule?.mode === 'daily' && <input type="time" disabled={running} value={current.schedule.time || '22:00'} onChange={(event) => patch(current, { schedule: { ...current.schedule!, time: event.target.value } })} />}
              {current.schedule?.mode === 'interval' && <select value={current.schedule.intervalHours || 3} disabled={running} onChange={(event) => patch(current, { schedule: { ...current.schedule!, intervalHours: Number(event.target.value) } })}><option value="1">每 1 小时</option><option value="3">每 3 小时</option><option value="6">每 6 小时</option><option value="12">每 12 小时</option><option value="24">每 24 小时</option></select>}
              <span>应用运行期间自动执行，结果保存在运行记录中</span>
            </div>
            {runStatus && (
              <section className="wf-run-log" aria-label="运行日志">
                <div className="wf-run-log-head">运行状态：{runStatus === 'running' ? '运行中' : runStatus === 'success' ? '成功' : runStatus === 'partial' ? '部分失败' : runStatus === 'cancelled' ? '已取消' : '失败'} · 日志</div>
                <div className="wf-run-log-body" role="log" aria-live="polite">
                  {logs.length ? logs.map((entry, index) => <div key={`${entry.at}-${index}`}><time>{new Date(entry.at).toLocaleTimeString('zh-CN')}</time> {entry.message}</div>) : <span>暂无日志</span>}
                </div>
              </section>
            )}
            <div className="wf-steps">
              {current.steps.map((s) => {
                const prog = progress[s.id]
                return (
                  <div className="wf-step" key={s.id}>
                    <div className="wf-step-head">
                      <input
                        className="wf-step-title"
                        value={s.title}
                        disabled={running}
                        onChange={(e) => updateStep(s.id, { title: e.target.value })}
                      />
                      <select value={s.hostId} disabled={running} onChange={(e) => updateStep(s.id, { hostId: e.target.value })}>
                        <option value="">选择主机…</option>
                        {hosts.map((h) => (
                          <option key={h.id} value={h.id}>
                            {h.name}（{h.kind}）
                          </option>
                        ))}
                      </select>
                      {prog && <span className={`wf-step-status ${prog.status}`}>{statusText(prog.status)}</span>}
                      <button className="wf-step-del" title="删除步骤" disabled={running} onClick={() => removeStep(s.id)}>
                        <Icon name="x" size={14} />
                      </button>
                    </div>
                    <textarea
                      className="wf-step-cmds"
                      value={s.commands}
                      disabled={running}
                      onChange={(e) => updateStep(s.id, { commands: e.target.value })}
                      placeholder="每行一条命令,例如:&#10;show interfaces status&#10;show ip route"
                      spellCheck={false}
                    />
                    {prog?.result &&
                      (prog.result.error ? (
                        <div className="wf-step-err">⚠️ {prog.result.error}</div>
                      ) : (
                        prog.result.output && <pre className="wf-step-out">{prog.result.output}</pre>
                      ))}
                  </div>
                )
              })}
              <button className="btn wf-add-step" onClick={addStep} disabled={running}>
                <Icon name="plus" size={14} /> 添加步骤
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
