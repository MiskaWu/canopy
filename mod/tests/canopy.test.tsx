import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { parseBranchList, readConfig, type Config } from '../hooks/config'
import { layoutGraph } from '../hooks/lanes'
import { strings } from '../hooks/i18n'
import { planPush } from '../hooks/push'
import { renderSvg, SVG_LIMIT } from '../hooks/svg'
import { merge, textGraph } from '../hooks/textgraph'
import type { CanopySnapshot } from '../types'

// 假的 repo：主 checkout 在 main，session 開在 worktree 的 feat 分支，feat 有 2 個 commit 沒推。
//
//   f2  (feat)
//   f1
//   m1  (main, origin/main)  合併 s1
//   s1
//   b1                        父節點 b0 在範圍外
const MAIN = '/r'
const WT = '/r/.claude/worktrees/feat'
const NOW = 1_700_000_000_000
const US = '\x1f'

const COMMITS = [
  ['f2', 'f1', 'claude', 'feat: 第二步'],
  ['f1', 'm1', 'claude', 'feat: 第一步'],
  ['m1', 'b1 s1', 'me', "Merge branch 'side'"],
  ['s1', 'b1', 'me', 'side work'],
  ['b1', 'b0', 'me', 'base'],
]

/**
 * 假 repo 的可變部分，測試中途可以推進：feat 的 tip 與未推數、feat 有沒有 upstream、main 領先幾筆、
 * claude.worktreePushRemote、有沒有 pre-push hook、推送要不要失敗。
 * logLimits 記下每次 git log 要幾筆，pushes 記下每次 git push 的參數與環境變數。
 */
type Repo = {
  tip: string
  ahead: number
  featUpstream: boolean
  mainAhead: number
  pushKey: string | null
  hasHook: boolean
  pushFails: string | null
  logLimits: number[]
  pushes: { args: string[]; env: Record<string, string> | undefined }[]
}

const HOOK = '/r/.git/hooks/pre-push'

function log(repo: Repo): string {
  const rows = repo.tip === 'f2' ? COMMITS : [[repo.tip, 'f2', 'claude', 'feat: 又一步'], ...COMMITS]
  const refs = (sha: string) => (sha === repo.tip ? 'feat' : sha === 'm1' ? 'origin/main, main' : '')
  return rows.map(([sha = '', parents, author, subject]) => [sha, parents, String(NOW / 1000 - 600), refs(sha), author, subject].join(US)).join('\n')
}

function fakeGit(argv: readonly string[], cwd: string | undefined, repo: Repo): string | null {
  const a = argv.slice(1).join(' ')
  if (a === 'rev-parse --show-toplevel') return cwd ?? WT
  if (a === 'rev-parse --abbrev-ref HEAD') return cwd === MAIN ? 'main' : 'feat'
  if (a === 'rev-parse HEAD') return cwd === MAIN ? 'm1' : repo.tip
  if (a === 'remote') return 'origin'
  if (a === 'worktree list --porcelain') return `worktree ${MAIN}\nHEAD m1\nbranch refs/heads/main\n\nworktree ${WT}\nHEAD ${repo.tip}\nbranch refs/heads/feat\n`
  if (a === 'status --porcelain') return cwd === WT ? ' M hooks/register.tsx' : ''
  if (a === 'symbolic-ref --quiet --short refs/remotes/origin/HEAD') return 'origin/main'
  if (a === 'config --local --get claude.worktreePushRemote') return repo.pushKey
  if (a === 'rev-parse --path-format=absolute --git-path hooks/pre-push') return HOOK
  if (a.startsWith('for-each-ref --merged')) return 'main'
  if (a.startsWith('for-each-ref refs/heads')) {
    const feat = repo.featUpstream ? `feat${US}${repo.tip}${US}origin/feat${US}[ahead ${repo.ahead}]` : `feat${US}${repo.tip}${US}${US}`
    const main = `main${US}m1${US}origin/main${US}${repo.mainAhead > 0 ? `[ahead ${repo.mainAhead}]` : ''}`
    return [feat, main].join('\n')
  }
  if (a.startsWith('rev-list --count refs/heads/feat') || a === 'rev-list --count origin/feat..refs/heads/feat') return String(repo.ahead)
  if (a === 'rev-list --count origin/main..refs/heads/main') return String(repo.mainAhead)
  // 推送前的預覽：要推哪些 commit
  if (a.startsWith(`log --format=%h${US}%s -n 10`)) {
    return a.includes('refs/heads/main') ? `m9${US}main: 本地一筆` : [`f2${US}feat: 第二步`, `f1${US}feat: 第一步`].join('\n')
  }
  if (a.startsWith('push ')) return 'pushed'
  if (a.startsWith('log ')) {
    repo.logLimits.push(Number(argv[argv.indexOf('-n') + 1]))
    return log(repo)
  }
  return null
}

