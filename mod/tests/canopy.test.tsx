import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { readConfig } from '../hooks/config'
import { layoutGraph } from '../hooks/lanes'
import { strings } from '../hooks/i18n'
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

/** 假 repo 的可變部分：feat 的 tip 與未推數，測試中途可以推進；logLimits 記下每次 git log 要幾筆。 */
type Repo = { tip: string; ahead: number; logLimits: number[] }

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
  if (a.startsWith('for-each-ref --merged')) return 'main'
  if (a.startsWith('for-each-ref refs/heads')) return [`feat${US}${repo.tip}${US}${US}`, `main${US}m1${US}origin/main${US}`].join('\n')
  if (a.startsWith('rev-list --count refs/heads/feat')) return String(repo.ahead)
  if (a.startsWith('log ')) {
    repo.logLimits.push(Number(argv[argv.indexOf('-n') + 1]))
    return log(repo)
  }
  return null
}

type Saved = { key: string; value: unknown }

/** 把 session 擺進假 repo：git、工作目錄、HOME、session 記錄、時鐘、開面板、/config。 */
function world(on: On, opts: { ahead?: number; cwd?: string; isNotRepo?: boolean; denySave?: string } = {}) {
  const opened: string[] = []
  const saved: Saved[] = []
  const repo: Repo = { tip: 'f2', ahead: opts.ahead ?? 2, logLimits: [] }
  mock.clock(on, { now: NOW })
  mock.env(on, { HOME: '/home/u' })
  on('session.cwd', () => ({ value: opts.cwd ?? WT }))
  on('process.run', ($, e) => {
    const out = opts.isNotRepo ? null : fakeGit(e.argv, e.init?.cwd, repo)
    return { value: { exitCode: out === null ? 128 : 0, stdout: out ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.list', ($, e) => ({
    value: e.path?.endsWith('-r--claude-worktrees-feat') ? [{ name: 's.jsonl', kind: 'file' as const, size: 1, mtimeMs: NOW - 60_000, isLink: false }] : [],
  }))
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
    value: ['language', 'refreshSeconds', 'commits', 'graphTheme'].map(field => ({
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
    expect(readConfig({ refreshSeconds: 3, commits: 9999, language: 'fr', graphTheme: 'neon' })).toEqual({
      language: 'en',
      refreshSeconds: 10,
      commits: 400,
      graphTheme: 'auto',
    })
    expect(readConfig({ refreshSeconds: 0 }).refreshSeconds).toBe(0)
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
