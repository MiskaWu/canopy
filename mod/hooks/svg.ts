import type { CanopyBranch, CanopySnapshot } from '../types'
import { branchBadges, ago, type BadgeKind } from './badges'
import type { GraphTheme } from './config'
import type { Strings } from './i18n'
import { layoutGraph, type Layout } from './lanes'

// 桌面版（與其他遠端介面）的線圖：整張畫成一份 SVG，以圖片顯示。
// 文字也放進 SVG 裡，因為介面上的列高量不到，分開畫對不齊。
// 視覺沿用伺服器版 2026-08-26 拍板的定稿：lane 色票、分支色塊、線不被列分隔線切斷。
//
// 兩件事靠圖片本身做到，不必知道介面的實際尺寸與主題：
// - 根元素只給 viewBox、不給 width／height，圖片就撐滿欄寬（Chromium 實測）。
//   viewBox 的寬度照欄數估，估偏了只是字稍大稍小，不會留白或溢出。
// - 顏色全走 CSS 變數；auto 主題用 prefers-color-scheme 切換，圖片模式下它跟著
//   頁面的深淺色走（Chromium 實測）。

export const SVG_LIMIT = 131072 // Svg 元素 source 的上限（字元）

const RH = 28
const X0 = 14
const XW = 14
const TOP = 8
const SANS = `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang TC', Inter, 'Noto Sans TC', sans-serif`
const MONO = `'JetBrains Mono', ui-monospace, 'Cascadia Mono', Consolas, monospace`

type Palette = {
  lanes: readonly string[]
  bg: string
  fg: string
  muted: string
  faint: string
  sep: string
  outline: string
  badges: Record<BadgeKind, readonly [fg: string, bg: string]>
}

const DARK: Palette = {
  lanes: ['#6cb0f0', '#58c98b', '#e0a84f', '#d585d0', '#55c6c0', '#9a8cf0'],
  bg: '#151a20',
  fg: '#d9dfe7',
  muted: '#8b95a3',
  faint: '#66707d',
  sep: '#1d242c',
  outline: '#2a323c',
  badges: {
    push: ['#8ec2f5', '#18293b'],
    info: ['#8ec2f5', '#18293b'],
    dirty: ['#f0c98a', '#332a18'],
    diverged: ['#f0a0a0', '#361f1f'],
    ok: ['#84d8a5', '#16301f'],
    mute: ['#8b95a3', '#1e252d'],
  },
}

const LIGHT: Palette = {
  lanes: ['#1f6fc5', '#1f8a4c', '#a86a00', '#a3449e', '#11807a', '#5b4bd1'],
  bg: '#f6f8fa',
  fg: '#1f2328',
  muted: '#59636e',
  faint: '#818b98',
  sep: '#e6eaef',
  outline: '#d0d7de',
  badges: {
    push: ['#0b5cad', '#ddeeff'],
    info: ['#0b5cad', '#ddeeff'],
    dirty: ['#8a5a00', '#fff1d6'],
    diverged: ['#b42318', '#ffe4e0'],
    ok: ['#1a7f37', '#dcf5e3'],
    mute: ['#59636e', '#eaeef2'],
  },
}

/** 介面上的 Text（分支清單、終端機線圖）用的 lane 色：深淺底都讀得清楚的中間色。 */
const TEXT_LANES = ['#4a9ae8', '#3fae6e', '#c98a1b', '#bf63bb', '#2fa39c', '#7d6ee8']

export function laneColor(lane: number): string {
  return TEXT_LANES[lane % TEXT_LANES.length] as string
}

const LANE_COUNT = DARK.lanes.length
const KINDS = Object.keys(DARK.badges) as BadgeKind[]

function vars(p: Palette): string {
  const lanes = p.lanes.map((c, i) => `--l${i}:${c}`).join(';')
  const badges = KINDS.map(k => `--${k}-fg:${p.badges[k][0]};--${k}-bg:${p.badges[k][1]}`).join(';')
  return `svg{--bg:${p.bg};--fg:${p.fg};--muted:${p.muted};--faint:${p.faint};--sep:${p.sep};--outline:${p.outline};${lanes};${badges}}`
}

function stylesheet(theme: GraphTheme): string {
  const palette =
    theme === 'dark' ? vars(DARK) : theme === 'light' ? vars(LIGHT) : `${vars(DARK)}@media (prefers-color-scheme: light){${vars(LIGHT)}}`
  const lanes = Array.from({ length: LANE_COUNT }, (_, i) =>
    [`.s${i}{stroke:var(--l${i})}`, `.n${i}{fill:var(--l${i});stroke:var(--l${i})}`, `.k${i} rect{fill:var(--l${i});fill-opacity:.13;stroke:var(--l${i});stroke-opacity:.45}.k${i} text{fill:var(--l${i})}`].join(''),
  ).join('')
  const badges = KINDS.map(k => `.b-${k} rect{fill:var(--${k}-bg)}.b-${k} text{fill:var(--${k}-fg)}`).join('')
  return [
    palette,
    `text{font-family:${SANS};font-size:12.5px;fill:var(--fg);dominant-baseline:central}`,
    `.m{font-family:${MONO};font-size:11px}.b{font-weight:600}.f{fill:var(--faint)}.d{fill:var(--muted)}`,
    `.bg{fill:var(--bg)}.sep{stroke:var(--sep)}.e{fill:none;stroke-width:2}.hollow{fill:var(--bg)}`,
    `.rk rect{fill:none;stroke:var(--outline)}.rk text{fill:var(--muted)}`,
    lanes,
    badges,
  ].join('')
}

