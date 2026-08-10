import { useMemo, useRef, useState } from 'react'
import { createReactBlockSpec } from '@blocknote/react'
import './spreadsheetBlock.css'

type Cell = { row: number; col: number }
type Grid = string[][]

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

function SpreadsheetView({ block, editor }: any) {
  const grid = useMemo(() => normalizeGrid(parseGrid(block.props.data)), [block.props.data])
  const [anchor, setAnchor] = useState<Cell>({ row: 0, col: 0 })
  const [active, setActive] = useState<Cell>({ row: 0, col: 0 })
  const dragging = useRef(false)
  const tableRef = useRef<HTMLDivElement>(null)
  const range = bounds(anchor, active)

  const commit = (next: Grid) => {
    editor.updateBlock(block, { props: { data: JSON.stringify(next) } })
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
          value={block.props.name || 'Sheet1'}
          aria-label="工作表名称"
          onChange={(event) => editor.updateBlock(block, { props: { name: event.target.value } })}
        />
        <span className="moqi-sheet-range">{columnName(range.left)}{range.top + 1}{range.left !== range.right || range.top !== range.bottom ? `:${columnName(range.right)}${range.bottom + 1}` : ''}</span>
        <button type="button" onClick={addRow}>＋ 行</button>
        <button type="button" onClick={addColumn}>＋ 列</button>
        <button type="button" onClick={deleteRows}>删除行</button>
        <button type="button" onClick={deleteColumns}>删除列</button>
      </div>
      <div
        className="moqi-sheet-scroll"
        ref={tableRef}
        tabIndex={0}
        onMouseLeave={() => { dragging.current = false }}
        onMouseUp={() => { dragging.current = false }}
      >
        <table>
          <thead><tr><th className="moqi-sheet-corner" />{grid[0].map((_, col) => <th key={col}>{columnName(col)}</th>)}</tr></thead>
          <tbody>
            {grid.map((row, rowIndex) => (
              <tr key={rowIndex}>
                <th className="moqi-sheet-row-number">{rowIndex + 1}</th>
                {row.map((value, colIndex) => {
                  const selected = rowIndex >= range.top && rowIndex <= range.bottom && colIndex >= range.left && colIndex <= range.right
                  const current = rowIndex === active.row && colIndex === active.col
                  return (
                    <td
                      key={colIndex}
                      className={`${selected ? 'is-selected' : ''} ${current ? 'is-active' : ''}`}
                      onMouseDown={(event) => {
                        event.stopPropagation()
                        dragging.current = true
                        focusCell({ row: rowIndex, col: colIndex }, event.shiftKey)
                      }}
                      onMouseEnter={() => { if (dragging.current) setActive({ row: rowIndex, col: colIndex }) }}
                    >
                      <input
                        data-cell={`${rowIndex}:${colIndex}`}
                        value={value}
                        onChange={(event) => updateCell(rowIndex, colIndex, event.target.value)}
                        onFocus={() => { if (!dragging.current) focusCell({ row: rowIndex, col: colIndex }) }}
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
    </div>
  )
}

function SpreadsheetExternal({ block }: any) {
  const grid = parseGrid(block.props.data)
  return (
    <table>
      <caption>{block.props.name || 'Sheet1'}</caption>
      <tbody>{grid.map((row, index) => <tr key={index}>{row.map((cell, col) => <td key={col}>{cell}</td>)}</tr>)}</tbody>
    </table>
  )
}

export const spreadsheetBlock = createReactBlockSpec(
  {
    type: 'spreadsheet',
    propSchema: {
      name: { default: 'Sheet1' },
      data: { default: '[[""]]' }
    },
    content: 'none'
  },
  {
    render: SpreadsheetView,
    toExternalHTML: SpreadsheetExternal
  }
)