type Saved = { key: string; value: unknown }

/** 把 session 擺進假 repo：git、工作目錄、HOME、session 記錄、時鐘、開面板、/config。 */
type WorldOptions = { ahead?: number; cwd?: string; isNotRepo?: boolean; denySave?: string } & Partial<Pick<Repo, 'mainAhead' | 'pushKey' | 'hasHook' | 'pushFails'>>

function world(on: On, opts: WorldOptions = {}) {
  const opened: string[] = []
  const saved: Saved[] = []
  const repo: Repo = {
    tip: 'f2',
    ahead: opts.ahead ?? 2,
    featUpstream: false,
    mainAhead: opts.mainAhead ?? 0,
    pushKey: opts.pushKey ?? null,
    hasHook: opts.hasHook ?? false,
    pushFails: opts.pushFails ?? null,
    logLimits: [],
    pushes: [],
  }
  mock.clock(on, { now: NOW })
  mock.env(on, { HOME: '/home/u' })
  on('session.cwd', () => ({ value: opts.cwd ?? WT }))
  on('process.run', ($, e) => {
    if (e.argv[1] === 'push') {
      repo.pushes.push({ args: e.argv.slice(1), env: e.init?.env })
      if (repo.pushFails !== null) {
        return { value: { exitCode: 1, stdout: '', stderr: repo.pushFails, isStdoutTruncated: false, isStderrTruncated: false } }
      }
    }
    const out = opts.isNotRepo ? null : fakeGit(e.argv, e.init?.cwd, repo)
    return { value: { exitCode: out === null ? 128 : 0, stdout: out ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.list', ($, e) => ({
    value: e.path?.endsWith('-r--claude-worktrees-feat') ? [{ name: 's.jsonl', kind: 'file' as const, size: 1, mtimeMs: NOW - 60_000, isLink: false }] : [],
  }))
  on('fs.exists', ($, e) => ({ value: repo.hasHook && e.path === HOOK }))
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  // /config：插件的列以 `<plugin>@inline.<field>` 命名，確認寫回時用的是列表給的 key
  on('config.list', () => ({
    value: ['language', 'refreshSeconds', 'commits', 'graphTheme', 'push', 'worktreePush', 'protectedBranches', 'respectHooks'].map(field => ({
      key: `canopy@inline.${field}`,
      label: field,
      kind: 'text' as const,
      value: '',
      provider: { plugin: 'canopy', tier: 'user' as const },
      isLocked: false,
    })),
  }))
  on('config.set', ($, e) => {
    if (opts.denySave !== undefined) return { deny: opts.denySave }
    saved.push({ key: e.key, value: e.value })
    return { value: e.value }
  })
  return { opened, repo, saved }
}

const BAND = {
  plugin: 'canopy',
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 120, scroll: { offset: 0, bodyRows: 12 }, view: {} },
}
const PANE = {
  plugin: 'canopy',
  component: 'Pane' as const,
  requestId: 'canopy',
  props: { title: 'canopy', isFocused: true, bodyColumns: 120, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} },
}
const SURFACES = ['terminal', 'desktop'] as const
const RUN = { command: 'canopy', args: '', origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 160 } }
const ZH = { options: { language: 'zh-TW' } }

