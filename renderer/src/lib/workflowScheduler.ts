import { ipc } from '@/lib/ipc'
import { runWorkflow } from '@/lib/runWorkflow'
import { createDoc, emptyDoc, saveDoc } from '@/lib/note'
import { pushDoc } from '@/lib/sync'
import { joinPath } from '@/lib/util'
import { useSettings } from '@/store/useSettings'
import { useWorkflows } from '@/store/useWorkflows'
import type { Workflow } from '@/types'

const running = new Set<string>()
const inline = (value: string) => [{ type: 'text', text: value, styles: {} }]

function due(workflow: Workflow, now: Date): boolean {
  const schedule = workflow.schedule
  if (!schedule?.enabled || schedule.mode === 'manual') return false
  const last = schedule.lastRunAt || 0
  if (schedule.mode === 'interval') return Date.now() - last >= (schedule.intervalHours || 3) * 60 * 60 * 1000
  const [hour, minute] = (schedule.time || '22:00').split(':').map(Number)
  const planned = new Date(now); planned.setHours(hour || 0, minute || 0, 0, 0)
  return now >= planned && last < planned.getTime()
}

async function saveAutomaticReport(workflow: Workflow, results: Awaited<ReturnType<typeof runWorkflow>>): Promise<void> {
  const workspace = useSettings.getState().workspace
  const folder = joinPath(workspace, '自动化报告')
  await ipc.fs.create(workspace, '自动化报告', true).catch(() => undefined)
  const stamp = new Date().toLocaleString('zh-CN', { hour12: false }).replace(/[/:]/g, '-').replace(/\s/g, ' ')
  const path = await createDoc(folder, `${workflow.name} ${stamp}`)
  const blocks: any[] = [
    { type: 'heading', props: { level: 1 }, content: inline('运行摘要'), children: [] },
    { type: 'paragraph', props: {}, content: inline(`工作流：${workflow.name}　执行时间：${new Date().toLocaleString('zh-CN')}`), children: [] }
  ]
  for (const result of results) {
    blocks.push({ type: 'heading', props: { level: 2 }, content: inline(`${result.title}（${result.host}）`), children: [] })
    if (result.error) blocks.push({ type: 'paragraph', props: {}, content: inline(`执行失败：${result.error}`), children: [] })
    else blocks.push({ type: 'codeBlock', props: { language: 'text' }, content: inline(result.output || '(无输出)'), children: [] })
  }
  const doc = { ...emptyDoc(workflow.name + ' 运行报告'), blocks }
  await saveDoc(path, doc)
  pushDoc(path, doc)
}

export async function runDueWorkflows(): Promise<void> {
  const store = useWorkflows.getState()
  if (!store.loaded) await store.load()
  const now = new Date()
  for (const workflow of useWorkflows.getState().list) {
    if (!due(workflow, now) || running.has(workflow.id)) continue
    running.add(workflow.id)
    const startedAt = Date.now()
    try {
      const results = await runWorkflow(workflow, () => undefined)
      const failed = results.filter((item) => item.error).length
      useWorkflows.getState().addRun({
        id: crypto.randomUUID(), workflowId: workflow.id, workflowName: workflow.name,
        startedAt, finishedAt: Date.now(), status: failed === 0 ? 'success' : failed === results.length ? 'failed' : 'partial', results
      })
      useWorkflows.getState().upsert({ ...workflow, schedule: { ...workflow.schedule!, lastRunAt: Date.now() }, updatedAt: Date.now() })
      await saveAutomaticReport(workflow, results)
    } catch (error) {
      useWorkflows.getState().addRun({
        id: crypto.randomUUID(), workflowId: workflow.id, workflowName: workflow.name,
        startedAt, finishedAt: Date.now(), status: 'failed', results: [{ stepId: 'scheduler', title: '调度执行', host: '', output: '', error: (error as Error).message }]
      })
    } finally { running.delete(workflow.id) }
  }
}
