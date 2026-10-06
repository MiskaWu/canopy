import type { CanopyBranch, CanopySnapshot } from '../types'
import { layoutGraph, type Layout } from './lanes'

// 桌面版（與其他遠端介面）的線圖：整張畫成一份 SVG。
// 文字也放進 SVG 裡，因為介面上的列高量不到，分開畫對不齊。
// 視覺沿用 server/mockup.html 的定稿：深色底、lane 色票、分支色塊、線不被切斷。

export const LANE_COLORS = ['#6cb0f0', '#58c98b', '#e0a84f', '#d585d0', '#55c6c0', '#9a8cf0']
export const SVG_LIMIT = 131072 // Svg 元素 source 的上限（字元）

const RH = 28
const X0 = 14
const XW = 14
const TOP = 8
const SANS = `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang TC', Inter, 'Noto Sans TC', sans-serif`
const MONO = `'JetBrains Mono', ui-monospace, 'Cascadia Mono', Consolas, monospace`

export function laneColor(lane: number): string {
  return LANE_COLORS[lane % LANE_COLORS.length] as string
}

export function ago(unixSeconds: number, nowMs: number): string {
  const s = Math.max(1, Math.floor(nowMs / 1000 - unixSeconds))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

/** 畫出線圖；超過 Svg 上限就少畫幾列。回傳 SVG 與實際畫了幾列。 */
export function renderSvg(snap: CanopySnapshot, width: number, nowMs: number): { source: string; rows: number } {
  let rows = snap.commits.length
  for (;;) {
    const source = draw(snap, rows, width, nowMs)
    if (source.length <= SVG_LIMIT || rows <= 1) return { source, rows }
    rows = Math.max(1, Math.floor((rows * SVG_LIMIT * 0.95) / source.length))
  }
}

function draw(snap: CanopySnapshot, rowCount: number, W: number, nowMs: number): string {
  const commits = snap.commits.slice(0, rowCount)
  const layout = layoutGraph(commits, snap.headSha)
  const byTip = new Map<string, CanopyBranch[]>()
  for (const b of snap.branches) byTip.set(b.sha, [...(byTip.get(b.sha) ?? []), b])

  const H = TOP * 2 + commits.length * RH
  const gw = X0 + layout.maxLane * XW + 14
  const cx = (lane: number) => X0 + lane * XW
  const cy = (row: number) => TOP + row * RH + RH / 2

  const out: string[] = []
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `<style>`,
    `text{font-family:${SANS};font-size:12.5px;fill:#d9dfe7;dominant-baseline:central}`,
    `.m{font-family:${MONO};font-size:11px}.b{font-weight:600}.f{fill:#66707d}.d{fill:#8b95a3}`,
    `.r .h{fill:transparent}.r:hover .h{fill:#1b222b}`,
    `.e{fill:none;stroke-width:2}`,
    `</style>`,
    `<rect width="${W}" height="${H}" rx="10" fill="#151a20"/>`,
  )

  // 列：hover 底色、分隔線、tooltip、文字。先畫，線圖疊在上面不被切斷。
  commits.forEach((c, i) => {
    const y = cy(i)
    const top = TOP + i * RH
    const lane = layout.lanes[i] as number
    const col = laneColor(lane)
    const tx = gw + 10
    const tips = byTip.get(c.sha) ?? []
    const local = new Set(tips.map(b => b.name))
    const remoteRefs = c.refs.filter(r => !local.has(r) && !r.endsWith('/HEAD'))
    const isMerge = c.parents.length > 1
    const tip = `${c.sha.slice(0, 10)} · ${c.author} · ${ago(c.time, nowMs)} 前\n${c.subject}`

    out.push(`<g class="r"><title>${esc(tip)}</title><rect class="h" x="0" y="${top}" width="${W}" height="${RH}"/>`)
    if (i > 0) out.push(`<line x1="${tx - 4}" y1="${top}" x2="${W - 8}" y2="${top}" stroke="#1d242c"/>`)

    let x = tx
    const right = W - 120
    const chips: Chip[] = []
    for (const b of tips) chips.push(...branchChips(b, col, snap.noRemote, nowMs))
    for (const r of remoteRefs) chips.push({ text: r, fg: '#8b95a3', bg: 'none', border: '#2a323c', mono: true })
    let hidden = 0
    for (const chip of chips) {
      const w = textWidth(chip.text, chip.mono ? 6.8 : 7.2) + 14
      if (x + w > right - 60) {
        hidden++
        continue
      }
      out.push(
        `<rect x="${x}" y="${y - 9}" width="${w}" height="18" rx="5" fill="${chip.bg}" stroke="${chip.border}"/>`,
        `<text x="${x + 7}" y="${y}" class="${chip.mono ? 'm b' : ''}" style="fill:${chip.fg}">${esc(chip.text)}</text>`,
      )
      x += w + 6
    }
    if (hidden > 0) {
      out.push(`<text x="${x}" y="${y}" class="m f">+${hidden}</text>`)
      x += 28
    }
    const room = Math.max(0, right - x - 8)
    out.push(`<text x="${x}" y="${y}"${isMerge ? ' class="d"' : ''}>${esc(clip(c.subject, room, 7.2))}</text>`)
    out.push(`<text x="${W - 58}" y="${y}" class="m f" text-anchor="end">${c.sha.slice(0, 7)}</text>`)
    out.push(`<text x="${W - 14}" y="${y}" class="m f" text-anchor="end">${ago(c.time, nowMs)}</text>`)
    out.push(`</g>`)
  })

  // 線圖：邊、殘邊、節點
  out.push(`<g pointer-events="none">`)
  for (const e of layout.edges) out.push(edgePath(e, cx, cy))
  for (const s of layout.stubs) {
    const x = cx(s.lane)
    const y = cy(s.row)
    out.push(`<line x1="${x}" y1="${y}" x2="${x}" y2="${y + 14}" stroke="${laneColor(s.lane)}" stroke-width="2" opacity=".35" stroke-dasharray="2 3"/>`)
  }
  commits.forEach((c, i) => {
    const lane = layout.lanes[i] as number
    const col = laneColor(lane)
    const x = cx(lane)
    const y = cy(i)
    if (c.sha === snap.headSha) out.push(`<circle cx="${x}" cy="${y}" r="7.5" fill="none" stroke="${col}" stroke-width="1.5" opacity=".6"/>`)
    const isMerge = c.parents.length > 1
    out.push(`<circle cx="${x}" cy="${y}" r="${isMerge ? 3 : 4}" fill="${isMerge ? '#151a20' : col}" stroke="${col}" stroke-width="2"/>`)
  })
  out.push(`</g></svg>`)
  return out.join('')
}

