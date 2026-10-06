# canopy

Claude Code 裡的 git 線圖。[English](README.md)

一次開好幾個 Claude Code session 平行工作時，每個 session 都在自己的 worktree
裡開分支，最想知道的就是「現在有幾條分支、各自走到哪、哪些還沒推」。canopy
把答案直接放進 Claude Code：session 所在的分支有未推 commit 時，在輸入框上方
提醒你，點一下就開出整棵樹。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/graph-dark.png">
  <img alt="canopy 的線圖面板：三個 worktree 的分支、一次合併、未推 commit、進行中的 session 與未 commit 修改的徽章" src="docs/graph-light.png">
</picture>

<sub>畫面為虛構 repo 的示範資料。</sub>

## 它做什麼

- **輸入框上方的提示**：session 所在的分支有不在任何 remote 上的 commit 才出現，
  例如 `↑3 claude/search-api 有 3 個 commit 不在任何 remote 上  [看線圖] [先不用]`。
  按「先不用」先收起來，分支再多一個 commit 才會回來。
- **線圖面板**：按「看線圖」或打 `/canopy`。上半是 repo 的分支與狀態：未推數
  （`↑N`）、落後數（`↓N`）、在哪個 worktree、那個 worktree 的 Claude session
  是否還在跑、有沒有未 commit 的修改、是否已併進主 worktree 的分支。下半是線圖：
  分岔與合併、分支標籤、remote 分支。面板右上角的 ⤢ 可以放大。
- **自動更新**：每個回合結束、Claude 跑過 git 指令之後，以及定時。
- **只讀**：只在本機跑 `git` 看狀態，不 fetch、不推、不寫任何東西。

終端機裡的面板用框線字元畫線圖（見英文 README 的範例）。

## 安裝

需求：Claude Code **2.1.288 以上**、git。canopy 是一個 *mod*（function hooks 寫成的
插件），Claude Code 目前還以 early access 提供，要先在 `~/.claude/settings.json`
的 `env` 打開：

```json
"CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1"
```

接著在 Claude Code 裡：

```
/plugin marketplace add MiskaWu/canopy
/plugin install canopy@canopy
```

或在 shell：

```bash
claude plugin marketplace add MiskaWu/canopy && claude plugin install canopy@canopy
```

之後新開的 session 都會載入，打 `/canopy` 開面板。

## 設定

打開面板按「設定」，同一組值也在 `/config` 裡。

| 設定 | 預設 | |
|---|---|---|
| 語言 | English | English 或繁體中文 |
| 自動更新 | 每 45 秒 | 0 是關閉計時；回合結束與跑過 git 之後照樣會更新 |
| 線圖 commit 數 | 80 | 面板的「更多 commit」每按一次再多一份，最多 400 |
| 線圖主題 | 跟隨介面 | 或固定深色、固定淺色 |

## 它讀了什麼

- session 工作目錄裡的 `git`：ref、worktree 清單、每個 worktree 的 `git status`、
  log。每次都帶 `GIT_OPTIONAL_LOCKS=0`，查狀態時不會搶走正在 commit 的 session
  要用的 index 鎖。
- `~/.claude/projects/` 裡對話記錄的修改時間，用來顯示「session 進行中」。這是
  Claude Code 自己的儲存方式，改版就可能變；讀不到時那個徽章就不顯示。

不會有任何資料離開你的電腦。

## 限制

- 線圖畫的是所有分支裡最新的那些 commit。很久以前分出去、之後沒動過的分支可能
  落在範圍外：分支清單裡還看得到，按「更多 commit」可以往回畫。
- 插件 API 還是 early access，每個 Claude Code 版本都可能變；canopy 以上面寫的
  版本測過。

## 開發

```bash
make test                         # 驗證 marketplace 與 mod，再跑測試
make test CLAUDE=/path/to/claude  # PATH 上的 claude 比 2.1.288 舊的時候
make typecheck                    # tsc，需要 Claude Code 載入過 mod、寫好型別
```

要改 canopy 本身，就讓 Claude Code 載入你的 clone 而不是安裝的那份：在
`~/.claude/settings.json` 的 `env` 加上 `"CLAUDE_CODE_PLUGIN_DIRS": "/path/to/canopy/mod"`
（並解除安裝 `canopy@canopy`，免得兩份同名衝突）。

repo 本身就是 marketplace（`.claude-plugin/marketplace.json`），插件在 `mod/`。
版本紀錄見 [CHANGELOG.md](CHANGELOG.md)。

## 歷史

canopy 2026-08 起原本是 Go 伺服器＋React 網頁面板：掃描整個 `~/projects`、可以從
面板推送。2026-10 改成這個 mod，伺服器版隨之淘汰，最後一版在 `841bce3`。

## 授權

[MIT](LICENSE)
