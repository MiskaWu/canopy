import type { CanopyBranch, CanopySnapshot } from '../types'
import type { Strings } from './i18n'

// 分支旁的狀態徽章：面板清單與線圖共用這一份，各自只決定怎麼上色。

export type BadgeKind = 'push' | 'info' | 'dirty' | 'diverged' | 'ok' | 'mute'

export type Badge = { text: string; kind: BadgeKind; isMono?: boolean }

export function ago(unixSeconds: number, nowMs: number): string {
  const s = Math.max(1, Math.floor(nowMs / 1000 - unixSeconds))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

/** worktree 徽章：資料夾名跟分支名最後一段一樣就不重複寫（claude/xxx 開在 worktrees/xxx 是常態）。 */
export function worktreeLabel(b: CanopyBranch, t: Strings): string {
  const name = b.worktree?.name ?? ''
  return name === b.name.split('/').pop() ? `⌂ ${t.worktree}` : `⌂ ${name}`
}

export function branchBadges(b: CanopyBranch, snap: CanopySnapshot, t: Strings, nowMs: number): Badge[] {
  const out: Badge[] = []
  const wt = b.worktree
  if (!snap.noRemote && b.ahead > 0) out.push({ text: `↑${b.ahead}`, kind: 'push', isMono: true })
  if (b.behind > 0) out.push({ text: `↓${b.behind}`, kind: 'mute', isMono: true })
  if (wt !== null && !wt.isMain) out.push({ text: worktreeLabel(b, t), kind: 'mute' })
  if (wt?.session) {
    out.push(wt.session.isLive ? { text: t.live, kind: 'ok' } : { text: `○ ${ago(wt.session.lastActive, nowMs)}`, kind: 'mute', isMono: true })
  }
  if (wt?.isDirty) out.push({ text: t.dirty, kind: 'dirty' })
  if (b.noUpstream && !snap.noRemote) out.push({ text: t.noUpstream, kind: 'info' })
  if (b.gone) out.push({ text: t.gone, kind: 'mute' })
  if (b.ahead > 0 && b.behind > 0) out.push({ text: t.diverged, kind: 'diverged' })
  if (b.merged && !b.isCurrent && !(wt?.isMain ?? false)) out.push({ text: t.merged, kind: 'ok' })
  return out
}
