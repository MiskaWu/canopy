// lane 指派：沿用伺服器版前端的演算法（topo order、新在上；每個 lane 記著
// 「接下來在等哪個 SHA」；headSha 預先佔住 lane 0，HEAD 所在的鏈固定在最左）。
//
// 多記一件事：每條邊實際走哪一道（via）。第一父邊沿子節點那道往下、到父節點才彎；
// 其餘父邊從合併點立刻彎進它被分到的那道再往下。文字線圖逐列畫格子，
// 不知道 via 就畫不出中間那段直線。

export type Edge = {
  fromRow: number
  fromLane: number
  toRow: number
  toLane: number
  via: number
}

export type Layout = {
  lanes: number[]
  edges: Edge[]
  stubs: { row: number; lane: number }[] // 父節點在範圍外的殘邊
  maxLane: number
}

export function layoutGraph(commits: readonly { sha: string; parents: readonly string[] }[], headSha: string): Layout {
  const index = new Map<string, number>()
  commits.forEach((c, i) => index.set(c.sha, i))

  const laneWait: (string | null)[] = [headSha === '' ? null : headSha]
  const lanes: number[] = []
  const vias: number[][] = [] // vias[row][parentIndex]
  let maxLane = 0

  const firstFree = () => {
    const i = laneWait.indexOf(null)
    if (i >= 0) return i
    laneWait.push(null)
    return laneWait.length - 1
  }

  commits.forEach((c, i) => {
    const waiting: number[] = []
    laneWait.forEach((sha, l) => {
      if (sha === c.sha) waiting.push(l)
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

    const via: number[] = []
    laneWait[lane] = c.parents[0] ?? null
    via.push(lane)
    for (let p = 1; p < c.parents.length; p++) {
      const parent = c.parents[p] as string
      let l = laneWait.indexOf(parent)
      if (l < 0) {
        l = firstFree()
        laneWait[l] = parent
      }
      maxLane = Math.max(maxLane, l)
      via.push(l)
    }
    vias[i] = via
  })

  const edges: Edge[] = []
  const stubs: { row: number; lane: number }[] = []
  commits.forEach((c, i) => {
    const fromLane = lanes[i] as number
    c.parents.forEach((parent, p) => {
      const j = index.get(parent)
      if (j === undefined) {
        stubs.push({ row: i, lane: vias[i]?.[p] ?? fromLane })
      } else {
        edges.push({ fromRow: i, fromLane, toRow: j, toLane: lanes[j] as number, via: vias[i]?.[p] ?? fromLane })
      }
    })
  })

  return { lanes, edges, stubs, maxLane }
}
