import { useMemo } from 'react'
import { createReactBlockSpec } from '@blocknote/react'
import './ganttBlock.css'

export type GanttTaskType = 'technical' | 'test' | 'communication' | 'risk' | 'document' | 'break'
export type GanttTaskStatus = 'todo' | 'doing' | 'done'

export type GanttTask = {
  id: string
  name: string
  start: string
  end: string
  type: GanttTaskType
  owner: string
  status: GanttTaskStatus
  note: string
}

const TYPE_OPTIONS: Array<{ value: GanttTaskType; label: string; color: string }> = [
  { value: 'technical', label: '技术实施', color: '#4f7cff' },
  { value: 'test', label: '测试验证', color: '#26a269' },
  { value: 'communication', label: '沟通协调', color: '#d99a16' },
  { value: 'risk', label: '风险窗口', color: '#e05252' },
  { value: 'document', label: '文档整理', color: '#8b5cf6' },
  { value: 'break', label: '休息时间', color: '#7d8799' }
]

const STATUS_OPTIONS: Array<{ value: GanttTaskStatus; label: string }> = [
  { value: 'todo', label: '未开始' },
  { value: 'doing', label: '进行中' },
  { value: 'done', label: '已完成' }
]

function taskId(): string {
  return globalThis.crypto?.randomUUID?.() || `task-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function localDateTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function atToday(hour: number, minute = 0): string {
  const date = new Date()
  date.setHours(hour, minute, 0, 0)
  return localDateTime(date)
}

export function createDefaultGanttTasks(): GanttTask[] {
  return [
    { id: taskId(), name: '环境与设备检查', start: atToday(8), end: atToday(10), type: 'technical', owner: '', status: 'todo', note: '' },
    { id: taskId(), name: '方案验证', start: atToday(9, 30), end: atToday(11, 30), type: 'test', owner: '', status: 'todo', note: '可与实施任务并行' },
    { id: taskId(), name: '结果整理与同步', start: atToday(13), end: atToday(15), type: 'document', owner: '', status: 'todo', note: '' }
  ]
}

function parseTasks(value: unknown): GanttTask[] {
  try {
    const parsed = JSON.parse(String(value || '[]'))
    if (!Array.isArray(parsed)) return []
    return parsed.slice(0, 200).map((item, index) => ({
      id: String(item?.id || `task-${index}`),
      name: String(item?.name || '未命名任务'),
      start: String(item?.start || ''),
      end: String(item?.end || ''),
      type: TYPE_OPTIONS.some((option) => option.value === item?.type) ? item.type : 'technical',
      owner: String(item?.owner || ''),
      status: STATUS_OPTIONS.some((option) => option.value === item?.status) ? item.status : 'todo',
      note: String(item?.note || '')
    }))
  } catch {
    return []
  }
}

function timeOf(value: string): number | null {
  const result = new Date(value).getTime()
  return Number.isFinite(result) ? result : null
}

function durationLabel(task: GanttTask): string {
  const start = timeOf(task.start)
  const end = timeOf(task.end)
  if (start === null || end === null || end <= start) return '时间待调整'
  const minutes = Math.round((end - start) / 60000)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`
}

function typeMeta(type: GanttTaskType) {
  return TYPE_OPTIONS.find((option) => option.value === type) || TYPE_OPTIONS[0]
}

function formatTick(value: number, includeDate: boolean): string {
  const date = new Date(value)
  const pad = (part: number) => String(part).padStart(2, '0')
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  return includeDate ? `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${time}` : time
}

