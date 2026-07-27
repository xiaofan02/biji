import { useEffect, useState } from 'react'
import { useWorkflows } from '@/store/useWorkflows'
import { useTabs } from '@/store/useTabs'
import { runWorkflow, resultsToMarkdown, loadWorkflowHosts, type StepResult } from '@/lib/runWorkflow'
import { toast } from '@/store/useToast'
import { Icon } from '@/components/common/Icon'
import type { Workflow } from '@/types'
import './workflow.css'

type Prog = { status: 'running' | 'done' | 'error'; result?: StepResult }

export function WorkflowPanel() {
  const list = useWorkflows((s) => s.list)
  const loaded = useWorkflows((s) => s.loaded)
  const upsert = useWorkflows((s) => s.upsert)
  const remove = useWorkflows((s) => s.remove)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hosts, setHosts] = useState<{ id: string; name: string; kind: string }[]>([])
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<Record<string, Prog>>({})
  const [results, setResults] = useState<StepResult[] | null>(null)

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
    try {
      const res = await runWorkflow(current, (stepId, status, result) =>
        setProgress((p) => ({ ...p, [stepId]: { status, result } }))
      )
      setResults(res)
      toast('工作流运行完成', 'success')
    } catch (e) {
      toast('运行失败:' + (e as Error).message, 'error')
    } finally {
      setRunning(false)
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

  const statusText = (s: Prog['status']) => (s === 'running' ? '运行中…' : s === 'done' ? '✓ 完成' : '✗ 出错')

  return (
    <div className="wf-panel">
      <div className="wf-list">
        <div className="wf-list-head">
          <span>工作流</span>
          <button className="icon-btn small" title="新建工作流" onClick={newWorkflow}>
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
                onClick={() => setSelectedId(w.id)}
              >
                <Icon name="workflow" size={14} />
                <span className="wf-list-name">{w.name}</span>
                <button
                  className="wf-list-del"
                  title="删除"
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
        </div>
      </div>

      <div className="wf-editor">
        {!current ? (
          <div className="wf-empty">新建或选择一个工作流开始编排</div>
        ) : (
          <>
            <div className="wf-editor-head">
              <input className="wf-name" value={current.name} onChange={(e) => patch(current, { name: e.target.value })} />
              <button className="btn primary" onClick={run} disabled={running}>
                <Icon name="play" size={14} /> {running ? '运行中…' : '运行'}
              </button>
              {results && (
                <button className="btn" onClick={saveReport} title="把运行报告插入当前笔记">
                  <Icon name="file-plus" size={14} /> 存为报告
                </button>
              )}
            </div>
            {hosts.length === 0 && (
              <div className="wf-tip">尚未配置主机。请先在「设置 → SSH/Telnet 主机」添加,步骤才能选择目标设备。</div>
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
                        onChange={(e) => updateStep(s.id, { title: e.target.value })}
                      />
                      <select value={s.hostId} onChange={(e) => updateStep(s.id, { hostId: e.target.value })}>
                        <option value="">选择主机…</option>
                        {hosts.map((h) => (
                          <option key={h.id} value={h.id}>
                            {h.name}（{h.kind}）
                          </option>
                        ))}
                      </select>
                      {prog && <span className={`wf-step-status ${prog.status}`}>{statusText(prog.status)}</span>}
                      <button className="wf-step-del" title="删除步骤" onClick={() => removeStep(s.id)}>
                        <Icon name="x" size={14} />
                      </button>
                    </div>
                    <textarea
                      className="wf-step-cmds"
                      value={s.commands}
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
              <button className="btn wf-add-step" onClick={addStep}>
                <Icon name="plus" size={14} /> 添加步骤
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
