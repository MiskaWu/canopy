import type { PluginOptions } from 'claude-code'

import { isLanguage, type Language } from './i18n'

// 使用者設定：plugin.json 的 userConfig 宣告欄位，/config 與面板的設定區寫同一份
// （settings.json 的 pluginConfigs）。這裡把引擎給的 options 收成有型別、有界限的值。

export type GraphTheme = 'auto' | 'dark' | 'light'

export type Config = {
  language: Language
  refreshSeconds: number // 0＝不開背景計時
  commits: number
  graphTheme: GraphTheme
}

export const DEFAULTS: Config = { language: 'en', refreshSeconds: 45, commits: 80, graphTheme: 'auto' }

export const MIN_REFRESH_SECONDS = 10
export const MAX_COMMITS = 400

// 面板設定區的選項；目前值不在清單裡（例如在 /config 手填）就併進去顯示
export const REFRESH_CHOICES = [0, 15, 30, 45, 60, 120, 300]
export const COMMIT_CHOICES = [40, 80, 160, 300]
export const THEMES: readonly GraphTheme[] = ['auto', 'dark', 'light']

/** userConfig 欄位名，寫回時的 key 是 `<plugin>.<field>`。 */
export type ConfigField = keyof Config

export function readConfig(options: PluginOptions): Config {
  const num = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)
  const refresh = Math.round(num(options.refreshSeconds, DEFAULTS.refreshSeconds))
  const theme = THEMES.find(t => t === options.graphTheme)
  return {
    language: isLanguage(options.language) ? options.language : DEFAULTS.language,
    refreshSeconds: refresh <= 0 ? 0 : Math.max(MIN_REFRESH_SECONDS, refresh),
    commits: Math.min(MAX_COMMITS, Math.max(10, Math.round(num(options.commits, DEFAULTS.commits)))),
    graphTheme: theme ?? DEFAULTS.graphTheme,
  }
}

export function withCurrent(list: readonly number[], current: number): number[] {
  return list.includes(current) ? [...list] : [...list, current].sort((a, b) => a - b)
}