describe('提示列', () => {
  test('預設英文：有未推 commit 時出現，按「View graph」開面板', async ($, on) => {
    const { opened } = world(on)
    await $.command.run(RUN) // 指令會開面板並抓一次快照
    expect(opened).toEqual(['canopy'])
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...BAND, surface })
      expect(await ui.find({ type: 'Text', text: /feat has 2 commits not on any remote/ })).toBeDefined()
      expect((await ui.find({ key: 'open' }))?.props.label).toBe('View graph')
      await ui.press({ key: 'open' })
      await ui.unmount()
    }
    expect(opened).toEqual(['canopy', 'canopy', 'canopy'])
  })

  test('繁中：同一列換成中文', ZH, async ($, on) => {
    world(on)
    await $.command.run(RUN)
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect(await ui.find({ type: 'Text', text: /feat 有 2 個 commit 不在任何 remote 上/ })).toBeDefined()
    expect((await ui.find({ key: 'open' }))?.props.label).toBe('看線圖')
    await ui.unmount()
  })

  test('按掉之後消失，分支再動才回來', async ($, on) => {
    const { repo } = world(on)
    await $.command.run(RUN)
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect(await ui.find({ key: 'open' })).toBeDefined()
    await ui.press({ key: 'dismiss' })
    expect(await ui.find({ key: 'open' })).toBeUndefined()

    // 再 commit 一次：簽章變了，提示回來
    repo.tip = 'f3'
    repo.ahead = 3
    await $.command.run(RUN)
    expect(await ui.find({ type: 'Text', text: /feat has 3 commits/ })).toBeDefined()
    await ui.unmount()
  })

  test('全都推了就不出現', async ($, on) => {
    world(on, { ahead: 0 })
    await $.command.run(RUN)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ key: 'open' })).toBeUndefined()
    await ui.unmount()
  })
})

describe('面板', () => {
  test('桌面版畫 Svg，終端機畫文字線圖', ZH, async ($, on) => {
    world(on)
    await $.command.run(RUN)

    const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const svg = await desk.find({ type: 'Svg' })
    expect(String(svg?.props.source)).toContain('feat · HEAD')
    // 不開 isInteractive：桌面版會改用 iframe 畫，沒給高度就只有 150px，整張圖被縮成一小塊
    expect(svg?.props.isInteractive).toBeUndefined()
    // worktree 資料夾名跟分支名一樣時不重複寫
    expect(await desk.find({ type: 'Text', text: /⌂ worktree/ })).toBeDefined()
    expect(await desk.find({ type: 'Text', text: /● 進行中/ })).toBeDefined()
    expect(await desk.find({ type: 'Text', text: /✎ 未commit/ })).toBeDefined()
    await desk.unmount()

    const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await term.find({ type: 'Svg' })).toBeUndefined()
    expect(await term.find({ type: 'Text', text: /feat: 第二步/ })).toBeDefined()
    await term.unmount()
  })

  test('不在 repo 裡就說明，不報錯', async ($, on) => {
    world(on, { cwd: '/tmp/nowhere', isNotRepo: true })
    await $.command.run(RUN)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ type: 'Text', text: /not inside a git repository/ })).toBeDefined()
    await ui.unmount()
  })

  test('「更多 commit」每按一次多抓一份設定的筆數', { options: { commits: 40 } }, async ($, on) => {
    const { repo } = world(on)
    await $.command.run(RUN)
    expect(repo.logLimits.at(-1)).toBe(40)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'more' })
    expect(repo.logLimits.at(-1)).toBe(80)
    await ui.unmount()
  })
})

