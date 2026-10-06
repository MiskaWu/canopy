# canopy

Claude Code 的 git 線圖 mod。

一次開好幾個 Claude Code session 平行工作時，每個 session 都在自己的 worktree
裡開分支，最想知道的就是「現在有幾條分支、各自走到哪、哪些還沒推」。canopy 把
session 所在 repo 的狀態直接放進 Claude Code：該推的時候在輸入框上方提醒你，
點一下就開出整棵樹。

## 它做什麼

- **輸入框上方的提示**：session 所在的分支有還沒推上 remote 的 commit 時才出現，
  例如 `↑3 claude/xxx 有 3 個 commit 不在任何 remote 上  [看線圖] [先不用]`。
  按「先不用」先收起來，分支再多一個 commit 才會回來。
- **線圖面板**：按「看線圖」或打 `/canopy`。上半是分支清單：未推數、落後數、
  在哪個 worktree、那個 worktree 的 Claude session 是否還在跑、有沒有未 commit
  的修改、是否已合併。下半是線圖：分岔與合併、分支標籤、remote 分支。
  桌面版畫成 SVG，終端機用框線字元畫。面板右上角的 ⤢ 可以放大。
- **自動更新**：回合結束、Claude 用 Bash 跑過 git，以及每 45 秒一次。
- **只讀**：不 fetch、不推、不改任何東西。

## 安裝

需求：Claude Code（function hooks 目前是 early access，要打開開關）、git。

在 `~/.claude/settings.json` 的 `env` 加上：

```json
"CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1",
"CLAUDE_CODE_PLUGIN_DIRS": "~/projects/canopy/mod"
```

之後新開的 session 都會載入。只想試一次的話，在終端機：

```bash
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir ~/projects/canopy/mod
```

移除：把上面兩行從 `env` 拿掉即可，mod 沒有在機器上留下其他東西。

## 開發

```bash
make test        # claude plugin validate ＋ claude plugin test
make typecheck   # tsc（需要 mod 被 Claude Code 載入過一次，型別由引擎寫入）
```

程式結構與不可違反的約束見 [CLAUDE.md](CLAUDE.md)。

## 歷史

canopy 最早（2026-08）是 Go 伺服器＋React 網頁面板：掃描整個 `~/projects`、
可以從面板推送，在 Claude Code Desktop 的瀏覽器面板裡開。2026-10-06 改成 mod，
伺服器版隨之淘汰。最後一個還有伺服器版的 commit 是 `841bce3`，需要時從那裡取回。