function GanttView({ block, editor }: any) {
  const tasks = useMemo(() => parseTasks(block.props.tasks), [block.id, block.props.tasks])
  const validTimes = tasks.flatMap((task) => [timeOf(task.start), timeOf(task.end)]).filter((value): value is number => value !== null)
  const firstTime = validTimes.length ? Math.min(...validTimes) : Date.now()
  const lastTime = validTimes.length ? Math.max(...validTimes) : firstTime + 6 * 60 * 60 * 1000
  const minimumSpan = 6 * 60 * 60 * 1000
  const naturalSpan = Math.max(lastTime - firstTime, minimumSpan)
  const padding = Math.max(naturalSpan * 0.04, 15 * 60 * 1000)
  const rangeStart = firstTime - padding
  const rangeEnd = Math.max(lastTime + padding, rangeStart + minimumSpan)
  const range = rangeEnd - rangeStart
  const includeDate = new Date(rangeStart).toDateString() !== new Date(rangeEnd).toDateString()
  const ticks = Array.from({ length: 7 }, (_, index) => rangeStart + (range * index) / 6)

  const commit = (next: GanttTask[]) => {
    editor.updateBlock(block, { props: { tasks: JSON.stringify(next) } })
  }

  const updateTask = (id: string, patch: Partial<GanttTask>) => {
    commit(tasks.map((task) => task.id === id ? { ...task, ...patch } : task))
  }

  const addTask = () => {
    const latestEnd = Math.max(...tasks.map((task) => timeOf(task.end) || 0), Date.now())
    const start = new Date(latestEnd)
    start.setMinutes(Math.ceil(start.getMinutes() / 30) * 30, 0, 0)
    const end = new Date(start.getTime() + 60 * 60 * 1000)
    commit([...tasks, {
      id: taskId(), name: '新任务', start: localDateTime(start), end: localDateTime(end),
      type: 'technical', owner: '', status: 'todo', note: ''
    }])
  }

  const overlapCount = tasks.filter((task, index) => {
    const start = timeOf(task.start)
    const end = timeOf(task.end)
    if (start === null || end === null || end <= start) return false
    return tasks.some((other, otherIndex) => {
      if (index === otherIndex) return false
      const otherStart = timeOf(other.start)
      const otherEnd = timeOf(other.end)
      return otherStart !== null && otherEnd !== null && start < otherEnd && otherStart < end
    })
  }).length

  return (
    <div className="moqi-gantt" contentEditable={false}>
      <div className="moqi-gantt-head">
        <div>
          <input
            className="moqi-gantt-title"
            value={block.props.title || '项目计划'}
            aria-label="甘特图标题"
            onChange={(event) => editor.updateBlock(block, { props: { title: event.target.value } })}
          />
          <div className="moqi-gantt-summary">
            <span>{tasks.length} 项任务</span>
            {overlapCount > 0 && <span>{overlapCount} 项并行</span>}
          </div>
        </div>
        <button type="button" className="moqi-gantt-add" onClick={addTask}>＋ 添加任务</button>
      </div>

      <div className="moqi-gantt-timeline">
        <div className="moqi-gantt-axis">
          {ticks.map((tick, index) => <span key={index} style={{ left: `${(index / 6) * 100}%` }}>{formatTick(tick, includeDate)}</span>)}
        </div>
        <div className="moqi-gantt-lanes">
          {ticks.map((_, index) => <i key={index} className="moqi-gantt-gridline" style={{ left: `${(index / 6) * 100}%` }} />)}
          {tasks.map((task) => {
            const start = timeOf(task.start)
            const end = timeOf(task.end)
            const valid = start !== null && end !== null && end > start
            const left = valid ? Math.max(0, ((start - rangeStart) / range) * 100) : 0
            const width = valid ? Math.max(1.5, ((end - start) / range) * 100) : 0
            const meta = typeMeta(task.type)
            return (
              <div className="moqi-gantt-lane" key={task.id}>
                <span className="moqi-gantt-lane-name" title={task.name}>{task.name}</span>
                {valid ? (
                  <span
                    className={`moqi-gantt-bar status-${task.status}`}
                    style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%`, backgroundColor: meta.color }}
                    title={`${task.name} · ${durationLabel(task)}`}
                  >{task.owner || meta.label}</span>
                ) : <span className="moqi-gantt-invalid">请设置有效时间</span>}
              </div>
            )
          })}
          {!tasks.length && <div className="moqi-gantt-empty">暂无任务，点击右上角添加</div>}
        </div>
      </div>

      <div className="moqi-gantt-table-wrap">
        <table className="moqi-gantt-table">
          <thead><tr><th>任务</th><th>开始</th><th>结束</th><th>类型</th><th>负责人</th><th>状态</th><th>备注</th><th /></tr></thead>
          <tbody>{tasks.map((task) => (
            <tr key={task.id}>
              <td><input value={task.name} aria-label="任务名称" onChange={(event) => updateTask(task.id, { name: event.target.value })} /></td>
              <td><input type="datetime-local" value={task.start} aria-label="开始时间" onChange={(event) => updateTask(task.id, { start: event.target.value })} /></td>
              <td><input type="datetime-local" value={task.end} aria-label="结束时间" onChange={(event) => updateTask(task.id, { end: event.target.value })} /><small>{durationLabel(task)}</small></td>
              <td><select value={task.type} aria-label="任务类型" onChange={(event) => updateTask(task.id, { type: event.target.value as GanttTaskType })}>{TYPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></td>
              <td><input value={task.owner} placeholder="未指定" aria-label="负责人" onChange={(event) => updateTask(task.id, { owner: event.target.value })} /></td>
              <td><select value={task.status} aria-label="任务状态" onChange={(event) => updateTask(task.id, { status: event.target.value as GanttTaskStatus })}>{STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></td>
              <td><input value={task.note} placeholder="备注" aria-label="任务备注" onChange={(event) => updateTask(task.id, { note: event.target.value })} /></td>
              <td><button type="button" className="moqi-gantt-delete" aria-label={`删除 ${task.name}`} onClick={() => commit(tasks.filter((item) => item.id !== task.id))}>×</button></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  )
}

function GanttExternal({ block }: any) {
  const tasks = parseTasks(block.props.tasks)
  return (
    <div>
      <h3>{block.props.title || '项目计划'}</h3>
      <table>
        <thead><tr><th>任务</th><th>开始</th><th>结束</th><th>时长</th><th>类型</th><th>负责人</th><th>状态</th><th>备注</th></tr></thead>
        <tbody>{tasks.map((task) => <tr key={task.id}>
          <td>{task.name}</td><td>{task.start.replace('T', ' ')}</td><td>{task.end.replace('T', ' ')}</td><td>{durationLabel(task)}</td>
          <td>{typeMeta(task.type).label}</td><td>{task.owner}</td><td>{STATUS_OPTIONS.find((option) => option.value === task.status)?.label}</td><td>{task.note}</td>
        </tr>)}</tbody>
      </table>
    </div>
  )
}

export const ganttBlock = createReactBlockSpec(
  {
    type: 'gantt',
    propSchema: {
      title: { default: '项目计划' },
      tasks: { default: '[]' }
    },
    content: 'none'
  },
  {
    render: GanttView,
    toExternalHTML: GanttExternal
  }
)
