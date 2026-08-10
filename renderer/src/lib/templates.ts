import type { BijiDoc } from '@/types'
import { ipc } from '@/lib/ipc'
import { createDoc, emptyDoc, saveDoc } from '@/lib/note'

export interface NoteTemplate {
  id: string
  name: string
  description: string
  blocks: any[]
  builtIn?: boolean
}

const text = (value: string) => [{ type: 'text', text: value, styles: {} }]
const paragraph = (value = '') => ({ type: 'paragraph', props: {}, content: text(value), children: [] })
const heading = (level: 1 | 2 | 3, value: string) => ({ type: 'heading', props: { level }, content: text(value), children: [] })
const bullet = (value: string) => ({ type: 'bulletListItem', props: {}, content: text(value), children: [] })

export const builtInTemplates: NoteTemplate[] = [
  {
    id: 'blank', name: '空白笔记', description: '从一张干净页面开始', builtIn: true, blocks: []
  },
  {
    id: 'meeting', name: '会议记录', description: '议题、结论、待办和后续跟进', builtIn: true,
    blocks: [heading(1, '会议信息'), paragraph('时间：'), paragraph('参与人：'), heading(1, '议题'), bullet(''), heading(1, '结论'), paragraph(''), heading(1, '待办事项'), bullet('负责人 / 截止时间：')]
  },
  {
    id: 'device-change', name: '设备变更', description: '适合网络设备与服务器变更记录', builtIn: true,
    blocks: [heading(1, '变更概述'), paragraph('设备 / 地址：'), paragraph('变更窗口：'), heading(1, '变更前检查'), bullet('配置已备份'), bullet('连通性已确认'), heading(1, '执行步骤'), paragraph(''), heading(1, '验证结果'), paragraph(''), heading(1, '回退方案'), paragraph('')]
  },
  {
    id: 'incident', name: '故障处理', description: '记录现象、排查过程、根因与复盘', builtIn: true,
    blocks: [heading(1, '故障现象'), paragraph(''), heading(1, '影响范围'), paragraph(''), heading(1, '排查过程'), paragraph(''), heading(1, '根因'), paragraph(''), heading(1, '解决方案'), paragraph(''), heading(1, '后续改进'), bullet('')]
  },
  {
    id: 'daily', name: '工作日报', description: '今日完成、问题和明日计划', builtIn: true,
    blocks: [heading(1, '今日完成'), bullet(''), heading(1, '问题与风险'), bullet(''), heading(1, '明日计划'), bullet('')]
  }
]

export async function loadCustomTemplates(): Promise<NoteTemplate[]> {
  const value = await ipc.settings.get('noteTemplates') as NoteTemplate[] | undefined
  return Array.isArray(value) ? value : []
}

export async function saveCustomTemplate(name: string, blocks: any[]): Promise<void> {
  const current = await loadCustomTemplates()
  current.push({ id: crypto.randomUUID(), name, description: '由现有笔记保存', blocks: JSON.parse(JSON.stringify(blocks)) })
  await ipc.settings.set('noteTemplates', current)
}

export async function removeCustomTemplate(id: string): Promise<void> {
  await ipc.settings.set('noteTemplates', (await loadCustomTemplates()).filter((item) => item.id !== id))
}

function freshBlocks(blocks: any[]): any[] {
  return JSON.parse(JSON.stringify(blocks)).map((block: any) => {
    const { id: _id, ...rest } = block
    return { ...rest, children: Array.isArray(rest.children) ? freshBlocks(rest.children) : [] }
  })
}

export async function createFromTemplate(parent: string, title: string, template: NoteTemplate): Promise<string> {
  const path = await createDoc(parent, title)
  const doc: BijiDoc = { ...emptyDoc(title), blocks: freshBlocks(template.blocks) }
  await saveDoc(path, doc)
  return path
}
