import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CanopyBranch, CanopySnapshot } from '../types'
import { ago, branchBadges, type BadgeKind } from './badges'
import {
  COMMIT_CHOICES,
  MAX_COMMITS,
  parseBranchList,
  readConfig,
  REFRESH_CHOICES,
  THEMES,
  withCurrent,
  WORKTREE_PUSH,
  type Config,
  type ConfigField,
  type GraphTheme,
} from './config'
import { buildSnapshot, NotARepo, projectDirName, type Git, type SessionProbe } from './git'
import { LANGUAGES, strings, type Strings } from './i18n'
import { layoutGraph } from './lanes'
import { isPolicyReason, planPush, pushCandidates, tidyOutput } from './push'
import { laneColor, renderSvg } from './svg'
import { textGraph, type Cell } from './textgraph'

// canopy：session 所在 repo 有未推 commit 時，輸入框上方出現一列提示，
// 按「看線圖」開面板看整棵樹（所有 worktree 的分支、ahead/behind、髒污、session 活性）。
// 資料直接跑 git 取得，只讀不寫。設定在面板的設定區與 /config 都改得到（同一份 userConfig）。

const PANE = 'canopy'
const BRANCH_ROWS = 10

const snapshot = atom({ plugin: 'canopy', key: 'snapshot' } as const, null)
const error = atom({ plugin: 'canopy', key: 'error' } as const, null)
const dismissed = atom({ plugin: 'canopy', key: 'dismissed' } as const, null)
const extra = atom({ plugin: 'canopy', key: 'extra' } as const, 0)
const isSettingsOpen = atom({ plugin: 'canopy', key: 'isSettingsOpen' } as const, false)
const settingsError = atom({ plugin: 'canopy', key: 'settingsError' } as const, null)
const pushIntent = atom({ plugin: 'canopy', key: 'pushIntent' } as const, null)
const isPushing = atom({ plugin: 'canopy', key: 'isPushing' } as const, false)
const pushResult = atom({ plugin: 'canopy', key: 'pushResult' } as const, null)

type $ = EngineInterface

// ── 重新整理 ────────────────────────────────────────────────

// 同時只跑一輪；跑的期間又有人要，就在跑完後再補一輪。
let running: Promise<void> | null = null
let isQueued = false

function refresh($: $, cfg: Config): Promise<void> {
  if (running !== null) {
    isQueued = true
    return running
  }
  running = (async () => {
    do {
      isQueued = false
      await rebuild($, cfg)
    } while (isQueued)
  })().finally(() => {
    running = null
  })
  return running
}

/** 把重新整理排到目前這次 dispatch 之外，不拖住回合收尾或工具呼叫。 */
function refreshSoon($: $, cfg: Config): void {
  $.clock.after(1, () => void refresh($, cfg))
}

function commitLimit(cfg: Config, presses: number): number {
  return Math.min(MAX_COMMITS, cfg.commits * (1 + presses))
}

async function homeDir($: $): Promise<string | undefined> {
  return (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
}

/** 唯讀的 git：失敗一律回 ''。GIT_OPTIONAL_LOCKS=0 讓 status 不去搶 index.lock，不卡到正在 commit 的 session。 */
function readGit($: $): Git {
  return async (args, cwd) => {
    try {
      const r = await $.process.run(['git', ...args], { cwd, env: { GIT_OPTIONAL_LOCKS: '0' }, timeoutMs: 20_000 })
      return r.exitCode === 0 ? r.stdout.replace(/\n+$/, '') : ''
    } catch {
      return ''
    }
  }
}

async function rebuild($: $, cfg: Config): Promise<void> {
  const git = readGit($)
  // session 活性讀的是 Claude Code 自己的 session 記錄資料夾：盡力而為，讀不到就不顯示
  const home = await homeDir($)
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
    const limit = commitLimit(cfg, await read($, extra))
    const exists = async (path: string) => {
      try {
        return await $.fs.exists(path)
      } catch {
        return false
      }
    }
    const snap = await buildSnapshot({ git, probe, exists }, await $.session.cwd(), limit, await $.clock.now())
    await update($, snapshot, () => snap)
    await update($, error, () => null)
  } catch (err) {
    await update($, snapshot, () => null)
    await update($, error, () => (err instanceof NotARepo ? 'not-repo' : String(err)))
  }
}

