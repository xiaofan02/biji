import { useMemo, useRef, useState } from 'react'
import { createReactBlockSpec } from '@blocknote/react'
import './spreadsheetBlock.css'

type Cell = { row: number; col: number }
type Grid = string[][]
type CellStyle = { bold?: boolean; italic?: boolean; underline?: boolean; color?: string; background?: string; align?: 'left' | 'center' | 'right'; format?: 'general' | 'number' | 'percent' | 'currency' }
type StyleMap = Record<string, CellStyle>
type WorkbookSnapshot = { sheets: WorkbookSheet[]; activeSheet: number }
export type WorkbookSheet = {
  id: string
  name: string
  data: string
  styles: string
  columnWidths: string
  frozenRows: number
}

const MIN_ROWS = 8
const MIN_COLS = 6
const MAX_ROWS = 2000
const MAX_COLS = 100

function parseGrid(value: unknown): Grid {
  try {
    const parsed = JSON.parse(String(value || '[]'))
    if (!Array.isArray(parsed)) return [['']]
    const rows = parsed.slice(0, MAX_ROWS).map((row) =>
      Array.isArray(row) ? row.slice(0, MAX_COLS).map((cell) => String(cell ?? '')) : ['']
    )
    return rows.length ? rows : [['']]
  } catch {
    return [['']]
  }
}

function normalizeGrid(source: Grid, minRows = MIN_ROWS, minCols = MIN_COLS): Grid {
  const rows = Math.max(minRows, source.length, 1)
  const cols = Math.max(minCols, ...source.map((row) => row.length), 1)
  return Array.from({ length: Math.min(rows, MAX_ROWS) }, (_, row) =>
    Array.from({ length: Math.min(cols, MAX_COLS) }, (_, col) => source[row]?.[col] ?? '')
  )
}

function columnName(index: number): string {
  let value = index + 1
  let result = ''
  while (value > 0) {
    value--
    result = String.fromCharCode(65 + (value % 26)) + result
    value = Math.floor(value / 26)
  }
  return result
}

function bounds(a: Cell, b: Cell) {
  return {
    top: Math.min(a.row, b.row),
    bottom: Math.max(a.row, b.row),
    left: Math.min(a.col, b.col),
    right: Math.max(a.col, b.col)
  }
}

function parseJson<T>(value: unknown, fallback: T): T {
  try { return JSON.parse(String(value || '')) as T } catch { return fallback }
}

function cellKey(row: number, col: number) { return `${row}:${col}` }

function workbookSheets(block: any): WorkbookSheet[] {
  const parsed = parseJson<Partial<WorkbookSheet>[]>(block.props.sheets, [])
  if (Array.isArray(parsed) && parsed.length) {
    return parsed.map((sheet, index) => ({
      id: String(sheet.id || `${block.id || 'sheet'}-${index + 1}`),
      name: String(sheet.name || `Sheet${index + 1}`),
      data: typeof sheet.data === 'string' ? sheet.data : JSON.stringify(sheet.data || [['']]),
      styles: typeof sheet.styles === 'string' ? sheet.styles : JSON.stringify(sheet.styles || {}),
      columnWidths: typeof sheet.columnWidths === 'string' ? sheet.columnWidths : JSON.stringify(sheet.columnWidths || []),
      frozenRows: Number(sheet.frozenRows || 0)
    }))
  }
  return [{
    id: `${block.id || 'sheet'}-1`,
    name: String(block.props.name || 'Sheet1'),
    data: String(block.props.data || '[[""]]'),
    styles: String(block.props.styles || '{}'),
    columnWidths: String(block.props.columnWidths || '[]'),
    frozenRows: Number(block.props.frozenRows || 0)
  }]
}

function arithmetic(expression: string): number {
  const tokens = expression.match(/\d+(?:\.\d+)?|[()+\-*/]/g) || []
  let index = 0
  const factor = (): number => {
    const token = tokens[index++]
    if (token === '(') { const value = sum(); if (tokens[index++] !== ')') throw new Error('括号'); return value }
    if (token === '-') return -factor()
    const value = Number(token)
    if (!Number.isFinite(value)) throw new Error('数字')
    return value
  }
  const product = (): number => {
    let value = factor()
    while (tokens[index] === '*' || tokens[index] === '/') {
      const operator = tokens[index++]
      const right = factor()
      value = operator === '*' ? value * right : value / right
    }
    return value
  }
  const sum = (): number => {
    let value = product()
    while (tokens[index] === '+' || tokens[index] === '-') {
      const operator = tokens[index++]
      const right = product()
      value = operator === '+' ? value + right : value - right
    }
    return value
  }
  const result = sum()
  if (index !== tokens.length) throw new Error('表达式')
  return result
}

