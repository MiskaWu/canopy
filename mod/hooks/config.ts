import type { PluginOptions } from 'claude-code'

import { isLanguage, type Language } from './i18n'

// 使用者設定：plugin.json 的 userConfig 宣告欄位，/config 與面板的設定區寫同一份
// （settings.json 的 pluginConfigs）。這裡把引擎給的 options 收成有型別、有界限的值。
// 預設值走最佳實踐：推送預設關（最小權限）、受保護分支要二次確認、有 pre-push hook 不推。

export type GraphTheme = 'auto' | 'dark' | 'light'

/** worktree 分支能不能從面板推：照一般分支、只推到 claude.worktreePushRemote 指的 remote、不推。 */
export type WorktreePush = 'allow' | 'allowKey' | 'block'

export type Config = {
  language: Language
  refreshSeconds: number // 0＝不開背景計時
  commits: number
  graphTheme: GraphTheme
  push: boolean
  worktreePush: WorktreePush
  protectedBranches: string[]
  respectHooks: boolean
}

export const DEFAULTS: Config = {
  language: 'en',
  refreshSeconds: 45,
  commits: 80,
  graphTheme: 'auto',
  push: false,
  worktreePush: 'allow',
  protectedBranches: ['main', 'master'],
  respectHooks: true,
}

export const MIN_REFRESH_SECONDS = 10
export const MAX_COMMITS = 400

// 面板設定區的選項；目前值不在清單裡（例如在 /config 手填）就併進去顯示
export const REFRESH_CHOICES = [0, 15, 30, 45, 60, 120, 300]
export const COMMIT_CHOICES = [40, 80, 160, 300]
export const THEMES: readonly GraphTheme[] = ['auto', 'dark', 'light']
export const WORKTREE_PUSH: readonly WorktreePush[] = ['allow', 'allowKey', 'block']

/** userConfig 欄位名，寫回時的 key 是 `<plugin>.<field>`。 */
export type ConfigField = keyof Config

export function parseBranchList(text: string): string[] {
  return [...new Set(text.split(',').map(s => s.trim()).filter(s => s !== ''))]
}

export function readConfig(options: PluginOptions): Config {
  const num = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)
  const bool = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback)
  const refresh = Math.round(num(options.refreshSeconds, DEFAULTS.refreshSeconds))
  return {
    language: isLanguage(options.language) ? options.language : DEFAULTS.language,
    refreshSeconds: refresh <= 0 ? 0 : Math.max(MIN_REFRESH_SECONDS, refresh),
    commits: Math.min(MAX_COMMITS, Math.max(10, Math.round(num(options.commits, DEFAULTS.commits)))),
    graphTheme: THEMES.find(t => t === options.graphTheme) ?? DEFAULTS.graphTheme,
    push: bool(options.push, DEFAULTS.push),
    worktreePush: WORKTREE_PUSH.find(w => w === options.worktreePush) ?? DEFAULTS.worktreePush,
    protectedBranches: typeof options.protectedBranches === 'string' ? parseBranchList(options.protectedBranches) : DEFAULTS.protectedBranches,
    respectHooks: bool(options.respectHooks, DEFAULTS.respectHooks),
  }
}

export function withCurrent(list: readonly number[], current: number): number[] {
  return list.includes(current) ? [...list] : [...list, current].sort((a, b) => a - b)
}
