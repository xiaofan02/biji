import { useMemo, useRef, useState } from 'react'
import { createReactBlockSpec } from '@blocknote/react'
import './spreadsheetBlock.css'

type Cell = { row: number; col: number }
type Grid = string[][]
type CellStyle = { bold?: boolean; color?: string; background?: string; align?: 'left' | 'center' | 'right' }
type StyleMap = Record<string, CellStyle>
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
    for (let row = top; row <= bottom; row++) for (let col = left; col <= right; col++) values.push(Number(grid[row]?.[col]) || 0)
    return values
  }
  try {
    let expression = raw.slice(1).toUpperCase()
    expression = expression.replace(/(SUM|AVERAGE|MIN|MAX|COUNT)\(([A-Z]+\d+:[A-Z]+\d+)\)/g, (_all, fn, range) => {
      const values = rangeValues(range)
      if (fn === 'SUM') return String(values.reduce((a, b) => a + b, 0))
      if (fn === 'AVERAGE') return String(values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0)
      if (fn === 'MIN') return String(values.length ? Math.min(...values) : 0)
      if (fn === 'MAX') return String(values.length ? Math.max(...values) : 0)
      return String(values.filter((value) => Number.isFinite(value)).length)
    })
    expression = expression.replace(/\b[A-Z]+\d+\b/g, (ref) => String(numberAt(ref)))
    if (!/^[\d+\-*/().\s]+$/.test(expression)) return '#公式?'
    const result = arithmetic(expression)
    return Number.isFinite(result) ? String(Math.round(result * 1e10) / 1e10) : '#错误'
  } catch { return '#错误' }
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
  const [sheetMenu, setSheetMenu] = useState<number | null>(null)
  const draggedSheet = useRef<number | null>(null)

  const commitSheets = (next: WorkbookSheet[], nextActive = activeSheet) => {
    const safeActive = Math.max(0, Math.min(nextActive, next.length - 1))
    const current = next[safeActive]
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
    commitSheets(sheets, index)
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

  return (
    <div className="moqi-spreadsheet" contentEditable={false}>
      <div className="moqi-sheet-toolbar">
        <input
          className="moqi-sheet-name"
          value={sheet.name}
          aria-label="工作表名称"
          onChange={(event) => updateSheet({ name: event.target.value })}
        />
        <span className="moqi-sheet-range">{columnName(range.left)}{range.top + 1}{range.left !== range.right || range.top !== range.bottom ? `:${columnName(range.right)}${range.bottom + 1}` : ''}</span>
        <button type="button" title="加粗" onClick={() => updateSelectionStyle({ bold: !styles[cellKey(active.row, active.col)]?.bold })}><strong>B</strong></button>
        <button type="button" title="左对齐" onClick={() => updateSelectionStyle({ align: 'left' })}>左</button>
        <button type="button" title="居中" onClick={() => updateSelectionStyle({ align: 'center' })}>中</button>
        <button type="button" title="右对齐" onClick={() => updateSelectionStyle({ align: 'right' })}>右</button>
        <input type="color" title="文字颜色" value={styles[cellKey(active.row, active.col)]?.color || '#1f2329'} onChange={(event) => updateSelectionStyle({ color: event.target.value })} />
        <input type="color" title="填充颜色" value={styles[cellKey(active.row, active.col)]?.background || '#ffffff'} onChange={(event) => updateSelectionStyle({ background: event.target.value })} />
        <button type="button" title="缩小当前列" onClick={() => resizeColumn(-20)}>列−</button>
        <button type="button" title="加宽当前列" onClick={() => resizeColumn(20)}>列＋</button>
        <button type="button" onClick={addRow}>＋ 行</button>
        <button type="button" onClick={addColumn}>＋ 列</button>
        <button type="button" onClick={insertRow}>上方插行</button>
        <button type="button" onClick={insertColumn}>左侧插列</button>
        <button type="button" onClick={deleteRows}>删除行</button>
        <button type="button" onClick={deleteColumns}>删除列</button>
        <button type="button" title="按当前列升序" onClick={() => sortRows(1)}>升序</button>
        <button type="button" title="按当前列降序" onClick={() => sortRows(-1)}>降序</button>
        <button type="button" onClick={() => updateSheet({ frozenRows: sheet.frozenRows ? 0 : 1 })}>{sheet.frozenRows ? '取消冻结' : '冻结首行'}</button>
        <button type="button" onClick={findReplace}>替换</button>
      </div>
      <div className="moqi-formula-bar">
        <span>fx</span>
        <input value={grid[active.row]?.[active.col] || ''} onChange={(event) => updateCell(active.row, active.col, event.target.value)} placeholder="输入值或公式，例如 =SUM(A1:A10)" />
        <input className="moqi-sheet-filter" value={filterText} onChange={(event) => setFilterText(event.target.value)} placeholder="筛选当前列" />
      </div>
      <div
        className="moqi-sheet-scroll"
        ref={tableRef}
        tabIndex={0}
        onMouseLeave={() => { dragging.current = false }}
        onMouseUp={() => { dragging.current = false }}
      >
        <table>
          <thead><tr><th className="moqi-sheet-corner" />{grid[0].map((_, col) => <th key={col} style={{ width: widths[col] || 120, minWidth: widths[col] || 120 }} onClick={() => { setAnchor({ row: 0, col }); setActive({ row: grid.length - 1, col }) }}>{columnName(col)}</th>)}</tr></thead>
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
                    >
                      <input
                        data-cell={`${rowIndex}:${colIndex}`}
                        value={editing === cellKey(rowIndex, colIndex) ? value : formulaValue(value, grid)}
                        style={{ color: styles[cellKey(rowIndex, colIndex)]?.color, fontWeight: styles[cellKey(rowIndex, colIndex)]?.bold ? 700 : undefined, textAlign: styles[cellKey(rowIndex, colIndex)]?.align }}
                        onChange={(event) => updateCell(rowIndex, colIndex, event.target.value)}
                        onFocus={() => { setEditing(cellKey(rowIndex, colIndex)); if (!dragging.current) focusCell({ row: rowIndex, col: colIndex }) }}
                        onBlur={() => setEditing(null)}
                        onPaste={(event) => {
                          const text = event.clipboardData.getData('text/plain')
                          if (text.includes('\t') || text.includes('\n')) {
                            event.preventDefault()
                            pasteGrid(text)
                          }
                        }}
                        onKeyDown={(event) => {
                          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' && (range.top !== range.bottom || range.left !== range.right)) {
                            event.preventDefault()
                            void copyRange()
                            return
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
