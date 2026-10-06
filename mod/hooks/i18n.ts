// 介面文字的對照表：每種語言一份，鍵完全相同（型別保證）。
// 新增語言＝在 LANGUAGES 加一筆、寫一份 Strings，再把代碼加進 plugin.json 的 options。

export type Language = 'en' | 'zh-TW'

export const LANGUAGES: readonly { code: Language; name: string }[] = [
  { code: 'en', name: 'English' },
  { code: 'zh-TW', name: '繁體中文' },
]

export type Strings = {
  // 提示列
  bandRest: (ahead: number, upstream: string | null) => string
  bandOthers: (count: number) => string
  openGraph: string
  notNow: string
  // 指令
  commandDescription: string
  commandOpened: string
  // 面板
  paneTitle: (repo: string | null) => string
  refresh: string
  more: (count: number) => string
  close: string
  settings: string
  settingsDone: string
  notRepo: string
  loading: string
  failed: (message: string) => string
  updated: (ago: string) => string
  restBranches: (count: number) => string
  truncated: (rows: number) => string
  graphAlt: (repo: string, rows: number) => string
  // 徽章（面板清單與線圖共用）
  head: string
  worktree: string
  live: string
  dirty: string
  noUpstream: string
  gone: string
  diverged: string
  merged: string
  // 設定
  language: string
  refreshEvery: string
  refreshOff: string
  seconds: (n: number) => string
  commits: string
  graphTheme: string
  themeAuto: string
  themeDark: string
  themeLight: string
  settingsHint: string
  saveFailed: (reason: string) => string
  // 推送
  pushButton: (ahead: number, branch: string) => string
  pushTitle: (branch: string, remote: string) => string
  moreToPush: (count: number) => string
  protectedWarning: (branch: string) => string
  pushConfirm: string
  pushArm: (branch: string) => string
  pushConfirmProtected: (branch: string) => string
  cancel: string
  pushing: (branch: string) => string
  pushed: (branch: string, remote: string) => string
  pushFailed: (branch: string) => string
  blocked: { hook: string; 'worktree-block': string; 'worktree-no-key': (key: string) => string }
  pushSetting: string
  on: string
  off: string
  worktreePushSetting: string
  worktreePushOptions: Record<'allow' | 'perRepo' | 'block', string>
  worktreePushKeySetting: string
  worktreePushKeyHint: (key: string) => string
  protectedSetting: string
  protectedHint: string
  respectHooksSetting: string
  respectHooksOptions: { respect: string; skip: string }
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

const en: Strings = {
  bandRest: (ahead, upstream) =>
    ` has ${ahead} ${plural(ahead, 'commit', 'commits')} ${upstream === null ? 'not on any remote' : `not pushed to ${upstream}`}`,
  bandOthers: count => ` (${count} other ${plural(count, 'branch', 'branches')} unpushed too)`,
  openGraph: 'View graph',
  notNow: 'Not now',
  commandDescription: 'Open the git graph pane (every branch and worktree of this repo)',
  commandOpened: 'Opened the canopy git graph.',
  paneTitle: repo => (repo === null ? 'Git graph' : `Git graph · ${repo}`),
  refresh: 'Refresh',
  more: count => `More commits (${count} now)`,
  close: 'Close',
  settings: 'Settings',
  settingsDone: 'Done',
  notRepo: "This session's working directory is not inside a git repository.",
  loading: 'Loading…',
  failed: message => `Could not read the repository: ${message}`,
  updated: ago => `updated ${ago} ago`,
  restBranches: count => `…${count} more ${plural(count, 'branch', 'branches')} not listed (merged or idle)`,
  truncated: rows => `The graph stops at commit ${rows} (image size limit).`,
  graphAlt: (repo, rows) => `Git graph of the last ${rows} commits in ${repo}`,
  head: 'HEAD',
  worktree: 'worktree',
  live: '● active',
  dirty: '✎ uncommitted',
  noUpstream: 'no upstream',
  gone: 'upstream gone',
  diverged: '⚠ diverged',
  merged: '✓ merged',
  language: 'Language',
  refreshEvery: 'Auto refresh',
  refreshOff: 'Off',
  seconds: n => `every ${n}s`,
  commits: 'Commits in the graph',
  graphTheme: 'Graph theme',
  themeAuto: 'Follow the app',
  themeDark: 'Dark',
  themeLight: 'Light',
  settingsHint: 'The same settings are under /config.',
  saveFailed: reason => `Could not save: ${reason}`,
  pushButton: (ahead, branch) => `↑${ahead} Push ${branch}`,
  pushTitle: (branch, remote) => `Push ${branch} to ${remote}`,
  moreToPush: count => `…and ${count} more`,
  protectedWarning: branch => `${branch} is a protected branch.`,
  pushConfirm: 'Push',
  pushArm: branch => `Push to ${branch}…`,
  pushConfirmProtected: branch => `Yes, push to ${branch}`,
  cancel: 'Cancel',
  pushing: branch => `Pushing ${branch}…`,
  pushed: (branch, remote) => `Pushed ${branch} to ${remote}.`,
  pushFailed: branch => `Pushing ${branch} failed:`,
  blocked: {
    hook: 'this repository has a pre-push hook, which does not run when canopy pushes. Push from a terminal.',
    'worktree-block': 'worktree branches are not pushed from the pane (Settings).',
    'worktree-no-key': key => `worktree branch, and this repository's local git config has no ${key} naming a remote.`,
  },
  pushSetting: 'Push from the pane',
  on: 'On',
  off: 'Off',
  worktreePushSetting: 'Worktree branches',
  worktreePushOptions: { allow: 'Push like any branch', perRepo: 'Only in repositories that opt in', block: 'Never from the pane' },
  worktreePushKeySetting: 'Opt-in git config key',
  worktreePushKeyHint: key => `A repository opts in with: git config --local ${key} <remote>. Worktree branches then go only to that remote.`,
  protectedSetting: 'Protected branches',
  protectedHint: "Comma-separated; pushing one asks twice. The remote's default branch is always protected.",
  respectHooksSetting: 'Repositories with a pre-push hook',
  respectHooksOptions: { respect: 'Push from a terminal instead', skip: 'Push anyway, skipping the hook' },
}

const zhTW: Strings = {
  bandRest: (ahead, upstream) => ` 有 ${ahead} 個 commit ${upstream === null ? '不在任何 remote 上' : `還沒推到 ${upstream}`}`,
  bandOthers: count => `（另有 ${count} 條分支也有未推）`,
  openGraph: '看線圖',
  notNow: '先不用',
  commandDescription: '開啟 git 線圖面板（session 所在 repo 的所有分支與 worktree）',
  commandOpened: '已開啟 canopy 線圖面板。',
  paneTitle: repo => (repo === null ? 'git 線圖' : `git 線圖 · ${repo}`),
  refresh: '重新整理',
  more: count => `更多 commit（目前 ${count}）`,
  close: '關閉',
  settings: '設定',
  settingsDone: '完成',
  notRepo: '這個 session 的工作目錄不在 git repo 裡。',
  loading: '讀取中…',
  failed: message => `讀取失敗：${message}`,
  updated: ago => `${ago} 前更新`,
  restBranches: count => `…另有 ${count} 條分支沒列出（已合併、沒在動）`,
  truncated: rows => `線圖只畫到第 ${rows} 筆（圖的大小有上限）。`,
  graphAlt: (repo, rows) => `${repo} 最近 ${rows} 筆 commit 的線圖`,
  head: 'HEAD',
  worktree: 'worktree',
  live: '● 進行中',
  dirty: '✎ 未commit',
  noUpstream: '無upstream',
  gone: 'upstream 已消失',
  diverged: '⚠ 分岔',
  merged: '✓ 已合併',
  language: '語言',
  refreshEvery: '自動更新',
  refreshOff: '關閉',
  seconds: n => `每 ${n} 秒`,
  commits: '線圖 commit 數',
  graphTheme: '線圖主題',
  themeAuto: '跟隨介面',
  themeDark: '深色',
  themeLight: '淺色',
  settingsHint: '同一組設定也在 /config 裡。',
  saveFailed: reason => `無法儲存：${reason}`,
  pushButton: (ahead, branch) => `↑${ahead} 推送 ${branch}`,
  pushTitle: (branch, remote) => `推送 ${branch} 到 ${remote}`,
  moreToPush: count => `…還有 ${count} 筆`,
  protectedWarning: branch => `${branch} 是受保護的分支。`,
  pushConfirm: '推送',
  pushArm: branch => `推送到 ${branch}…`,
  pushConfirmProtected: branch => `確定推送到 ${branch}`,
  cancel: '取消',
  pushing: branch => `正在推送 ${branch}…`,
  pushed: (branch, remote) => `已推送 ${branch} 到 ${remote}。`,
  pushFailed: branch => `推送 ${branch} 失敗：`,
  blocked: {
    hook: '這個 repo 有 pre-push hook，canopy 推送時不會執行它，請改用終端機推。',
    'worktree-block': '設定為不從面板推 worktree 分支。',
    'worktree-no-key': key => `worktree 分支，而這個 repo 的本地 git config 沒有用 ${key} 指名 remote。`,
  },
  pushSetting: '從面板推送',
  on: '開',
  off: '關',
  worktreePushSetting: 'worktree 分支',
  worktreePushOptions: { allow: '和一般分支一樣推', perRepo: '只推有設定的 repo', block: '不從面板推' },
  worktreePushKeySetting: '設定用的 git config key',
  worktreePushKeyHint: key => `repo 用這行指定：git config --local ${key} <remote>。之後 worktree 分支只推到那個 remote。`,
  protectedSetting: '受保護分支',
  protectedHint: '逗號分隔；推這些要確認兩次。remote 的預設分支一律受保護。',
  respectHooksSetting: '有 pre-push hook 的 repo',
  respectHooksOptions: { respect: '改用終端機推', skip: '照推（不執行 hook）' },
}

const TABLE: Record<Language, Strings> = { en, 'zh-TW': zhTW }

export function isLanguage(value: unknown): value is Language {
  return LANGUAGES.some(l => l.code === value)
}

export function strings(language: Language): Strings {
  return TABLE[language]
}