describe('面板裡的設定', () => {
  test('桌面與終端機：設定區用下拉選，選了就寫回 /config 列的 key', async ($, on) => {
    const { saved } = world(on)
    await $.command.run(RUN)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await ui.find({ key: 'set-language' })).toBeUndefined()
      await ui.press({ key: 'settings' })
      expect((await ui.find({ key: 'set-language' }))?.type).toBe('Select')
      expect((await ui.find({ key: 'set-theme' }))?.type).toBe('Select')
      await ui.press({ key: 'settings' }) // 收起來，下一個介面從頭開
      await ui.unmount()
    }
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'settings' })
    await ui.select({ key: 'set-language', value: 'zh-TW' })
    await ui.select({ key: 'set-refresh', value: '120' })
    expect(saved).toEqual([
      { key: 'canopy@inline.language', value: 'zh-TW' },
      { key: 'canopy@inline.refreshSeconds', value: 120 },
    ])
    await ui.unmount()
  })

  test('手機沒有下拉選：用按鈕輪流切換', async ($, on) => {
    const { saved } = world(on)
    await $.command.run(RUN)
    const ui = await $.ui.mount({ ...PANE, surface: 'mobile' })
    await ui.press({ key: 'settings' })
    await ui.press({ key: 'set-theme' })
    expect(saved).toEqual([{ key: 'canopy@inline.graphTheme', value: 'dark' }])
    await ui.unmount()
  })

  test('寫不進去就把原因顯示在設定區', async ($, on) => {
    world(on, { denySave: 'managed by policy' })
    await $.command.run(RUN)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'settings' })
    await ui.select({ key: 'set-commits', value: '160' })
    expect(await ui.find({ type: 'Text', text: /Could not save: managed by policy/ })).toBeDefined()
    await ui.unmount()
  })

  test('設定值有界限：輪詢至少 10 秒、0 是關閉、commit 數夾在 10 到 400、未知語言退回英文', () => {
    // 推送相關的預設值走最佳實踐：預設關（最小權限）、受保護 main/master、尊重 pre-push hook
    expect(readConfig({ refreshSeconds: 3, commits: 9999, language: 'fr', graphTheme: 'neon', worktreePush: 'yolo' })).toEqual({
      language: 'en',
      refreshSeconds: 10,
      commits: 400,
      graphTheme: 'auto',
      push: false,
      worktreePush: 'allow',
      protectedBranches: ['main', 'master'],
      respectHooks: true,
    })
    expect(readConfig({ refreshSeconds: 0 }).refreshSeconds).toBe(0)
  })
})

describe('推送', () => {
  const PUSH = { options: { push: true } }

  test('預設關閉：沒有推送按鈕，設定區的開關是關', async ($, on) => {
    world(on)
    await $.command.run(RUN)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ key: 'push:feat' })).toBeUndefined()
    await ui.press({ key: 'settings' })
    expect((await ui.find({ key: 'set-push' }))?.props.value).toBe('off')
    expect(await ui.find({ key: 'set-worktree-push' })).toBeUndefined() // 推送沒開，政策欄位不出現
    await ui.unmount()
  })

  test('按 ↑N 先看清單與確切指令，確認才推；指令固定、不帶強推、不會問密碼', PUSH, async ($, on) => {
    const { repo } = world(on)
    await $.command.run(RUN)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect((await ui.find({ key: 'push:feat' }))?.props.label).toBe('↑2 Push feat')
      await ui.unmount()
    }
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'push:feat' })
    expect(repo.pushes).toEqual([]) // 按了 ↑N 還沒推
    expect(await ui.find({ type: 'Text', text: 'git push -u origin feat' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /feat: 第二步/ })).toBeDefined()
    await ui.press({ key: 'push-confirm' })
    expect(repo.pushes).toEqual([{ args: ['push', '-u', 'origin', 'feat'], env: { GIT_TERMINAL_PROMPT: '0' } }])
    expect(await ui.find({ type: 'Text', text: /Pushed feat to origin/ })).toBeDefined()
    await ui.unmount()
  })

  test('取消就不推', PUSH, async ($, on) => {
    const { repo } = world(on)
    await $.command.run(RUN)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'push:feat' })
    await ui.press({ key: 'push-cancel' })
    expect(await ui.find({ key: 'push-confirm' })).toBeUndefined()
    expect(repo.pushes).toEqual([])
    await ui.unmount()
  })

  test('受保護分支（remote 的預設分支）要確認兩次', PUSH, async ($, on) => {
    const { repo } = world(on, { mainAhead: 1 })
    await $.command.run(RUN)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'push:main' })
    expect(await ui.find({ type: 'Text', text: /main is a protected branch/ })).toBeDefined()
    expect((await ui.find({ key: 'push-confirm' }))?.props.label).toBe('Push to main…')
    await ui.press({ key: 'push-confirm' })
    expect(repo.pushes).toEqual([])
    expect((await ui.find({ key: 'push-confirm' }))?.props.label).toBe('Yes, push to main')
    await ui.press({ key: 'push-confirm' })
    expect(repo.pushes.map(p => p.args)).toEqual([['push', 'origin', 'main']])
    await ui.unmount()
  })

  test('確認前指令變了（upstream 剛設好）就換成新指令、等再按一次', PUSH, async ($, on) => {
    const { repo } = world(on)
    await $.command.run(RUN)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'push:feat' })
    repo.featUpstream = true
    await ui.press({ key: 'refresh' })
    await ui.press({ key: 'push-confirm' })
    expect(repo.pushes).toEqual([])
    expect(await ui.find({ type: 'Text', text: 'git push origin feat' })).toBeDefined()
    await ui.press({ key: 'push-confirm' })
    expect(repo.pushes.map(p => p.args)).toEqual([['push', 'origin', 'feat']])
    await ui.unmount()
  })

  test('有 pre-push hook：預設不給推並說明原因', PUSH, async ($, on) => {
    world(on, { hasHook: true })
    await $.command.run(RUN)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ key: 'push:feat' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /pre-push hook/ })).toBeDefined()
    await ui.unmount()
  })

  test('worktree 分支 allowKey：沒設 key 不給推並說明，設了就推到那個 remote', { options: { push: true, worktreePush: 'allowKey' } }, async ($, on) => {
    const { repo } = world(on)
    await $.command.run(RUN)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ key: 'push:feat' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /claude\.worktreePushRemote/ })).toBeDefined()
    repo.pushKey = 'origin'
    await ui.press({ key: 'refresh' })
    await ui.press({ key: 'push:feat' })
    await ui.press({ key: 'push-confirm' })
    expect(repo.pushes.map(p => p.args)).toEqual([['push', '-u', 'origin', 'feat']])
    await ui.unmount()
  })

  test('推送失敗：把 git 的訊息顯示出來', PUSH, async ($, on) => {
    world(on, { pushFails: ' ! [rejected]        feat -> feat (non-fast-forward)' })
    await $.command.run(RUN)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'push:feat' })
    await ui.press({ key: 'push-confirm' })
    expect(await ui.find({ type: 'Text', text: /Pushing feat failed/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /non-fast-forward/ })).toBeDefined()
    await ui.unmount()
  })

  test('只有按鈕能推：/canopy 帶什麼參數都不會推', PUSH, async ($, on) => {
    const { repo } = world(on)
    await $.command.run({ ...RUN, args: 'push feat' })
    await $.command.run({ ...RUN, args: 'push origin feat --force' })
    expect(repo.pushes).toEqual([])
  })
})

