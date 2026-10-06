import { layoutGraph } from './lanes'

// 終端機沒有 Svg，線圖改用框線字元逐列畫。每道 lane 佔兩格：
// 偶數格是那道本身（節點、直線、轉角），奇數格是往右一道之間的橫線。

export type Cell = { ch: string; lane: number }

const NODE = '●'
const MERGE = '○'

/** 回傳每一列的格子（長度 2 × lane 數），lane 為 -1 的是空白。 */
export function textGraph(commits: readonly { sha: string; parents: readonly string[] }[], headSha: string): Cell[][] {
  const layout = layoutGraph(commits, headSha)
  const width = (layout.maxLane + 1) * 2
  const grid: Cell[][] = commits.map(() => Array.from({ length: width }, () => ({ ch: ' ', lane: -1 })))

  const put = (row: number, pos: number, ch: string, lane: number) => {
    const cell = grid[row]?.[pos]
    if (cell === undefined) return
    if (cell.ch === NODE || cell.ch === MERGE) return
    cell.ch = merge(cell.ch, ch)
    if (cell.lane < 0 || ch !== '─') cell.lane = lane
  }
  const vertical = (lane: number, from: number, to: number) => {
    for (let r = from; r <= to; r++) put(r, lane * 2, '│', lane)
  }
  // 在 row 這一列從 lane a 橫到 lane b，b 那格放轉角
  const turn = (row: number, a: number, b: number, corner: string, lane: number) => {
    const [lo, hi] = a < b ? [a, b] : [b, a]
    for (let p = lo * 2 + 1; p < hi * 2; p++) put(row, p, '─', lane)
    put(row, b * 2, corner, lane)
  }

  for (const e of layout.edges) {
    if (e.via === e.fromLane) {
      // 沿子節點那道往下，到父節點那列轉進去
      vertical(e.via, e.fromRow + 1, e.toRow - 1)
      if (e.via !== e.toLane) turn(e.toRow, e.toLane, e.via, e.via > e.toLane ? '╯' : '╰', e.via)
    } else {
      // 合併點那列橫出去轉下，沿自己那道往下
      turn(e.fromRow, e.fromLane, e.via, e.via > e.fromLane ? '╮' : '╭', e.via)
      vertical(e.via, e.fromRow + 1, e.toRow - 1)
      if (e.via !== e.toLane) turn(e.toRow, e.toLane, e.via, e.via > e.toLane ? '╯' : '╰', e.via)
    }
  }
  for (const s of layout.stubs) {
    const below = s.row + 1
    if (below < grid.length) put(below, s.lane * 2, '┊', s.lane)
  }
  commits.forEach((c, i) => {
    const lane = layout.lanes[i] as number
    const cell = grid[i]?.[lane * 2]
    if (cell !== undefined) {
      cell.ch = c.parents.length > 1 ? MERGE : NODE
      cell.lane = lane
    }
  })
  return grid
}

// 框線字元＝它伸出去的方向（上下左右）；兩個疊在同一格就取方向的聯集
const GLYPH: Record<string, string> = {
  ud: '│',
  lr: '─',
  dl: '╮',
  dr: '╭',
  ul: '╯',
  ur: '╰',
  udl: '┤',
  udr: '├',
  ulr: '┴',
  dlr: '┬',
  udlr: '┼',
}
const DIRS = new Map(Object.entries(GLYPH).map(([dirs, ch]) => [ch, dirs]))

export function merge(had: string, add: string): string {
  const a = DIRS.get(had)
  const b = DIRS.get(add)
  if (a === undefined || b === undefined) return add
  const key = [...'udlr'].filter(d => a.includes(d) || b.includes(d)).join('')
  return GLYPH[key] ?? add
}
