// canopy 的狀態契約：快照是 session 所在 repo 的 git 現況，
// 由 hooks/git.ts 跑 git 組出來（對應伺服器版 store.go 的 Snapshot）。

export type CanopySession = {
  isLive: boolean
  lastActive: number // unix 秒
}

export type CanopyWorktree = {
  path: string
  name: string
  isMain: boolean
  isDirty: boolean
  session: CanopySession | null
}

export type CanopyBranch = {
  name: string
  sha: string
  upstream: string | null
  ahead: number // 有 upstream：領先 upstream；沒有：不在任何 remote 上的 commit 數
  behind: number
  noUpstream: boolean
  gone: boolean
  merged: boolean // 已包含進主 worktree 的分支
  isCurrent: boolean // session 所在 worktree 的分支
  worktree: CanopyWorktree | null
}

export type CanopyCommit = {
  sha: string
  parents: string[]
  time: number // unix 秒
  refs: string[]
  author: string
  subject: string
}

export type CanopySnapshot = {
  repoName: string
  repoPath: string
  cwdBranch: string
  headSha: string
  mainBranch: string
  noRemote: boolean
  remotes: string[]
  branches: CanopyBranch[]
  commits: CanopyCommit[]
  defaultBranch: string | null // origin/HEAD 指的分支，一律視為受保護
  worktreePushRemote: string | null // repo 本地 git config 的 claude.worktreePushRemote（只讀）
  hasPrePushHook: boolean // 有作用中的 pre-push hook（含 core.hooksPath）
  builtAt: number // 毫秒
}

/** 按下推送按鈕後、確認前的計畫：指令由 mod 組成，畫面上照實顯示。 */
export type CanopyPushIntent = {
  branch: string
  remote: string
  args: string[] // git 之後的參數，例如 ["push", "-u", "origin", "feat"]
  commits: { sha: string; subject: string }[]
  total: number // 要推的 commit 總數（清單最多列 10 筆）
  isProtected: boolean
  isArmed: boolean // 受保護分支按過第一次確認
}

export type CanopyPushResult = {
  branch: string
  remote: string
  isOk: boolean
  output: string
}

declare module 'claude-code' {
  interface PluginState {
    canopy: {
      snapshot: CanopySnapshot | null
      error: string | null
      dismissed: string | null // 使用者按掉提示時的狀態簽章，簽章變了提示才回來
      extra: number // 「更多 commit」按過幾次；畫的筆數＝設定的 commits ×（1＋extra）
      isSettingsOpen: boolean // 面板裡的設定區是否展開
      settingsError: string | null // 上一次寫入設定被拒絕的原因
      pushIntent: CanopyPushIntent | null
      isPushing: boolean
      pushResult: CanopyPushResult | null
    }
  }
}