describe('推送政策（規則表）', () => {
  const base: CanopySnapshot = {
    repoName: 'r',
    repoPath: '/r',
    cwdBranch: 'feat',
    headSha: 'f2',
    mainBranch: 'main',
    noRemote: false,
    remotes: ['origin', 'fork'],
    branches: [
      {
        name: 'feat',
        sha: 'f2',
        upstream: null,
        ahead: 2,
        behind: 0,
        noUpstream: true,
        gone: false,
        merged: false,
        isCurrent: true,
        worktree: { path: '/r/wt', name: 'feat', isMain: false, isDirty: false, session: null },
      },
    ],
    commits: [],
    defaultBranch: 'develop',
    worktreePushRemote: null,
    hasPrePushHook: false,
    builtAt: NOW,
  }
  const cfg = (o: Partial<Config> = {}): Config => ({ ...readConfig({ push: true }), ...o })

  test('worktree 分支 allowKey：有 key 就推到 key 指的 remote，key 指到不存在的 remote 就擋', () => {
    const toFork = planPush({ ...base, worktreePushRemote: 'fork' }, 'feat', cfg({ worktreePush: 'allowKey' }))
    expect(toFork?.isAllowed && toFork.plan.args).toEqual(['push', '-u', 'fork', 'feat'])
    const missing = planPush({ ...base, worktreePushRemote: 'nope' }, 'feat', cfg({ worktreePush: 'allowKey' }))
    expect(missing).toEqual({ isAllowed: false, reason: 'worktree-no-key' })
    expect(planPush(base, 'feat', cfg({ worktreePush: 'block' }))).toEqual({ isAllowed: false, reason: 'worktree-block' })
  })

  test('remote 的預設分支一律受保護，加上設定的清單', () => {
    const snap = { ...base, branches: [{ ...base.branches[0]!, name: 'develop', worktree: null }] }
    const check = planPush(snap, 'develop', cfg({ protectedBranches: [] }))
    expect(check?.isAllowed && check.plan.isProtected).toBe(true)
  })

  test('pre-push hook 預設擋，respectHooks 關掉才放', () => {
    const snap = { ...base, hasPrePushHook: true }
    expect(planPush(snap, 'feat', cfg())).toEqual({ isAllowed: false, reason: 'hook' })
    expect(planPush(snap, 'feat', cfg({ respectHooks: false }))?.isAllowed).toBe(true)
  })

  test('受保護清單的設定：逗號分隔、去空白、去重複', () => {
    expect(parseBranchList(' main, release ,,main ')).toEqual(['main', 'release'])
    expect(readConfig({}).protectedBranches).toEqual(['main', 'master'])
  })
})