export type SvgOptions = { width: number; nowMs: number; theme: GraphTheme; t: Strings }

/** 畫出線圖；超過 Svg 上限就少畫幾列。回傳 SVG 與實際畫了幾列。 */
export function renderSvg(snap: CanopySnapshot, opts: SvgOptions): { source: string; rows: number } {
  let rows = snap.commits.length
  for (;;) {
    const source = draw(snap, rows, opts)
    if (source.length <= SVG_LIMIT || rows <= 1) return { source, rows }
    rows = Math.max(1, Math.floor((rows * SVG_LIMIT * 0.95) / source.length))
  }
}

type Chip = { text: string; cls: string; isMono: boolean }

function draw(snap: CanopySnapshot, rowCount: number, { width: W, nowMs, theme, t }: SvgOptions): string {
  const commits = snap.commits.slice(0, rowCount)
  const layout = layoutGraph(commits, snap.headSha)
  const byTip = new Map<string, CanopyBranch[]>()
  for (const b of snap.branches) byTip.set(b.sha, [...(byTip.get(b.sha) ?? []), b])

  const H = TOP * 2 + commits.length * RH
  const gw = X0 + layout.maxLane * XW + 14
  const cx = (lane: number) => X0 + lane * XW
  const cy = (row: number) => TOP + row * RH + RH / 2
  const ln = (lane: number) => lane % LANE_COUNT

  const out: string[] = []
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">`,
    `<style>${stylesheet(theme)}</style>`,
    `<rect class="bg" width="${W}" height="${H}" rx="10"/>`,
  )

  // 列：分隔線與文字。先畫，線圖疊在上面不被切斷。
  commits.forEach((c, i) => {
    const y = cy(i)
    const top = TOP + i * RH
    const lane = ln(layout.lanes[i] as number)
    const tx = gw + 10
    const tips = byTip.get(c.sha) ?? []
    const local = new Set(tips.map(b => b.name))
    const remoteRefs = c.refs.filter(r => !local.has(r) && !r.endsWith('/HEAD'))
    const isMerge = c.parents.length > 1

    if (i > 0) out.push(`<line class="sep" x1="${tx - 4}" y1="${top}" x2="${W - 8}" y2="${top}"/>`)

    let x = tx
    const right = W - 120
    const chips: Chip[] = []
    for (const b of tips) {
      chips.push({ text: b.isCurrent ? `${b.name} · ${t.head}` : b.name, cls: `k${lane}`, isMono: true })
      for (const badge of branchBadges(b, snap, t, nowMs)) chips.push({ text: badge.text, cls: `b-${badge.kind}`, isMono: badge.isMono === true })
    }
    for (const r of remoteRefs) chips.push({ text: r, cls: 'rk', isMono: true })
    let hidden = 0
    for (const chip of chips) {
      const w = textWidth(chip.text, chip.isMono ? 6.8 : 7.2) + 14
      if (x + w > right - 60) {
        hidden++
        continue
      }
      out.push(
        `<g class="${chip.cls}"><rect x="${x}" y="${y - 9}" width="${w}" height="18" rx="5"/>`,
        `<text x="${x + 7}" y="${y}"${chip.isMono ? ' class="m b"' : ''}>${esc(chip.text)}</text></g>`,
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
  })

  // 線圖：邊、殘邊、節點
  out.push(`<g pointer-events="none">`)
  for (const e of layout.edges) out.push(edgePath(e, cx, cy, ln))
  for (const s of layout.stubs) {
    const x = cx(s.lane)
    const y = cy(s.row)
    out.push(`<line class="s${ln(s.lane)}" x1="${x}" y1="${y}" x2="${x}" y2="${y + 14}" stroke-width="2" opacity=".35" stroke-dasharray="2 3"/>`)
  }
  commits.forEach((c, i) => {
    const lane = layout.lanes[i] as number
    const x = cx(lane)
    const y = cy(i)
    if (c.sha === snap.headSha) {
      out.push(`<circle class="s${ln(lane)}" cx="${x}" cy="${y}" r="7.5" fill="none" stroke-width="1.5" opacity=".6"/>`)
    }
    const isMerge = c.parents.length > 1
    out.push(
      isMerge
        ? `<circle class="hollow s${ln(lane)}" cx="${x}" cy="${y}" r="3" stroke-width="2"/>`
        : `<circle class="n${ln(lane)}" cx="${x}" cy="${y}" r="4" stroke-width="2"/>`,
    )
  })
  out.push(`</g></svg>`)
  return out.join('')
}

function edgePath(e: Layout['edges'][number], cx: (lane: number) => number, cy: (row: number) => number, ln: (lane: number) => number): string {
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
  return `<path class="e s${ln(e.via)}" d="${d}"/>`
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
