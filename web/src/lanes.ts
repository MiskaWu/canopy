import type { Commit } from './types'

// lane 指派：git log 已是 topo order（新在上）。
// 每個 lane 記著「接下來在等哪個 SHA」；輪到某個 commit 時，
// 所有在等它的 lane 匯流成最左邊那條，沒人等它就開新 lane（分支 tip）。
// headSha 預先佔住 lane 0，讓 HEAD 所在的鏈固定畫在最左。

export interface Edge {
  fromRow: number
  fromLane: number
  toRow: number
  toLane: number
}

export interface Layout {
  lanes: number[] // 每個 commit 的 lane
  edges: Edge[]
  stubs: { row: number; lane: number }[] // 父節點被截斷在 log 範圍外的殘邊
  maxLane: number
}

export function layoutGraph(commits: Commit[], headSha: string): Layout {
  const idx = new Map<string, number>()
  commits.forEach((c, i) => idx.set(c.sha, i))

  const laneWait: (string | null)[] = [headSha || null]
  const lanes: number[] = []
  let maxLane = 0

  const firstFree = () => {
    const i = laneWait.indexOf(null)
    if (i >= 0) return i
    laneWait.push(null)
    return laneWait.length - 1
  }

  for (let i = 0; i < commits.length; i++) {
    const c = commits[i]
    const waiting: number[] = []
    laneWait.forEach((s, l) => {
      if (s === c.sha) waiting.push(l)
    })
    let lane: number
    if (waiting.length > 0) {
      lane = Math.min(...waiting)
      for (const l of waiting) if (l !== lane) laneWait[l] = null
    } else {
      lane = firstFree()
    }
    lanes[i] = lane
    maxLane = Math.max(maxLane, lane)

    const parents = c.parents ?? []
    laneWait[lane] = parents[0] ?? null
    for (let pi = 1; pi < parents.length; pi++) {
      if (!laneWait.includes(parents[pi])) laneWait[firstFree()] = parents[pi]
    }
  }

  // 邊：子 → 每個父。父不在範圍內就畫殘邊示意截斷。
  const edges: Edge[] = []
  const stubs: { row: number; lane: number }[] = []
  commits.forEach((c, i) => {
    for (const p of c.parents ?? []) {
      const j = idx.get(p)
      if (j === undefined) {
        stubs.push({ row: i, lane: lanes[i] })
      } else {
        edges.push({ fromRow: i, fromLane: lanes[i], toRow: j, toLane: lanes[j] })
      }
    }
  })

  return { lanes, edges, stubs, maxLane }
}
