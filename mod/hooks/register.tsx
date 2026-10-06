import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CanopyBranch, CanopySnapshot } from '../types'
import { buildSnapshot, NotARepo, projectDirName, type Git, type SessionProbe } from './git'
import { layoutGraph } from './lanes'
import { ago, laneColor, renderSvg, worktreeLabel } from './svg'
import { textGraph, type Cell } from './textgraph'

// canopy：session 所在 repo 有未推 commit 時，輸入框上方出現一列提示，
// 按「看線圖」開面板看整棵樹（所有 worktree 的分支、ahead/behind、髒污、session 活性）。
// 資料直接跑 git 取得，只讀不寫。

const PANE = 'canopy'
const DEFAULT_LIMIT = 80
const MAX_LIMIT = 400
const POLL_MS = 45_000
const BRANCH_ROWS = 10

const snapshot = atom({ plugin: 'canopy', key: 'snapshot' } as const, null)
const error = atom({ plugin: 'canopy', key: 'error' } as const, null)
const dismissed = atom({ plugin: 'canopy', key: 'dismissed' } as const, null)
const limit = atom({ plugin: 'canopy', key: 'limit' } as const, DEFAULT_LIMIT)

type $ = EngineInterface

// ── 重新整理 ────────────────────────────────────────────────

// 同時只跑一輪；跑的期間又有人要，就在跑完後再補一輪。
let running: Promise<void> | null = null
let isQueued = false

function refresh($: $): Promise<void> {
  if (running !== null) {
    isQueued = true
    return running
  }
  running = (async () => {
    do {
      isQueued = false
      await rebuild($)
    } while (isQueued)
  })().finally(() => {
    running = null
  })
  return running
}

/** 把重新整理排到目前這次 dispatch 之外，不拖住回合收尾或工具呼叫。 */
function refreshSoon($: $): void {
  $.clock.after(1, () => void refresh($))
}

async function rebuild($: $): Promise<void> {
  const git: Git = async (args, cwd) => {
    try {
      // GIT_OPTIONAL_LOCKS=0：status 不去搶 index.lock，避免卡到正在 commit 的 session
      const r = await $.process.run(['git', ...args], { cwd, env: { GIT_OPTIONAL_LOCKS: '0' }, timeoutMs: 20_000 })
      return r.exitCode === 0 ? r.stdout.replace(/\n+$/, '') : ''
    } catch {
      return ''
    }
  }
  const home = await $.env.get('HOME')
  const probe: SessionProbe = async path => {
    if (home === undefined) return null
    try {
      const entries = await $.fs.list(`${home}/.claude/projects/${projectDirName(path)}`)
      const times = entries.filter(f => f.kind === 'file' && f.name.endsWith('.jsonl')).map(f => f.mtimeMs)
      return times.length === 0 ? null : Math.max(...times)
    } catch {
      return null
    }
  }
  try {
    const snap = await buildSnapshot(git, await $.session.cwd(), await read($, limit), probe, await $.clock.now())
    await update($, snapshot, () => snap)
    await update($, error, () => null)
  } catch (err) {
    await update($, snapshot, () => null)
    await update($, error, () => (err instanceof NotARepo ? 'not-repo' : String(err)))
  }
}

// ── 提示列的判斷 ────────────────────────────────────────────

type Pending = { branch: CanopyBranch; others: number; signature: string }

/** session 所在分支有還沒推上 remote 的 commit 才提示。 */
export function pendingOf(snap: CanopySnapshot | null): Pending | null {
  if (snap === null || snap.noRemote) return null
  const branch = snap.branches.find(b => b.isCurrent)
  if (branch === undefined || branch.ahead === 0) return null
  const others = snap.branches.filter(b => !b.isCurrent && b.ahead > 0 && !b.merged).length
  return { branch, others, signature: `${snap.repoPath}\n${branch.name}\n${branch.sha}` }
}

async function openPane($: $): Promise<void> {
  const snap = await read($, snapshot)
  await $.ui.open({ id: PANE, title: snap === null ? 'git 線圖' : `git 線圖 · ${snap.repoName}`, columns: 120 })
  await refresh($)
}