// ── 推送（只從面板的按鈕進來）──────────────────────────────

/** 按下 ↑N：照目前快照組好計畫、抓要推的 commit，放進確認區。還不會推。 */
async function startPush($: $, cfg: Config, branch: string): Promise<void> {
  const snap = await read($, snapshot)
  const check = snap === null ? null : planPush(snap, branch, cfg)
  if (snap === null || check === null || !check.isAllowed) return
  const { plan } = check
  const git = readGit($)
  const [listed, count] = await Promise.all([
    git(['log', '--format=%h\x1f%s', '-n', '10', ...plan.range], snap.repoPath),
    git(['rev-list', '--count', ...plan.range], snap.repoPath),
  ])
  const commits = listed
    .split('\n')
    .filter(line => line !== '')
    .map(line => {
      const [sha = '', ...subject] = line.split('\x1f')
      return { sha, subject: subject.join('\x1f') }
    })
  await update($, pushResult, () => null)
  await update($, pushIntent, () => ({
    branch: plan.branch,
    remote: plan.remote,
    args: plan.args,
    commits,
    total: Number(count) || commits.length,
    isProtected: plan.isProtected,
    isArmed: false,
  }))
}

/**
 * 確認推送。先用最新的快照重組一次計畫：被擋了就說原因；指令和畫面上顯示的不同
 * （例如 upstream 剛設好，不再需要 -u）就換成新的、等再按一次——跑的永遠是看過的那條。
 * 受保護分支要按兩次。
 */