describe('線圖排版', () => {
  const commits = [
    { sha: 'f2', parents: ['f1'] },
    { sha: 'f1', parents: ['m1'] },
    { sha: 'm1', parents: ['b1', 's1'] },
    { sha: 's1', parents: ['b1'] },
    { sha: 'b1', parents: ['b0'] },
  ]

  test('合併的第二父邊立刻彎進自己那道', () => {
    const layout = layoutGraph(commits, 'f2')
    expect(layout.lanes).toEqual([0, 0, 0, 1, 0])
    expect(layout.edges.find(e => e.fromRow === 2 && e.toRow === 3)).toEqual({ fromRow: 2, fromLane: 0, toRow: 3, toLane: 1, via: 1 })
    expect(layout.edges.find(e => e.fromRow === 3 && e.toRow === 4)?.via).toBe(1)
    expect(layout.stubs).toEqual([{ row: 4, lane: 0 }])
  })

  test('文字線圖的格子', () => {
    const rows = textGraph(commits, 'f2').map(cells => cells.map(c => c.ch).join('').trimEnd())
    expect(rows).toEqual(['●', '●', '○─╮', '│ ●', '●─╯'])
  })

  test('同一格的轉角與直線合成正確的框線字元', () => {
    expect(merge('╯', '╮')).toBe('┤')
    expect(merge('╰', '╭')).toBe('├')
    expect(merge('│', '─')).toBe('┼')
    expect(merge('─', '╯')).toBe('┴')
    expect(merge(' ', '│')).toBe('│')
  })
})

describe('Svg', () => {
  const snap = (count: number): CanopySnapshot => {
    const many = Array.from({ length: count }, (_, i) => ({
      sha: `c${i}`.padEnd(40, '0'),
      parents: i < count - 1 ? [`c${i + 1}`.padEnd(40, '0')] : [],
      time: NOW / 1000 - i * 60,
      refs: [],
      author: 'someone',
      subject: `一個頗長的提交訊息，用來把每一列撐到接近真實的長度 #${i}`,
    }))
    return {
      repoName: 'r',
      repoPath: '/r',
      cwdBranch: 'main',
      headSha: many[0]?.sha ?? '',
      mainBranch: 'main',
      noRemote: false,
      remotes: ['origin'],
      branches: [],
      commits: many,
      defaultBranch: 'main',
      worktreePushRemote: null,
      hasPrePushHook: false,
      builtAt: NOW,
    }
  }
  const opts = { width: 1000, nowMs: NOW, t: strings('en') }

  test('commit 再多都不超過上限', () => {
    const { source, rows } = renderSvg(snap(400), { ...opts, theme: 'auto' })
    expect(source.length).toBeLessThanOrEqual(SVG_LIMIT)
    expect(rows).toBeGreaterThan(100)
  })

  test('根元素只給 viewBox：圖片撐滿欄寬，不靠估的寬度', () => {
    const root = /^<svg[^>]*>/.exec(renderSvg(snap(3), { ...opts, theme: 'auto' }).source)?.[0] ?? ''
    expect(root).toContain('viewBox="0 0 1000 ')
    expect(root).not.toMatch(/\s(width|height)=/)
  })

  test('主題：auto 跟著 prefers-color-scheme，指定深淺色就只有那一套', () => {
    const auto = renderSvg(snap(3), { ...opts, theme: 'auto' }).source
    const dark = renderSvg(snap(3), { ...opts, theme: 'dark' }).source
    const light = renderSvg(snap(3), { ...opts, theme: 'light' }).source
    expect(auto).toContain('@media (prefers-color-scheme: light)')
    expect(dark).not.toContain('prefers-color-scheme')
    expect(dark).toContain('--bg:#151a20')
    expect(light).toContain('--bg:#f6f8fa')
    expect(light).not.toContain('--bg:#151a20')
  })
})