// 面板上方的分支清單：本 session 的分支、有 worktree 的、有未推的、還沒合併的
function listedBranches(snap: CanopySnapshot): { shown: CanopyBranch[]; rest: number } {
  const rank = (b: CanopyBranch) => (b.isCurrent ? 0 : b.ahead > 0 ? 1 : b.worktree !== null ? 2 : 3)
  const candidates = snap.branches
    .filter(b => b.isCurrent || b.worktree !== null || b.ahead > 0 || !b.merged)
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
  const shown = candidates.slice(0, BRANCH_ROWS)
  return { shown, rest: snap.branches.length - shown.length }
}

function badges(b: CanopyBranch, snap: CanopySnapshot, nowMs: number): { text: string; color?: string; isDim?: boolean }[] {
  const out: { text: string; color?: string; isDim?: boolean }[] = []
  if (!snap.noRemote && b.ahead > 0) out.push({ text: `↑${b.ahead}`, color: 'warning' })
  if (b.behind > 0) out.push({ text: `↓${b.behind}`, isDim: true })
  const wt = b.worktree
  if (wt !== null && !wt.isMain) out.push({ text: worktreeLabel(b), isDim: true })
  if (wt?.session) out.push(wt.session.isLive ? { text: '● 進行中', color: 'success' } : { text: `○ ${ago(wt.session.lastActive, nowMs)}`, isDim: true })
  if (wt?.isDirty) out.push({ text: '✎ 未commit', color: 'warning' })
  if (b.noUpstream && !snap.noRemote) out.push({ text: '無upstream', isDim: true })
  if (b.gone) out.push({ text: 'upstream 已消失', isDim: true })
  if (b.ahead > 0 && b.behind > 0) out.push({ text: '⚠ 分岔', color: 'error' })
  if (b.merged && !b.isCurrent && !(wt?.isMain ?? false)) out.push({ text: '✓ 已合併', color: 'success' })
  return out
}