async function confirmPush($: $, cfg: Config, t: Strings): Promise<void> {
  const intent = await read($, pushIntent)
  const snap = await read($, snapshot)
  if (intent === null || snap === null || (await read($, isPushing))) return
  const check = planPush(snap, intent.branch, cfg)
  if (check === null || !check.isAllowed) {
    // 被政策擋下就說原因；推送關掉了、沒東西可推（別處已經推了）就只是收起確認區
    const reason = check?.reason
    await update($, pushIntent, () => null)
    if (isPolicyReason(reason)) await update($, pushResult, () => ({ branch: intent.branch, remote: intent.remote, isOk: false, output: t.blocked[reason] }))
    return
  }
  const { plan } = check
  if (plan.args.join(' ') !== intent.args.join(' ')) {
    await update($, pushIntent, () => ({ ...intent, remote: plan.remote, args: plan.args, isProtected: plan.isProtected, isArmed: false }))
    return
  }
  if (plan.isProtected && !intent.isArmed) {
    await update($, pushIntent, () => ({ ...intent, isArmed: true }))
    return
  }

  await update($, isPushing, () => true)
  let result: { isOk: boolean; output: string }
  try {
    // GIT_TERMINAL_PROMPT=0：要帳密時直接失敗，不會卡在沒有終端機的地方
    const r = await $.process.run(['git', ...plan.args], { cwd: snap.repoPath, env: { GIT_TERMINAL_PROMPT: '0' }, timeoutMs: 60_000 })
    result = { isOk: r.exitCode === 0, output: tidyOutput(`${r.stdout}\n${r.stderr}`) }
  } catch (err) {
    result = { isOk: false, output: err instanceof Error ? err.message : String(err) }
  }
  await update($, pushIntent, () => null)
  await update($, isPushing, () => false)
  await update($, pushResult, () => ({ branch: plan.branch, remote: plan.remote, ...result }))
  await refresh($, cfg)
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

// 面板上方的分支清單：本 session 的分支、有 worktree 的、有未推的、還沒合併的
function listedBranches(snap: CanopySnapshot): { shown: CanopyBranch[]; rest: number } {
  const rank = (b: CanopyBranch) => (b.isCurrent ? 0 : b.ahead > 0 ? 1 : b.worktree !== null ? 2 : 3)
  const candidates = snap.branches
    .filter(b => b.isCurrent || b.worktree !== null || b.ahead > 0 || !b.merged)
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
  const shown = candidates.slice(0, BRANCH_ROWS)
  return { shown, rest: snap.branches.length - shown.length }
}

// 徽章在介面 Text 上的顏色：主題色名，深淺色介面各自對應
const BADGE_TEXT: Record<BadgeKind, { color?: string; isDim?: boolean }> = {
  push: { color: 'warning' },
  info: { isDim: true },
  dirty: { color: 'warning' },
  diverged: { color: 'error' },
  ok: { color: 'success' },
  mute: { isDim: true },
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

async function openPane($: $, cfg: Config, t: Strings): Promise<void> {
  const snap = await read($, snapshot)
  await $.ui.open({ id: PANE, title: t.paneTitle(snap === null ? null : snap.repoName), columns: 120 })
  await refresh($, cfg)
}

// ── 設定的寫回 ──────────────────────────────────────────────

/**
 * 寫回一個 userConfig 欄位：和 /config 裡改是同一件事，寫進 settings.json 的
 * pluginConfigs，引擎隨即帶著新值重新載入模組。列的 key 從 $.config.list() 找，
 * 不自己拼：插件從哪裡載入（--plugin-dir、marketplace）會影響它的名字。
 */
async function save($: $, field: ConfigField, value: string | number | boolean): Promise<void> {
  let reason: string | null = null
  try {
    const rows = await $.config.list()
    const row = rows.find(r => r.provider.plugin === $.plugin.name && r.key.endsWith(`.${field}`))
    const result = await $.config.set({ key: row?.key ?? `${$.plugin.name}.${field}`, value })
    reason = result.deny ?? null
  } catch (err) {
    reason = err instanceof Error ? err.message : String(err)
  }
  try {
    await update($, settingsError, () => reason)
  } catch {
    // 寫成功時模組可能已經重新載入，這一筆寫不進去也無妨：新模組的錯誤本來就是 null
  }
}

export const register: Register = (on, options) => {
  const cfg = readConfig(options)
  const t = strings(cfg.language)

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'canopy', description: t.commandDescription })
    refreshSoon($, cfg)
    if (cfg.refreshSeconds > 0) $.clock.every(cfg.refreshSeconds * 1000, () => void refresh($, cfg))
    return next(e)
  })

  on('command.run', { command: 'canopy' }, async $ => {
    await openPane($, cfg, t)
    return { text: t.commandOpened }
  })

  // 回合結束、或模型剛跑過 git，就重抓一次
  on('turn.complete', ($, e, next) => {
    refreshSoon($, cfg)
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (/\bgit\b/.test(e.command)) refreshSoon($, cfg)
    return ran
  })

  // ── 輸入框上方的提示列 ──
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const pending = pendingOf(await read($, snapshot))
    if (pending === null || pending.signature === (await read($, dismissed))) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const { branch, others, signature } = pending
    // 按鈕不設 hotkey：輸入框空著時按數字會按到提示列的按鈕，吃掉使用者打的字
    return (
      <Box flexDirection="row" gap={1} alignItems="center">
        <Text color="warning" bold>
          ↑{branch.ahead}
        </Text>
        <Text wrap="truncate">
          <Text bold>{branch.name}</Text>
          {t.bandRest(branch.ahead, branch.upstream)}
          {others > 0 ? t.bandOthers(others) : ''}
        </Text>
        <Button key="open" label={t.openGraph} variant="primary" onPress={() => openPane($, cfg, t)} />
        <Button key="dismiss" label={t.notNow} role="dismiss" onPress={() => update($, dismissed, () => signature)} />
      </Box>
    )
  })

  // ── 線圖面板 ──
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const snap = await read($, snapshot)
    const failure = await read($, error)
    const presses = await read($, extra)
    const isOpen = await read($, isSettingsOpen)
    const saveError = await read($, settingsError)
    const intent = await read($, pushIntent)
    const pushing = await read($, isPushing)
    const lastPush = await read($, pushResult)
    const now = await $.clock.now()
    const limit = commitLimit(cfg, presses)
    const { Box, Text, Button } = $.ui.resolve(e)

    const toolbar = (
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        <Button key="refresh" label={t.refresh} hotkey="r" onPress={() => refresh($, cfg)} />
        {limit < MAX_COMMITS && (
          <Button
            key="more"
            label={t.more(limit)}
            hotkey="m"
            dimColor
            onPress={async () => {
              await update($, extra, n => (n ?? 0) + 1)
              await refresh($, cfg)
            }}
          />
        )}
        <Button key="settings" label={isOpen ? t.settingsDone : t.settings} hotkey="s" dimColor={!isOpen} onPress={() => update($, isSettingsOpen, v => !v)} />
        <Button key="close" label={t.close} role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
      </Box>
    )

    // 設定區：有 Select 的介面用下拉選，手機版沒有 Select，用按鈕輪流切換
    const refreshChoices = withCurrent(REFRESH_CHOICES, cfg.refreshSeconds)
    const commitChoices = withCurrent(COMMIT_CHOICES, cfg.commits)
    const refreshLabel = (n: number) => (n === 0 ? t.refreshOff : t.seconds(n))
    const themeLabel = (theme: GraphTheme) => (theme === 'auto' ? t.themeAuto : theme === 'dark' ? t.themeDark : t.themeLight)
    const languageName = LANGUAGES.find(l => l.code === cfg.language)?.name ?? cfg.language
    const after = <T,>(list: readonly T[], current: T) => list[(list.indexOf(current) + 1) % list.length] as T
    const onOff = (value: boolean) => (value ? t.on : t.off)
    const hooksLabel = (respect: boolean) => (respect ? t.respectHooksOptions.respect : t.respectHooksOptions.skip)
    const protectedText = cfg.protectedBranches.join(',')

    let fields
    if (e.surface === 'mobile') {
      fields = (
        <Box flexDirection="column">
          <Button key="set-language" label={`${t.language}: ${languageName}`} onPress={() => save($, 'language', after(LANGUAGES.map(l => l.code), cfg.language))} />
          <Button key="set-refresh" label={`${t.refreshEvery}: ${refreshLabel(cfg.refreshSeconds)}`} onPress={() => save($, 'refreshSeconds', after(refreshChoices, cfg.refreshSeconds))} />
          <Button key="set-commits" label={`${t.commits}: ${cfg.commits}`} onPress={() => save($, 'commits', after(commitChoices, cfg.commits))} />
          <Button key="set-theme" label={`${t.graphTheme}: ${themeLabel(cfg.graphTheme)}`} onPress={() => save($, 'graphTheme', after(THEMES, cfg.graphTheme))} />
          <Button key="set-push" label={`${t.pushSetting}: ${onOff(cfg.push)}`} onPress={() => save($, 'push', !cfg.push)} />
          {cfg.push && (
            <Box flexDirection="column">
              <Button key="set-worktree-push" label={`${t.worktreePushSetting}: ${t.worktreePushOptions[cfg.worktreePush]}`} onPress={() => save($, 'worktreePush', after(WORKTREE_PUSH, cfg.worktreePush))} />
              <Button key="set-hooks" label={`${t.respectHooksSetting}: ${hooksLabel(cfg.respectHooks)}`} onPress={() => save($, 'respectHooks', !cfg.respectHooks)} />
              <Text dimColor>
                {t.protectedSetting}: {protectedText}
              </Text>
            </Box>
          )}
        </Box>
      )
    } else {
      const { Select, Input } = $.ui.resolve(e)
      fields = (
        <Box flexDirection="column">
          <Select key="set-language" label={t.language} options={LANGUAGES.map(l => ({ value: l.code, label: l.name }))} value={cfg.language} onSelect={v => save($, 'language', v)} />
          <Select
            key="set-refresh"
            label={t.refreshEvery}
            options={refreshChoices.map(n => ({ value: String(n), label: refreshLabel(n) }))}
            value={String(cfg.refreshSeconds)}
            onSelect={v => save($, 'refreshSeconds', Number(v))}
          />
          <Select key="set-commits" label={t.commits} options={commitChoices.map(n => ({ value: String(n), label: String(n) }))} value={String(cfg.commits)} onSelect={v => save($, 'commits', Number(v))} />
          <Select key="set-theme" label={t.graphTheme} options={THEMES.map(th => ({ value: th, label: themeLabel(th) }))} value={cfg.graphTheme} onSelect={v => save($, 'graphTheme', v)} />
          <Select
            key="set-push"
            label={t.pushSetting}
            options={[
              { value: 'off', label: t.off },
              { value: 'on', label: t.on },
            ]}
            value={cfg.push ? 'on' : 'off'}
            onSelect={v => save($, 'push', v === 'on')}
          />
          {cfg.push && (
            <Box flexDirection="column">
              <Select
                key="set-worktree-push"
                label={t.worktreePushSetting}
                options={WORKTREE_PUSH.map(w => ({ value: w, label: t.worktreePushOptions[w] }))}
                value={cfg.worktreePush}
                onSelect={v => save($, 'worktreePush', v)}
              />
              <Select
                key="set-hooks"
                label={t.respectHooksSetting}
                options={[
                  { value: 'respect', label: t.respectHooksOptions.respect },
                  { value: 'skip', label: t.respectHooksOptions.skip },
                ]}
                value={cfg.respectHooks ? 'respect' : 'skip'}
                onSelect={v => save($, 'respectHooks', v === 'respect')}
              />
              <Input
                key="set-protected"
                label={t.protectedSetting}
                value={protectedText}
                placeholder="main,master"
                onSubmit={v => save($, 'protectedBranches', parseBranchList(v).join(','))}
              />
              <Text dimColor>{t.protectedHint}</Text>
            </Box>
          )}
        </Box>
      )
    }
    const settingsPanel = isOpen && (
      <Box flexDirection="column">
        {fields}
        <Text dimColor>{t.settingsHint}</Text>
        {saveError !== null && <Text color="error">{t.saveFailed(saveError)}</Text>}
      </Box>
    )

    if (snap === null) {
      const message = failure === 'not-repo' ? t.notRepo : failure === null ? t.loading : t.failed(failure)
      return (
        <Box flexDirection="column" gap={1}>
          <Text dimColor>{message}</Text>
          {toolbar}
          {settingsPanel}
        </Box>
      )
    }

    const layout = layoutGraph(snap.commits, snap.headSha)
    const tipColor = new Map<string, string>()
    snap.commits.forEach((c, i) => tipColor.set(c.sha, laneColor(layout.lanes[i] as number)))
    const { shown, rest } = listedBranches(snap)

    // 每一行都是一段文字（內嵌上色的片段），窄的時候整段換行，不會被 flex 擠成好幾欄
    const home = await homeDir($)
    const path = home !== undefined && snap.repoPath.startsWith(`${home}/`) ? `~${snap.repoPath.slice(home.length)}` : snap.repoPath
    const header = (
      <Box flexDirection="column">
        <Text>
          <Text bold>{snap.repoName}</Text>
          <Text dimColor>
            {'  '}
            {path} · {t.updated(ago(Math.floor(snap.builtAt / 1000), now))}
          </Text>
        </Text>
        {shown.map(b => (
          <Text>
            <Text color={tipColor.get(b.sha)} dimColor={!tipColor.has(b.sha)} bold={b.isCurrent}>
              {b.isCurrent ? '▸ ' : '  '}
              {b.name}
            </Text>
            {branchBadges(b, snap, t, now).map(badge => (
              <Text color={BADGE_TEXT[badge.kind].color} dimColor={BADGE_TEXT[badge.kind].isDim}>
                {'  '}
                {badge.text}
              </Text>
            ))}
          </Text>
        ))}
        {rest > 0 && <Text dimColor>  {t.restBranches(rest)}</Text>}
      </Box>
    )

    // 推送區（設定開了才有）：確認中就顯示要推的 commit 與確切指令，否則列出可推的分支
    let pushPanel = null
    if (cfg.push && intent !== null) {
      const confirmLabel = pushing
        ? t.pushing(intent.branch)
        : intent.isProtected
          ? intent.isArmed
            ? t.pushConfirmProtected(intent.branch)
            : t.pushArm(intent.branch)
          : t.pushConfirm
      pushPanel = (
        <Box flexDirection="column">
          <Text bold>{t.pushTitle(intent.branch, intent.remote)}</Text>
          <Text dimColor>git {intent.args.join(' ')}</Text>
          {intent.commits.map(c => (
            <Text>
              <Text dimColor>
                {'  '}
                {c.sha}
              </Text>{' '}
              {c.subject}
            </Text>
          ))}
          {intent.total > intent.commits.length && <Text dimColor>  {t.moreToPush(intent.total - intent.commits.length)}</Text>}
          {intent.isProtected && <Text color="warning">{t.protectedWarning(intent.branch)}</Text>}
          <Box flexDirection="row" gap={1}>
            <Button key="push-confirm" variant="primary" label={confirmLabel} onPress={() => confirmPush($, cfg, t)} />
            <Button key="push-cancel" label={t.cancel} onPress={() => update($, pushIntent, () => null)} />
          </Box>
        </Box>
      )
    } else if (cfg.push) {
      const rows = pushCandidates(snap).map(b => ({ b, check: planPush(snap, b.name, cfg) }))
      pushPanel = (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {rows
              .filter(({ check }) => check?.isAllowed === true)
              .map(({ b }) => (
                <Button key={`push:${b.name}`} label={t.pushButton(b.ahead, b.name)} onPress={() => startPush($, cfg, b.name)} />
              ))}
          </Box>
          {rows.map(({ b, check }) =>
            check !== null && !check.isAllowed && isPolicyReason(check.reason) ? (
              <Text dimColor>
                {b.name}: {t.blocked[check.reason]}
              </Text>
            ) : null,
          )}
          {lastPush !== null && (
            <Text color={lastPush.isOk ? 'success' : 'error'}>
              {lastPush.isOk ? t.pushed(lastPush.branch, lastPush.remote) : t.pushFailed(lastPush.branch)}
            </Text>
          )}
          {lastPush !== null && lastPush.output !== '' && <Text dimColor>{lastPush.output}</Text>}
        </Box>
      )
    }

    if (e.surface === 'terminal') {
      const grid = textGraph(snap.commits, snap.headSha)
      const byTip = new Map<string, CanopyBranch[]>()
      for (const b of snap.branches) byTip.set(b.sha, [...(byTip.get(b.sha) ?? []), b])
      return (
        <Box flexDirection="column" gap={1}>
          {header}
          {pushPanel}
          {toolbar}
          {settingsPanel}
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
    // viewBox 的寬度照欄數估；圖片會撐滿欄寬，估偏只影響字的大小（見 svg.ts 開頭）
    const width = Math.max(360, Math.min(1600, Math.round(e.props.bodyColumns * 7.8)))
    const svg = renderSvg(snap, { width, nowMs: now, theme: cfg.graphTheme, t })
    return (
      <Box flexDirection="column" gap={1}>
        {header}
        {pushPanel}
        {toolbar}
        {settingsPanel}
        <Svg source={svg.source} alt={t.graphAlt(snap.repoName, svg.rows)} />
        {svg.rows < snap.commits.length && <Text dimColor>{t.truncated(svg.rows)}</Text>}
      </Box>
    )
  })
}
