// canopy mod 的狀態契約：快照是 session 所在 repo 的 git 現況，
// 由 hooks/git.ts 跑 git 組出來（對應 server/store.go 的 Snapshot）。

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
  builtAt: number // 毫秒
}

declare module 'claude-code' {
  interface PluginState {
    canopy: {
      snapshot: CanopySnapshot | null
      error: string | null
      dismissed: string | null // 使用者按掉提示時的狀態簽章，簽章變了提示才回來
      limit: number // 線圖畫幾筆 commit
    }
  }
}