// 終端機的一列：同色的格子併成一段
function segments(cells: readonly Cell[]): { text: string; color: string | undefined }[] {
  const out: { text: string; color: string | undefined }[] = []
  for (const cell of cells) {
    const color = cell.lane < 0 ? undefined : laneColor(cell.lane)
    const last = out[out.length - 1]
    if (last !== undefined && last.color === color) last.text += cell.ch
    else out.push({ text: cell.ch, color })
  }
  return out
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'canopy', description: '開啟 git 線圖面板（session 所在 repo 的所有分支與 worktree）' })
    refreshSoon($)
    $.clock.every(POLL_MS, () => void refresh($))
    return next(e)
  })

  on('command.run', { command: 'canopy' }, async $ => {
    await openPane($)
    return { text: '已開啟 canopy 線圖面板。' }
  })

  // 回合結束、或模型剛跑過 git，就重抓一次
  on('turn.complete', ($, e, next) => {
    refreshSoon($)
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (/\bgit\b/.test(e.command)) refreshSoon($)
    return ran
  })

  // ── 輸入框上方的提示列 ──
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const pending = pendingOf(await read($, snapshot))
    if (pending === null || pending.signature === (await read($, dismissed))) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const { branch, others, signature } = pending
    const where = branch.upstream === null ? '不在任何 remote 上' : `還沒推到 ${branch.upstream}`
    return (
      <Box flexDirection="row" gap={1} alignItems="center">
        <Text color="warning" bold>
          ↑{branch.ahead}
        </Text>
        <Text wrap="truncate">
          <Text bold>{branch.name}</Text> 有 {branch.ahead} 個 commit {where}
          {others > 0 ? `（另有 ${others} 條分支也有未推）` : ''}
        </Text>
        <Button key="open" label="看線圖" variant="primary" onPress={() => openPane($)} />
        <Button key="dismiss" label="先不用" role="dismiss" onPress={() => update($, dismissed, () => signature)} />
      </Box>
    )
  })

  // ── 線圖面板 ──
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const snap = await read($, snapshot)
    const failure = await read($, error)
    const count = await read($, limit)
    const now = await $.clock.now()
    const { Box, Text, Button } = $.ui.resolve(e)

    const toolbar = (
      <Box flexDirection="row" gap={1}>
        <Button key="refresh" label="重新整理" hotkey="r" onPress={() => refresh($)} />
        <Button
          key="more"
          label={`更多 commit（目前 ${count}）`}
          hotkey="m"
          dimColor
          onPress={async () => {
            await update($, limit, n => Math.min(MAX_LIMIT, (n ?? DEFAULT_LIMIT) + DEFAULT_LIMIT))
            await refresh($)
          }}
        />
        <Button key="close" label="關閉" role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
      </Box>
    )

    if (snap === null) {
      const message =
        failure === 'not-repo' ? '這個 session 的工作目錄不在 git repo 裡。' : failure === null ? '讀取中…' : `讀取失敗：${failure}`
      return (
        <Box flexDirection="column" gap={1}>
          <Text dimColor>{message}</Text>
          {toolbar}
        </Box>
      )
    }

    const layout = layoutGraph(snap.commits, snap.headSha)
    const tipColor = new Map<string, string>()
    snap.commits.forEach((c, i) => tipColor.set(c.sha, laneColor(layout.lanes[i] as number)))
    const { shown, rest } = listedBranches(snap)

    // 每一行都是一段文字（內嵌上色的片段），窄的時候整段換行，不會被 flex 擠成好幾欄
    const home = await $.env.get('HOME')
    const path = home !== undefined && snap.repoPath.startsWith(`${home}/`) ? `~${snap.repoPath.slice(home.length)}` : snap.repoPath
    const header = (
      <Box flexDirection="column">
        <Text>
          <Text bold>{snap.repoName}</Text>
          <Text dimColor>
            {'  '}
            {path} · {ago(Math.floor(snap.builtAt / 1000), now)} 前更新
          </Text>
        </Text>
        {shown.map(b => (
          <Text>
            <Text color={tipColor.get(b.sha)} dimColor={!tipColor.has(b.sha)} bold={b.isCurrent}>
              {b.isCurrent ? '▸ ' : '  '}
              {b.name}
            </Text>
            {badges(b, snap, now).map(badge => (
              <Text color={badge.color} dimColor={badge.isDim}>
                {'  '}
                {badge.text}
              </Text>
            ))}
          </Text>
        ))}
        {rest > 0 && <Text dimColor>  …另有 {rest} 條分支沒列出（已合併、沒在動）</Text>}
      </Box>
    )

    if (e.surface === 'terminal') {
      const grid = textGraph(snap.commits, snap.headSha)
      const byTip = new Map<string, CanopyBranch[]>()
      for (const b of snap.branches) byTip.set(b.sha, [...(byTip.get(b.sha) ?? []), b])
      return (
        <Box flexDirection="column" gap={1}>
          {header}
          {toolbar}
          <Box flexDirection="column">
            {snap.commits.map((c, i) => (
              <Text wrap="truncate">
                {segments(grid[i] ?? []).map(seg => (
                  <Text color={seg.color}>{seg.text}</Text>
                ))}{' '}
                {(byTip.get(c.sha) ?? []).map(b => (
                  <Text color={tipColor.get(c.sha)} bold>
                    [{b.name}]{' '}
                  </Text>
                ))}
                <Text dimColor={c.parents.length > 1}>{c.subject}</Text>
                <Text dimColor>
                  {'  '}
                  {c.sha.slice(0, 7)} {ago(c.time, now)}
                </Text>
              </Text>
            ))}
          </Box>
        </Box>
      )
    }

    const { Svg } = $.ui.resolve(e)
    // 以圖片畫（不開 isInteractive）：iframe 不給高度就只有 150px，圖片則照原比例、寬不超過欄位
    const width = Math.max(360, Math.min(1600, Math.round(e.props.bodyColumns * 7.8)))
    const svg = renderSvg(snap, width, now)
    return (
      <Box flexDirection="column" gap={1}>
        {header}
        {toolbar}
        <Svg source={svg.source} alt={`${snap.repoName} 最近 ${svg.rows} 筆 commit 的線圖`} />
        {svg.rows < snap.commits.length && <Text dimColor>線圖只畫到第 {svg.rows} 筆（圖的大小有上限）。</Text>}
      </Box>
    )
  })
}