function formulaValue(raw: string, grid: Grid): string {
  if (!raw.startsWith('=')) return raw
  const numberAt = (ref: string) => {
    const match = ref.match(/^([A-Z]+)(\d+)$/i)
    if (!match) return 0
    let col = 0
    for (const char of match[1].toUpperCase()) col = col * 26 + char.charCodeAt(0) - 64
    return Number(grid[Number(match[2]) - 1]?.[col - 1]) || 0
  }
  const rangeValues = (range: string) => {
    const [start, end] = range.split(':')
    const a = start.match(/^([A-Z]+)(\d+)$/i); const b = end.match(/^([A-Z]+)(\d+)$/i)
    if (!a || !b) return []
    const colIndex = (letters: string) => [...letters.toUpperCase()].reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0) - 1
    const left = Math.min(colIndex(a[1]), colIndex(b[1])); const right = Math.max(colIndex(a[1]), colIndex(b[1]))
    const top = Math.min(Number(a[2]), Number(b[2])) - 1; const bottom = Math.max(Number(a[2]), Number(b[2])) - 1
    const values: number[] = []
    for (let row = top; row <= bottom; row++) for (let col = left; col <= right; col++) {
      const raw = grid[row]?.[col]
      values.push(raw === undefined || raw.trim() === '' ? Number.NaN : Number(raw))
    }
    return values
  }
  try {
    let expression = raw.slice(1).toUpperCase()
    expression = expression.replace(/(SUM|AVERAGE|MIN|MAX|COUNT)\(([A-Z]+\d+:[A-Z]+\d+)\)/g, (_all, fn, range) => {
      const values = rangeValues(range)
      const numeric = values.filter((value) => Number.isFinite(value))
      if (fn === 'SUM') return String(numeric.reduce((a, b) => a + b, 0))
      if (fn === 'AVERAGE') return String(numeric.length ? numeric.reduce((a, b) => a + b, 0) / numeric.length : 0)
      if (fn === 'MIN') return String(numeric.length ? Math.min(...numeric) : 0)
      if (fn === 'MAX') return String(numeric.length ? Math.max(...numeric) : 0)
      return String(numeric.length)
    })
    expression = expression.replace(/\b[A-Z]+\d+\b/g, (ref) => String(numberAt(ref)))
    if (!/^[\d+\-*/().\s]+$/.test(expression)) return '#公式?'
    const result = arithmetic(expression)
    return Number.isFinite(result) ? String(Math.round(result * 1e10) / 1e10) : '#错误'
  } catch { return '#错误' }
}