type Chip = { text: string; fg: string; bg: string; border: string; mono: boolean }

function branchChips(b: CanopyBranch, col: string, noRemote: boolean, nowMs: number): Chip[] {
  const chips: Chip[] = [{ text: b.isCurrent ? `${b.name} · HEAD` : b.name, fg: col, bg: `${col}1f`, border: `${col}66`, mono: true }]
  const badge = (text: string, fg: string, bg: string, mono = false): Chip => ({ text, fg, bg, border: 'none', mono })
  if (!noRemote && b.ahead > 0) chips.push(badge(`↑${b.ahead}`, '#8ec2f5', '#18293b', true))
  const wt = b.worktree
  if (wt !== null && !wt.isMain) chips.push(badge(`⌂ ${wt.name}`, '#8b95a3', '#1e252d'))
  if (wt?.session) chips.push(wt.session.isLive ? badge('● 進行中', '#84d8a5', '#16301f') : badge(`○ ${ago(wt.session.lastActive, nowMs)}`, '#8b95a3', '#1e252d', true))
  if (wt?.isDirty) chips.push(badge('✎ 未commit', '#f0c98a', '#332a18'))
  if (b.noUpstream && !noRemote) chips.push(badge('無upstream', '#8ec2f5', '#18293b'))
  if (b.gone) chips.push(badge('upstream 已消失', '#8b95a3', '#20262e'))
  if (b.ahead > 0 && b.behind > 0) chips.push(badge(`⚠ ↑${b.ahead}↓${b.behind}`, '#f0a0a0', '#361f1f', true))
  if (b.merged && !b.isCurrent && !(wt?.isMain ?? false)) chips.push(badge('✓ 已合併', '#84d8a5', '#16301f'))
  return chips
}

function edgePath(e: Layout['edges'][number], cx: (lane: number) => number, cy: (row: number) => number): string {
  const col = laneColor(e.via)
  const bend = (r1: number, l1: number, r2: number, l2: number) => {
    const x1 = cx(l1)
    const y1 = cy(r1)
    const x2 = cx(l2)
    const y2 = cy(r2)
    return x1 === x2 ? `M${x1} ${y1}L${x2} ${y2}` : `M${x1} ${y1}C${x1} ${y1 + RH * 0.65} ${x2} ${y2 - RH * 0.65} ${x2} ${y2}`
  }
  let d: string
  if (e.toRow - e.fromRow === 1) {
    d = bend(e.fromRow, e.fromLane, e.toRow, e.toLane)
  } else if (e.via === e.fromLane) {
    // 沿子節點那道往下，到父節點前一列才彎
    d = `M${cx(e.via)} ${cy(e.fromRow)}L${cx(e.via)} ${cy(e.toRow - 1)}` + bend(e.toRow - 1, e.via, e.toRow, e.toLane).replace(/^M[^LC]+/, '')
  } else {
    // 合併點立刻彎進自己那道，沿著往下
    d =
      bend(e.fromRow, e.fromLane, e.fromRow + 1, e.via) +
      `L${cx(e.via)} ${cy(e.toRow - 1)}` +
      bend(e.toRow - 1, e.via, e.toRow, e.toLane).replace(/^M[^LC]+/, '')
  }
  return `<path class="e" stroke="${col}" d="${d}"/>`
}

/** 粗估文字寬度（px）：ASCII 一格，CJK 與全形約兩格。 */
export function textWidth(text: string, ascii: number): number {
  let w = 0
  for (const ch of text) w += (ch.codePointAt(0) ?? 0) > 0x2e80 ? ascii * 1.75 : ascii
  return Math.ceil(w)
}

function clip(text: string, room: number, ascii: number): string {
  if (textWidth(text, ascii) <= room) return text
  let out = ''
  for (const ch of text) {
    if (textWidth(out + ch + '…', ascii) > room) break
    out += ch
  }
  return out === '' ? '' : `${out}…`
}

function esc(text: string): string {
  return text.replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`)
}
