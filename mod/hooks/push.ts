import type { CanopyBranch, CanopySnapshot } from '../types'
import type { Config } from './config'

// 從面板推送：判斷、預覽、組指令。執行在 register.tsx（要用 $），這裡全是純函式。
//
// 安全底線（不開放設定）：
// - 只有人按按鈕才會推：mod 不註冊推送用的斜線指令或 tool，模型沒有路徑觸發它。
// - 指令固定由這裡組成 `git push [-u] <remote> <branch>`，沒有任何旗標從外面進來，永不強推。
// - remote 必須是 repo 裡存在的；分支必須是快照裡的本地分支。
//
// 可設定的政策（預設值走最佳實踐，見 config.ts）寫成下面這張規則表，依序檢查，
// 第一條擋下的就是理由；新增政策＝加一條規則，不在呼叫端加分支。

export type BlockReason = 'off' | 'no-remote' | 'nothing' | 'hook' | 'worktree-block' | 'worktree-no-key'

/** 政策擋下的理由（要讓人看到原因的那些）；其餘只是「沒東西可推」或「功能沒開」。 */
export type PolicyReason = Extract<BlockReason, 'hook' | 'worktree-block' | 'worktree-no-key'>

export function isPolicyReason(reason: BlockReason | undefined): reason is PolicyReason {
  return reason === 'hook' || reason === 'worktree-block' || reason === 'worktree-no-key'
}

export type PushPlan = {
  branch: string
  remote: string
  args: string[]
  isProtected: boolean
  isWorktree: boolean
  range: string[] // 預覽要推哪些 commit 的 git log 範圍
}

export type PushCheck = { isAllowed: true; plan: PushPlan } | { isAllowed: false; reason: BlockReason }

type Facts = { snap: CanopySnapshot; branch: CanopyBranch; cfg: Config; isWorktree: boolean }

const RULES: readonly { reason: BlockReason; blocks: (f: Facts) => boolean }[] = [
  { reason: 'off', blocks: f => !f.cfg.push },
  { reason: 'no-remote', blocks: f => f.snap.noRemote },
  { reason: 'nothing', blocks: f => f.branch.ahead === 0 },
  { reason: 'hook', blocks: f => f.snap.hasPrePushHook && f.cfg.respectHooks },
  { reason: 'worktree-block', blocks: f => f.isWorktree && f.cfg.worktreePush === 'block' },
  {
    reason: 'worktree-no-key',
    blocks: f => f.isWorktree && f.cfg.worktreePush === 'allowKey' && !f.snap.remotes.includes(f.snap.worktreePushRemote ?? ''),
  },
]

/** 這條分支能不能從面板推；能的話連指令一起給。 */
export function planPush(snap: CanopySnapshot, branchName: string, cfg: Config): PushCheck | null {
  const branch = snap.branches.find(b => b.name === branchName)
  if (branch === undefined) return null
  const isWorktree = branch.worktree !== null && !branch.worktree.isMain
  const facts: Facts = { snap, branch, cfg, isWorktree }
  const blocked = RULES.find(rule => rule.blocks(facts))
  if (blocked !== undefined) return { isAllowed: false, reason: blocked.reason }

  const remote = chooseRemote(snap, branch, cfg, isWorktree)
  const needsUpstream = branch.noUpstream || branch.gone
  const args = ['push', ...(needsUpstream ? ['-u'] : []), remote, branch.name]
  const protectedSet = new Set([...cfg.protectedBranches, ...(snap.defaultBranch === null ? [] : [snap.defaultBranch])])
  const range = needsUpstream || branch.upstream === null
    ? [`refs/heads/${branch.name}`, '--not', '--remotes']
    : [`${branch.upstream}..refs/heads/${branch.name}`]
  return { isAllowed: true, plan: { branch: branch.name, remote, args, isProtected: protectedSet.has(branch.name), isWorktree, range } }
}

/**
 * 推到哪個 remote：worktree 分支在 allowKey 政策下只推到 claude.worktreePushRemote；
 * 其餘照 upstream 的 remote，沒有 upstream 就 origin，再沒有就第一個 remote。
 */
function chooseRemote(snap: CanopySnapshot, branch: CanopyBranch, cfg: Config, isWorktree: boolean): string {
  if (isWorktree && cfg.worktreePush === 'allowKey' && snap.worktreePushRemote !== null) return snap.worktreePushRemote
  const upstreamRemote = branch.upstream === null ? undefined : snap.remotes.find(r => branch.upstream?.startsWith(`${r}/`))
  return upstreamRemote ?? (snap.remotes.includes('origin') ? 'origin' : (snap.remotes[0] as string))
}

/** 可以列出推送按鈕的分支：有未推 commit 的，session 所在的那條排最前面。 */
export function pushCandidates(snap: CanopySnapshot): CanopyBranch[] {
  return snap.branches.filter(b => b.ahead > 0).sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || a.name.localeCompare(b.name))
}

/** git push 的輸出：去掉空行與純進度行，留最後幾行（remote 給的連結通常在裡面）。 */
export function tidyOutput(text: string, keep = 8): string {
  const lines = text
    .split(/\r?\n|\r/)
    .map(line => line.trimEnd())
    .filter(line => line !== '' && !/^(Enumerating|Counting|Delta compression|Compressing|Writing) objects/.test(line) && !/^Total \d+/.test(line))
  return lines.slice(-keep).join('\n')
}