function displayValue(raw: string, grid: Grid, style?: CellStyle): string {
  const value = formulaValue(raw, grid)
  if (!style?.format || style.format === 'general' || value === '') return value
  const number = Number(value)
  if (!Number.isFinite(number)) return value
  if (style.format === 'percent') return `${(number * 100).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}%`
  if (style.format === 'currency') return number.toLocaleString('zh-CN', { style: 'currency', currency: 'CNY', minimumFractionDigits: 2 })
  return number.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function SpreadsheetView({ block, editor }: any) {
  const sheets = useMemo(() => workbookSheets(block), [block.id, block.props.sheets, block.props.name, block.props.data, block.props.styles, block.props.columnWidths, block.props.frozenRows])
  const activeSheet = Math.max(0, Math.min(Number(block.props.activeSheet || 0), sheets.length - 1))
  const sheet = sheets[activeSheet]
  const grid = useMemo(() => normalizeGrid(parseGrid(sheet.data)), [sheet.data])
  const [anchor, setAnchor] = useState<Cell>({ row: 0, col: 0 })
  const [active, setActive] = useState<Cell>({ row: 0, col: 0 })
  const dragging = useRef(false)
  const tableRef = useRef<HTMLDivElement>(null)
  const range = bounds(anchor, active)
  const styles = useMemo(() => parseJson<StyleMap>(sheet.styles, {}), [sheet.styles])
  const widths = useMemo(() => parseJson<number[]>(sheet.columnWidths, []), [sheet.columnWidths])
  const [editing, setEditing] = useState<string | null>(null)
  const [filterText, setFilterText] = useState('')
  const [ribbonTab, setRibbonTab] = useState<'home' | 'insert' | 'data' | 'view'>('home')
  const [sheetMenu, setSheetMenu] = useState<number | null>(null)
  const [cellMenu, setCellMenu] = useState<{ x: number; y: number } | null>(null)
  const draggedSheet = useRef<number | null>(null)
  const undoStack = useRef<WorkbookSnapshot[]>([])
  const redoStack = useRef<WorkbookSnapshot[]>([])
  const resizingColumn = useRef<{ col: number; startX: number; startWidth: number } | null>(null)

  const commitSheets = (next: WorkbookSheet[], nextActive = activeSheet, remember = true) => {
    const safeActive = Math.max(0, Math.min(nextActive, next.length - 1))
    const current = next[safeActive]
    if (remember) {
      undoStack.current.push({ sheets: structuredClone(sheets), activeSheet })
      if (undoStack.current.length > 80) undoStack.current.shift()
      redoStack.current = []
    }
    editor.updateBlock(block, { props: {
      sheets: JSON.stringify(next),
      activeSheet: safeActive,
      // 同步保留旧字段，保证旧版客户端和已有导出逻辑仍可读取当前工作表。
      name: current.name,
      data: current.data,
      styles: current.styles,
      columnWidths: current.columnWidths,
      frozenRows: current.frozenRows
    } })
  }

  const updateSheet = (patch: Partial<WorkbookSheet>) => {
    const next = sheets.map((item, index) => index === activeSheet ? { ...item, ...patch } : item)
    commitSheets(next)
  }

  const commit = (next: Grid) => {
    updateSheet({ data: JSON.stringify(next) })
  }

  const switchSheet = (index: number) => {
    setAnchor({ row: 0, col: 0 })
    setActive({ row: 0, col: 0 })
    setEditing(null)
    setFilterText('')
    setSheetMenu(null)
    commitSheets(sheets, index, false)
  }

  const restoreSnapshot = (snapshot: WorkbookSnapshot) => {
    setAnchor({ row: 0, col: 0 })
    setActive({ row: 0, col: 0 })
    setEditing(null)
    commitSheets(snapshot.sheets, snapshot.activeSheet, false)
  }

  const undo = () => {
    const snapshot = undoStack.current.pop()
    if (!snapshot) return
    redoStack.current.push({ sheets: structuredClone(sheets), activeSheet })
    restoreSnapshot(snapshot)
  }

  const redo = () => {
    const snapshot = redoStack.current.pop()
    if (!snapshot) return
    undoStack.current.push({ sheets: structuredClone(sheets), activeSheet })
    restoreSnapshot(snapshot)
  }

  const uniqueSheetName = (base = 'Sheet') => {
    const used = new Set(sheets.map((item) => item.name.toLocaleLowerCase()))
    let index = 1
    let name = `${base}${index}`
    while (used.has(name.toLocaleLowerCase())) name = `${base}${++index}`
    return name
  }

  const addSheet = () => {
    const next = [...sheets, {
      id: crypto.randomUUID(),
      name: uniqueSheetName(),
      data: '[[""]]',
      styles: '{}',
      columnWidths: '[]',
      frozenRows: 0
    }]
    commitSheets(next, next.length - 1)
  }

  const renameSheet = (index: number) => {
    const value = window.prompt('重命名工作表', sheets[index].name)?.trim()
    if (!value) return
    const clean = value.replace(/[\\/?*\[\]:]/g, ' ').slice(0, 31).trim()
    if (!clean) return
    if (sheets.some((item, itemIndex) => itemIndex !== index && item.name.toLocaleLowerCase() === clean.toLocaleLowerCase())) {
      window.alert('工作表名称不能重复')
      return
    }
    const next = sheets.map((item, itemIndex) => itemIndex === index ? { ...item, name: clean } : item)
    commitSheets(next, activeSheet)
    setSheetMenu(null)
  }

  const duplicateSheet = (index: number) => {
    const original = sheets[index]
    const base = `${original.name} 副本`
    let name = base
    let suffix = 2
    while (sheets.some((item) => item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) name = `${base} ${suffix++}`
    const copy = { ...original, id: crypto.randomUUID(), name }
    const next = [...sheets]
    next.splice(index + 1, 0, copy)
    commitSheets(next, index + 1)
    setSheetMenu(null)
  }

  const deleteSheet = (index: number) => {
    if (sheets.length === 1) {
      window.alert('工作簿至少需要保留一个工作表')
      return
    }
    if (!window.confirm(`确定删除工作表“${sheets[index].name}”吗？`)) return
    const next = sheets.filter((_, itemIndex) => itemIndex !== index)
    const nextActive = activeSheet > index ? activeSheet - 1 : Math.min(activeSheet, next.length - 1)
    commitSheets(next, nextActive)
    setSheetMenu(null)
  }

  const reorderSheet = (from: number, to: number) => {
    if (from === to) return
    const next = [...sheets]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    const currentId = sheet.id
    commitSheets(next, next.findIndex((item) => item.id === currentId))
  }

  const focusCell = (cell: Cell, extend = false) => {
    const row = Math.max(0, Math.min(cell.row, grid.length - 1))
    const col = Math.max(0, Math.min(cell.col, grid[0].length - 1))
    const next = { row, col }
    if (!extend) setAnchor(next)
    setActive(next)
    requestAnimationFrame(() => {
      tableRef.current?.querySelector<HTMLInputElement>(`input[data-cell="${row}:${col}"]`)?.focus()
    })
  }

  const updateCell = (row: number, col: number, value: string) => {
    const next = grid.map((line) => [...line])
    next[row][col] = value
    commit(next)
  }

  const updateSelectionStyle = (patch: Partial<CellStyle>) => {
    const next = { ...styles }
    for (let row = range.top; row <= range.bottom; row++) for (let col = range.left; col <= range.right; col++) {
      const key = cellKey(row, col)
      next[key] = { ...(next[key] || {}), ...patch }
    }
    updateSheet({ styles: JSON.stringify(next) })
  }

  const clearSelectionStyle = () => {
    const next = { ...styles }
    for (let row = range.top; row <= range.bottom; row++) {
      for (let col = range.left; col <= range.right; col++) delete next[cellKey(row, col)]
    }
    updateSheet({ styles: JSON.stringify(next) })
  }

  const fillDown = () => {
    if (range.bottom <= range.top) return
    const next = grid.map((line) => [...line])
    for (let col = range.left; col <= range.right; col++) {
      const source = next[range.top][col]
      for (let row = range.top + 1; row <= range.bottom; row++) next[row][col] = source
    }
    commit(next)
  }

  const fillRight = () => {
    if (range.right <= range.left) return
    const next = grid.map((line) => [...line])
    for (let row = range.top; row <= range.bottom; row++) {
      const source = next[row][range.left]
      for (let col = range.left + 1; col <= range.right; col++) next[row][col] = source
    }
    commit(next)
  }

  const autoFitColumn = (col: number) => {
    const longest = grid.reduce((max, row) => Math.max(max, formulaValue(row[col] || '', grid).length), columnName(col).length)
    const next = Array.from({ length: grid[0].length }, (_, index) => widths[index] || 120)
    next[col] = Math.max(60, Math.min(420, longest * 8 + 24))
    updateSheet({ columnWidths: JSON.stringify(next) })
  }

  const selectionStats = useMemo(() => {
    const values: string[] = []
    for (let row = range.top; row <= range.bottom; row++) {
      for (let col = range.left; col <= range.right; col++) {
        const value = formulaValue(grid[row]?.[col] || '', grid)
        if (value !== '') values.push(value)
      }
    }
    const numbers = values.map(Number).filter(Number.isFinite)
    const sum = numbers.reduce((total, value) => total + value, 0)
    return {
      count: values.length,
      numericCount: numbers.length,
      sum: Math.round(sum * 1e10) / 1e10,
      average: numbers.length ? Math.round((sum / numbers.length) * 1e10) / 1e10 : 0
    }
  }, [grid, range.top, range.bottom, range.left, range.right])

  const resizeColumn = (delta: number) => {
    const next = Array.from({ length: grid[0].length }, (_, index) => widths[index] || 120)
    next[active.col] = Math.max(60, Math.min(420, next[active.col] + delta))
    updateSheet({ columnWidths: JSON.stringify(next) })
  }

  const sortRows = (direction: 1 | -1) => {
    const next = grid.map((row) => [...row])
    const selected = next.slice(range.top, range.bottom + 1).sort((a, b) =>
      String(a[active.col] || '').localeCompare(String(b[active.col] || ''), 'zh', { numeric: true }) * direction
    )
    next.splice(range.top, selected.length, ...selected)
    commit(next)
  }

  const findReplace = () => {
    const find = window.prompt('查找内容')
    if (!find) return
    const replacement = window.prompt('替换为', '')
    if (replacement === null) return
    commit(grid.map((row) => row.map((value) => value.split(find).join(replacement))))
  }

  const pasteGrid = (text: string) => {
    const pasted = text.replace(/\r/g, '').split('\n').filter((line, index, all) => line.length || index < all.length - 1)
      .map((line) => line.split('\t'))
    if (!pasted.length) return
    const neededRows = Math.min(MAX_ROWS, Math.max(grid.length, active.row + pasted.length))
    const neededCols = Math.min(MAX_COLS, Math.max(grid[0].length, active.col + Math.max(...pasted.map((row) => row.length))))
    const next = normalizeGrid(grid, neededRows, neededCols)
    pasted.forEach((row, rowOffset) => row.forEach((value, colOffset) => {
      if (active.row + rowOffset < MAX_ROWS && active.col + colOffset < MAX_COLS) {
        next[active.row + rowOffset][active.col + colOffset] = value
      }
    }))
    commit(next)
    setAnchor(active)
    setActive({
      row: Math.min(active.row + pasted.length - 1, next.length - 1),
      col: Math.min(active.col + Math.max(...pasted.map((row) => row.length)) - 1, next[0].length - 1)
    })
  }

  const copyRange = async () => {
    const text = grid.slice(range.top, range.bottom + 1)
      .map((row) => row.slice(range.left, range.right + 1).join('\t'))
      .join('\n')
    await navigator.clipboard.writeText(text)
  }

  const cutRange = async () => {
    await copyRange()
    clearRange()
  }

  const clearRange = () => {
    const next = grid.map((line) => [...line])
    for (let row = range.top; row <= range.bottom; row++) {
      for (let col = range.left; col <= range.right; col++) next[row][col] = ''
    }
    commit(next)
  }

  const addRow = () => {
    if (grid.length >= MAX_ROWS) return
    commit([...grid, Array.from({ length: grid[0].length }, () => '')])
  }
  const addColumn = () => {
    if (grid[0].length >= MAX_COLS) return
    commit(grid.map((row) => [...row, '']))
  }
  const insertRow = () => {
    if (grid.length >= MAX_ROWS) return
    const next = grid.map((row) => [...row])
    next.splice(active.row, 0, Array.from({ length: grid[0].length }, () => ''))
    commit(next)
  }
  const insertColumn = () => {
    if (grid[0].length >= MAX_COLS) return
    commit(grid.map((row) => { const next = [...row]; next.splice(active.col, 0, ''); return next }))
  }
  const deleteRows = () => {
    const next = grid.filter((_, index) => index < range.top || index > range.bottom)
    commit(normalizeGrid(next.length ? next : [['']]))
    focusCell({ row: Math.min(range.top, Math.max(next.length - 1, 0)), col: active.col })
  }
  const deleteColumns = () => {
    const next = grid.map((row) => row.filter((_, index) => index < range.left || index > range.right))
    commit(normalizeGrid(next[0]?.length ? next : [['']]))
    focusCell({ row: active.row, col: Math.min(range.left, Math.max((next[0]?.length || 1) - 1, 0)) })
  }

  const startColumnResize = (event: React.MouseEvent, col: number) => {
    event.preventDefault()
    event.stopPropagation()
    undoStack.current.push({ sheets: structuredClone(sheets), activeSheet })
    if (undoStack.current.length > 80) undoStack.current.shift()
    redoStack.current = []
    resizingColumn.current = { col, startX: event.clientX, startWidth: widths[col] || 120 }
    const onMove = (moveEvent: MouseEvent) => {
      const current = resizingColumn.current
      if (!current) return
      const next = Array.from({ length: grid[0].length }, (_, index) => widths[index] || 120)
      next[current.col] = Math.max(60, Math.min(420, current.startWidth + moveEvent.clientX - current.startX))
      const updated = sheets.map((item, index) => index === activeSheet ? { ...item, columnWidths: JSON.stringify(next) } : item)
      commitSheets(updated, activeSheet, false)
    }
    const onUp = () => {
      resizingColumn.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div className="moqi-spreadsheet" contentEditable={false}>
      <div className="moqi-sheet-ribbon-tabs">
        <span className="moqi-sheet-app-mark" aria-hidden="true">X</span>
        {([
          ['home', '开始'],
          ['insert', '插入'],
          ['data', '数据'],
          ['view', '视图']
        ] as const).map(([id, label]) => (
          <button key={id} type="button" className={ribbonTab === id ? 'active' : ''} onClick={() => setRibbonTab(id)}>{label}</button>
        ))}
        <input
          className="moqi-sheet-name"
          value={sheet.name}
          aria-label="工作表名称"
          title="工作表名称"
          onChange={(event) => updateSheet({ name: event.target.value })}
        />
      </div>
      <div className="moqi-sheet-ribbon">
        {ribbonTab === 'home' && <>
          <div className="moqi-ribbon-group compact">
            <button type="button" className="moqi-ribbon-command large" title="撤销（Ctrl+Z）" onClick={undo}><span>↶</span><small>撤销</small></button>
            <button type="button" className="moqi-ribbon-command large" title="重做（Ctrl+Y）" onClick={redo}><span>↷</span><small>重做</small></button>
            <button type="button" className="moqi-ribbon-command large" title="剪切所选单元格（Ctrl+X）" onClick={() => void cutRange()}><span>✂</span><small>剪切</small></button>
            <button type="button" className="moqi-ribbon-command large" title="复制所选单元格" onClick={() => void copyRange()}><span>▣</span><small>复制</small></button>
            <button type="button" className="moqi-ribbon-command large" title="清除所选内容" onClick={clearRange}><span>⌫</span><small>清除</small></button>
            <label>剪贴板</label>
          </div>
          <div className="moqi-ribbon-group">
            <div className="moqi-ribbon-row">
              <button type="button" className={styles[cellKey(active.row, active.col)]?.bold ? 'is-pressed' : ''} title="加粗" onClick={() => updateSelectionStyle({ bold: !styles[cellKey(active.row, active.col)]?.bold })}><strong>B</strong></button>
              <button type="button" className={styles[cellKey(active.row, active.col)]?.italic ? 'is-pressed' : ''} title="斜体（Ctrl+I）" onClick={() => updateSelectionStyle({ italic: !styles[cellKey(active.row, active.col)]?.italic })}><em>I</em></button>
              <button type="button" className={styles[cellKey(active.row, active.col)]?.underline ? 'is-pressed' : ''} title="下划线（Ctrl+U）" onClick={() => updateSelectionStyle({ underline: !styles[cellKey(active.row, active.col)]?.underline })}><u>U</u></button>
              <label className="moqi-color-control" title="文字颜色"><strong>A</strong><i style={{ background: styles[cellKey(active.row, active.col)]?.color || '#d13438' }} /><input type="color" value={styles[cellKey(active.row, active.col)]?.color || '#1f2329'} onChange={(event) => updateSelectionStyle({ color: event.target.value })} /></label>
              <label className="moqi-color-control fill" title="填充颜色"><span>▰</span><i style={{ background: styles[cellKey(active.row, active.col)]?.background || '#fff2cc' }} /><input type="color" value={styles[cellKey(active.row, active.col)]?.background || '#ffffff'} onChange={(event) => updateSelectionStyle({ background: event.target.value })} /></label>
            </div>
            <label>字体</label>
          </div>
          <div className="moqi-ribbon-group">
            <div className="moqi-ribbon-row">
              <button type="button" title="左对齐" onClick={() => updateSelectionStyle({ align: 'left' })}>☰</button>
              <button type="button" title="居中" onClick={() => updateSelectionStyle({ align: 'center' })}>≡</button>
              <button type="button" title="右对齐" onClick={() => updateSelectionStyle({ align: 'right' })}>☷</button>
            </div>
            <label>对齐方式</label>
          </div>
          <div className="moqi-ribbon-group moqi-number-format-group">
            <select value={styles[cellKey(active.row, active.col)]?.format || 'general'} onChange={(event) => updateSelectionStyle({ format: event.target.value as CellStyle['format'] })} title="数字格式">
              <option value="general">常规</option>
              <option value="number">数值</option>
              <option value="percent">百分比</option>
              <option value="currency">人民币</option>
            </select>
            <button type="button" title="清除所选单元格格式" onClick={clearSelectionStyle}>清除格式</button>
            <label>数字与格式</label>
          </div>
          <div className="moqi-ribbon-group compact">
            <button type="button" className="moqi-ribbon-command large" onClick={findReplace}><span>⌕</span><small>查找替换</small></button>
            <button type="button" className="moqi-ribbon-command large" title="把选区首行复制到下方（Ctrl+D）" onClick={fillDown}><span>↓</span><small>向下填充</small></button>
            <button type="button" className="moqi-ribbon-command large" title="把选区首列复制到右侧（Ctrl+R）" onClick={fillRight}><span>→</span><small>向右填充</small></button>
            <label>编辑</label>
          </div>
        </>}
        {ribbonTab === 'insert' && <>
          <div className="moqi-ribbon-group compact">
            <button type="button" className="moqi-ribbon-command large" onClick={insertRow}><span>＋</span><small>上方插入行</small></button>
            <button type="button" className="moqi-ribbon-command large" onClick={insertColumn}><span>＋</span><small>左侧插入列</small></button>
            <label>插入单元格</label>
          </div>
          <div className="moqi-ribbon-group compact">
            <button type="button" className="moqi-ribbon-command large" onClick={addRow}><span>↓</span><small>末尾新增行</small></button>
            <button type="button" className="moqi-ribbon-command large" onClick={addColumn}><span>→</span><small>末尾新增列</small></button>
            <label>扩展工作表</label>
          </div>
          <div className="moqi-ribbon-group compact">
            <button type="button" className="moqi-ribbon-command large danger" onClick={deleteRows}><span>−</span><small>删除所选行</small></button>
            <button type="button" className="moqi-ribbon-command large danger" onClick={deleteColumns}><span>−</span><small>删除所选列</small></button>
            <label>删除</label>
          </div>
        </>}
        {ribbonTab === 'data' && <>
          <div className="moqi-ribbon-group compact">
            <button type="button" className="moqi-ribbon-command large" title="按当前列升序" onClick={() => sortRows(1)}><span>A↓Z</span><small>升序</small></button>
            <button type="button" className="moqi-ribbon-command large" title="按当前列降序" onClick={() => sortRows(-1)}><span>Z↓A</span><small>降序</small></button>
            <label>排序</label>
          </div>
          <div className="moqi-ribbon-group moqi-ribbon-filter-group">
            <input className="moqi-sheet-filter" value={filterText} onChange={(event) => setFilterText(event.target.value)} placeholder={`筛选 ${columnName(active.col)} 列`} />
            <button type="button" onClick={() => setFilterText('')}>清除筛选</button>
            <label>筛选</label>
          </div>
        </>}
        {ribbonTab === 'view' && <>
          <div className="moqi-ribbon-group compact">
            <button type="button" className="moqi-ribbon-command large" onClick={() => updateSheet({ frozenRows: sheet.frozenRows ? 0 : 1 })}><span>▤</span><small>{sheet.frozenRows ? '取消冻结' : '冻结首行'}</small></button>
            <label>窗口</label>
          </div>
          <div className="moqi-ribbon-group compact">
            <button type="button" className="moqi-ribbon-command large" title="缩小当前列" onClick={() => resizeColumn(-20)}><span>↔</span><small>缩小列宽</small></button>
            <button type="button" className="moqi-ribbon-command large" title="加宽当前列" onClick={() => resizeColumn(20)}><span>⟷</span><small>加宽列宽</small></button>
            <label>列宽</label>
          </div>
        </>}
      </div>
      <div className="moqi-formula-bar">
        <span className="moqi-sheet-range">{columnName(range.left)}{range.top + 1}{range.left !== range.right || range.top !== range.bottom ? `:${columnName(range.right)}${range.bottom + 1}` : ''}</span>
        <span className="moqi-formula-fx">fx</span>
        <input value={grid[active.row]?.[active.col] || ''} onChange={(event) => updateCell(active.row, active.col, event.target.value)} placeholder="输入值或公式，例如 =SUM(A1:A10)" />
      </div>
      <div
        className="moqi-sheet-scroll"
        ref={tableRef}
        tabIndex={0}
        onMouseLeave={() => { dragging.current = false }}
        onMouseUp={() => { dragging.current = false }}
      >
        <table>
          <thead><tr>
            <th className="moqi-sheet-corner" title="选择全部" onClick={() => { setAnchor({ row: 0, col: 0 }); setActive({ row: grid.length - 1, col: grid[0].length - 1 }) }}><span /></th>
            {grid[0].map((_, col) => <th key={col} style={{ width: widths[col] || 120, minWidth: widths[col] || 120 }} onClick={() => { setAnchor({ row: 0, col }); setActive({ row: grid.length - 1, col }) }}>
              {columnName(col)}
              <span className="moqi-column-resizer" title="拖动调整列宽；双击自动适应内容" onMouseDown={(event) => startColumnResize(event, col)} onDoubleClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                autoFitColumn(col)
              }} />
            </th>)}
          </tr></thead>
          <tbody>
            {grid.map((row, rowIndex) => ({ row, rowIndex })).filter(({ row }) => !filterText || String(row[active.col] || '').toLowerCase().includes(filterText.toLowerCase())).map(({ row, rowIndex }) => (
              <tr key={rowIndex}>
                <th className="moqi-sheet-row-number" onClick={() => { setAnchor({ row: rowIndex, col: 0 }); setActive({ row: rowIndex, col: grid[0].length - 1 }) }}>{rowIndex + 1}</th>
                {row.map((value, colIndex) => {
                  const selected = rowIndex >= range.top && rowIndex <= range.bottom && colIndex >= range.left && colIndex <= range.right
                  const current = rowIndex === active.row && colIndex === active.col
                  return (
                    <td
                      key={colIndex}
                      className={`${selected ? 'is-selected' : ''} ${current ? 'is-active' : ''}`}
                      style={{ width: widths[colIndex] || 120, minWidth: widths[colIndex] || 120, background: styles[cellKey(rowIndex, colIndex)]?.background, position: sheet.frozenRows && rowIndex === 0 ? 'sticky' : undefined, top: sheet.frozenRows && rowIndex === 0 ? 30 : undefined, zIndex: sheet.frozenRows && rowIndex === 0 ? 2 : undefined }}
                      onMouseDown={(event) => {
                        event.stopPropagation()
                        dragging.current = true
                        focusCell({ row: rowIndex, col: colIndex }, event.shiftKey)
                      }}
                      onMouseEnter={() => { if (dragging.current) setActive({ row: rowIndex, col: colIndex }) }}
                      onContextMenu={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        if (!selected) { setAnchor({ row: rowIndex, col: colIndex }); setActive({ row: rowIndex, col: colIndex }) }
                        setCellMenu({ x: event.clientX, y: event.clientY })
                      }}
                    >
                      <input
                        data-cell={`${rowIndex}:${colIndex}`}
                        value={editing === cellKey(rowIndex, colIndex) ? value : displayValue(value, grid, styles[cellKey(rowIndex, colIndex)])}
                        style={{ color: styles[cellKey(rowIndex, colIndex)]?.color, fontWeight: styles[cellKey(rowIndex, colIndex)]?.bold ? 700 : undefined, fontStyle: styles[cellKey(rowIndex, colIndex)]?.italic ? 'italic' : undefined, textDecoration: styles[cellKey(rowIndex, colIndex)]?.underline ? 'underline' : undefined, textAlign: styles[cellKey(rowIndex, colIndex)]?.align }}
                        onChange={(event) => updateCell(rowIndex, colIndex, event.target.value)}
                        onFocus={() => { setEditing(cellKey(rowIndex, colIndex)); if (!dragging.current) focusCell({ row: rowIndex, col: colIndex }) }}
                        onBlur={() => setEditing(null)}
                        onPaste={(event) => {
                          const text = event.clipboardData.getData('text/plain')
                          event.preventDefault()
                          pasteGrid(text)
                        }}
                        onKeyDown={(event) => {
                          if (event.ctrlKey || event.metaKey) {
                            const key = event.key.toLowerCase()
                            if (key === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); return }
                            if (key === 'y') { event.preventDefault(); redo(); return }
                            if (key === 'a') {
                              event.preventDefault()
                              setAnchor({ row: 0, col: 0 })
                              setActive({ row: grid.length - 1, col: grid[0].length - 1 })
                              return
                            }
                            if (key === 'c') { event.preventDefault(); void copyRange(); return }
                            if (key === 'x') { event.preventDefault(); void cutRange(); return }
                            if (key === 'b') {
                              event.preventDefault()
                              updateSelectionStyle({ bold: !styles[cellKey(active.row, active.col)]?.bold })
                              return
                            }
                            if (key === 'i') { event.preventDefault(); updateSelectionStyle({ italic: !styles[cellKey(active.row, active.col)]?.italic }); return }
                            if (key === 'u') { event.preventDefault(); updateSelectionStyle({ underline: !styles[cellKey(active.row, active.col)]?.underline }); return }
                            if (key === 'd') { event.preventDefault(); fillDown(); return }
                            if (key === 'r') { event.preventDefault(); fillRight(); return }
                          }
                          if ((event.key === 'Delete' || event.key === 'Backspace') && (range.top !== range.bottom || range.left !== range.right)) {
                            event.preventDefault()
                            clearRange()
                            return
                          }
                          const moves: Record<string, Cell> = {
                            ArrowUp: { row: rowIndex - 1, col: colIndex },
                            ArrowDown: { row: rowIndex + 1, col: colIndex },
                            ArrowLeft: { row: rowIndex, col: colIndex - 1 },
                            ArrowRight: { row: rowIndex, col: colIndex + 1 },
                            Enter: { row: rowIndex + (event.shiftKey ? -1 : 1), col: colIndex },
                            Tab: { row: rowIndex, col: colIndex + (event.shiftKey ? -1 : 1) }
                          }
                          if (moves[event.key]) {
                            event.preventDefault()
                            focusCell(moves[event.key], event.shiftKey && event.key.startsWith('Arrow'))
                          }
                        }}
                      />
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="moqi-sheet-tabs" onClick={() => setSheetMenu(null)}>
        <button className="moqi-sheet-add" type="button" title="新建工作表" onClick={(event) => { event.stopPropagation(); addSheet() }}>＋</button>
        <div className="moqi-sheet-tab-scroll">
          {sheets.map((item, index) => (
            <div
              key={item.id}
              className={`moqi-sheet-tab${index === activeSheet ? ' active' : ''}`}
              draggable
              onDragStart={(event) => {
                draggedSheet.current = index
                event.dataTransfer.effectAllowed = 'move'
                event.dataTransfer.setData('text/plain', item.id)
              }}
              onDragOver={(event) => {
                if (draggedSheet.current === null) return
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
              }}
              onDrop={(event) => {
                event.preventDefault()
                const from = draggedSheet.current
                draggedSheet.current = null
                if (from !== null) reorderSheet(from, index)
              }}
              onDragEnd={() => { draggedSheet.current = null }}
            >
              <button
                type="button"
                className="moqi-sheet-tab-name"
                title="单击切换，双击重命名；可拖拽排序"
                onClick={(event) => { event.stopPropagation(); switchSheet(index) }}
                onDoubleClick={(event) => { event.stopPropagation(); renameSheet(index) }}
              >
                {item.name || `Sheet${index + 1}`}
              </button>
              <button
                type="button"
                className="moqi-sheet-tab-menu-button"
                aria-label={`${item.name} 工作表菜单`}
                onClick={(event) => {
                  event.stopPropagation()
                  setSheetMenu(sheetMenu === index ? null : index)
                }}
              >⌄</button>
              {sheetMenu === index && (
                <div className="moqi-sheet-tab-menu" onClick={(event) => event.stopPropagation()}>
                  <button type="button" onClick={() => renameSheet(index)}>重命名</button>
                  <button type="button" onClick={() => duplicateSheet(index)}>复制工作表</button>
                  <button type="button" className="danger" onClick={() => deleteSheet(index)}>删除工作表</button>
                </div>
              )}
            </div>
          ))}
        </div>
        <span className="moqi-sheet-tab-hint">{sheets.length} 个工作表</span>
      </div>
      <div className="moqi-sheet-status">
        <span>就绪</span>
        <span>{selectionStats.count} 个非空单元格</span>
        {selectionStats.numericCount > 0 && <><span>平均值：{selectionStats.average}</span><span>求和：{selectionStats.sum}</span></>}
      </div>
      {cellMenu && <div className="moqi-cell-menu" style={{ left: cellMenu.x, top: cellMenu.y }} onMouseLeave={() => setCellMenu(null)}>
        <button type="button" onClick={() => { void cutRange(); setCellMenu(null) }}>剪切 <kbd>Ctrl+X</kbd></button>
        <button type="button" onClick={() => { void copyRange(); setCellMenu(null) }}>复制 <kbd>Ctrl+C</kbd></button>
        <button type="button" onClick={() => { clearRange(); setCellMenu(null) }}>清除内容 <kbd>Delete</kbd></button>
        <button type="button" onClick={() => { clearSelectionStyle(); setCellMenu(null) }}>清除格式</button>
        <hr />
        <button type="button" onClick={() => { insertRow(); setCellMenu(null) }}>在上方插入行</button>
        <button type="button" onClick={() => { insertColumn(); setCellMenu(null) }}>在左侧插入列</button>
        <button type="button" onClick={() => { fillDown(); setCellMenu(null) }}>向下填充</button>
        <button type="button" onClick={() => { fillRight(); setCellMenu(null) }}>向右填充</button>
      </div>}
    </div>
  )
}

function SpreadsheetExternal({ block }: any) {
  const sheets = workbookSheets(block)
  return (
    <div>
      {sheets.map((sheet) => {
        const grid = parseGrid(sheet.data)
        return <table key={sheet.id}>
          <caption>{sheet.name}</caption>
          <tbody>{grid.map((row, index) => <tr key={index}>{row.map((cell, col) => <td key={col}>{cell}</td>)}</tr>)}</tbody>
        </table>
      })}
    </div>
  )
}

export const spreadsheetBlock = createReactBlockSpec(
  {
    type: 'spreadsheet',
    propSchema: {
      name: { default: 'Sheet1' },
      data: { default: '[[""]]' },
      styles: { default: '{}' },
      columnWidths: { default: '[]' },
      frozenRows: { default: 0 },
      sheets: { default: '' },
      activeSheet: { default: 0 }
    },
    content: 'none'
  },
  {
    render: SpreadsheetView,
    toExternalHTML: SpreadsheetExternal
  }
)
