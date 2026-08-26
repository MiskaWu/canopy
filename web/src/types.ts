// 與 server/store.go 的 JSON 模型一一對應。

export interface SessionInfo {
  state: 'live' | 'idle'
  lastActive: number
}

export interface WorktreeInfo {
  path: string
  name: string
  main: boolean
  dirty: boolean
  session?: SessionInfo
}

export interface Branch {
  name: string
  sha: string
  upstream?: string
  ahead: number
  behind: number
  noUpstream: boolean
  gone: boolean
  merged: boolean
  isHead: boolean
  worktree?: WorktreeInfo
}

export interface Commit {
  sha: string
  parents: string[] | null
  time: number
  refs: string[] | null
  subject: string
}

export interface Snapshot {
  id: string
  name: string
  path: string
  headBranch: string
  headSha: string
  noRemote: boolean
  remotes: string[] | null
  commits: Commit[] | null
  branches: Branch[] | null
  builtAt: number
}

export interface Summary {
  id: string
  name: string
  headBranch: string
  worktrees: number
  branches: number
  dirty: number
  aheadTotal: number
  diverged: number
  noUpstream: number
  mergedOpen: number
  sessionLive: boolean
  lastCommit: number
  noRemote: boolean
  active: boolean
}

export interface ReposResponse {
  root: string
  lastFetch: number
  repos: Summary[] | null
}

export interface PushPreview {
  commits: { sha: string; subject: string }[] | null
  noUpstream: boolean
  upstream: string
  remote: string
}
