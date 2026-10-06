# canopy — 開發指南

Claude Code mod：session 所在 repo 的 git 線圖。有未推 commit 時在輸入框上方
提示，點開面板看整棵樹。2026-10-06 起只有 mod 這一種形態，伺服器版（Go＋React
網頁面板）已淘汰，最後一版在 `841bce3`。對外發佈：repo 本身是 marketplace，
別人用 `/plugin marketplace add MiskaWu/canopy` 安裝（見 README）。

## 結構

```
.claude-plugin/marketplace.json   marketplace 定義，插件來源指 ./mod
mod/                       插件本體
  .claude-plugin/plugin.json      名稱、版本、userConfig（設定欄位）
  .claude-plugin/types/    引擎每次載入時寫入的型別（自帶 .gitignore，不要手改）
  hooks/hooks.json         → register.tsx
  hooks/register.tsx       提示列、面板（含設定區、推送區）、/canopy、重新整理排程、設定寫回、執行推送
  hooks/config.ts          userConfig → 有型別、有界限的 Config（預設值走最佳實踐）
  hooks/push.ts            推送政策（規則表）、組指令、選 remote：全是純函式
  hooks/i18n.ts            介面文字對照表（en、zh-TW），鍵由型別保證一致
  hooks/badges.ts          分支徽章：面板清單與線圖共用這一份
  hooks/git.ts             跑 git 組快照
  hooks/lanes.ts           lane 排版，含每條邊走哪一道（via）
  hooks/svg.ts             桌面版線圖：整張 SVG，深淺兩套配色
  hooks/textgraph.ts       終端機線圖：框線字元
  types/index.d.ts         $.state 契約
  tests/                   claude plugin test
  tsconfig.json            extends 引擎寫入的型別設定
docs/                      README 用的示範截圖（虛構資料）
.github/workflows/test.yml CI：npm 裝公開版 claude，跑 make test
```

插件放在 `mod/` 子目錄而不是 repo 根目錄：根目錄底下有 `.claude/worktrees/`，
整個 repo 當插件資料夾的話，每個 worktree 的檔案變動都會被引擎監看到。

使用者自己的機器是開發用安裝：`~/.claude/settings.json` 的 `CLAUDE_CODE_PLUGIN_DIRS`
指主 checkout 的 `mod/`，沒有透過 marketplace 裝。合併進 main 就是上線。

## 驗證

- **commit 前跑 `make test`**：validate marketplace 與 mod，再跑 `claude plugin test`。
  CI 跑的就是這條。
- **測試要用 2.1.288 以上的 claude**：2.1.281 的測試工具不會把
  `test(name, { options }, body)` 的設定值交給 mod，指定語言或 commit 數的測試
  會假失敗（2026-10-06 實測）。PATH 上的太舊就 `make test CLAUDE=<新版執行檔>`，
  Desktop 內建的在 `~/.claude/remote/ccd-cli/<版本>`。npm 上的公開版不必登入也能跑
  （2.1.291 實測），CI 靠這點。
- `make typecheck` 需要 `mod/.claude-plugin/types/`，引擎載入 mod 時才會寫：主
  checkout 那份被 settings 載入過就有，新開的 worktree 沒有。worktree 裡把一份
  已載入的 `types/` 整個複製過來即可（它被 gitignore）。
- **測試看的是 hook 與畫出來的樹，看不到實際長相**：
  - 終端機：用 tmux 開一個 `claude --plugin-dir <worktree>/mod`，送 `/canopy`，
    `tmux capture-pane` 看畫面；`ctrl+x tab` 把鍵盤交給面板後按 `s` 開設定區。
    使用者 settings 的 `CLAUDE_CODE_PLUGIN_DIRS` 也會載入主 checkout 那份，
    `--settings` 蓋不掉它，要靠 `--plugin-dir`。
  - 桌面版：只能請使用者在 Desktop 實看、截圖回來對。SVG 本身可以用 headless
    Chromium 包在 `<img>` 裡截圖檢查。
- **設定寫回（`$.config.set`）在真 session 驗過**（2026-10-06，使用者在 Desktop
  把語言切成繁中，寫進 settings.json 的 `pluginConfigs["canopy@inline"]`）。被拒絕時
  設定區會顯示原因，那是第一個看的地方。
- **真的推送只由使用者實測**：測試用假的 process.run 驗指令、參數與環境變數；
  開發時不要為了驗證去按確認推送真 repo。
- **`plugin test` 說「hooks modules are turned off … rollout switch was saved off」**：
  是本機快取的發布開關過期，不是測試壞了。照它說的開一次 claude（不送 prompt）
  刷新開關再跑；刷新後還是這句，才是 mod 真的被遠端關閉（2026-10-06 遇過，刷新即好）。
- marketplace 安裝可以在隔離的設定資料夾驗：`CLAUDE_CONFIG_DIR=<暫存> claude plugin
  marketplace add <repo>`、`plugin install canopy@canopy`。隔離資料夾沒登入，開不了
  session，所以「從 marketplace 載入後跑起來」沒有實測過。

## 不可違反的約束

- **預設只讀**：不 fetch、不寫 repo。唯一的寫入是使用者打開設定後、自己按下確認的
  `git push`。給別人裝的東西「預設只讀」是最容易被信任的一點，所以 `push` 預設關。
- **推送只能由人按按鈕觸發**：不註冊推送用的斜線指令或 tool（模型能代跑斜線指令），
  `/canopy` 不解析任何參數。mod 用 `$.process.run` 跑 git，**不經過 Bash 工具，所以
  使用者的推送防護 hook 管不到它**：一旦有路徑讓模型觸發推送，就等於繞過防護。
  tests 裡有「`/canopy push …` 不會推」的斷言。
- **推送指令由 `push.ts` 固定組成** `git push [-u] <remote> <branch>`：不接受任何旗標、
  永不 `--force`、remote 必須存在。確認時用最新快照重組，指令和畫面上顯示的不同就換新
  的、等再按一次。帶 `GIT_TERMINAL_PROMPT=0` 與 60 秒逾時。
- **推送政策是一張規則表**（`push.ts` 的 `RULES`），依序檢查、第一條擋下的就是理由。
  新增政策＝加一條規則與它的設定，不在呼叫端加分支。政策擋下的理由一定顯示給人看。
- **`$.process.run` 跑 git 時 repo 的 hook 不會執行**（引擎文件寫明）：所以預設對有
  pre-push hook 的 repo 不給推（`respectHooks`），偵測用 `rev-parse --git-path`，
  會照 `core.hooksPath` 解析。
- **`claude.worktreePushRemote` 只讀、永不寫**：和使用者的推送防護 hook 共用同一個
  key，用 `git config --local` 讀（不吃 global）。
- **git 一律帶 `GIT_OPTIONAL_LOCKS=0`**：`git status` 不搶 index.lock，不會卡到
  正在 commit 的 session。
- **範圍是 session 所在的 repo**（連同它所有 worktree），不掃整個目錄。
- **session 活性是盡力而為**：讀的是 Claude Code 自己的 `~/.claude/projects/`，
  讀不到（改版、Windows 沒有 HOME 時退到 USERPROFILE 也不行）就不顯示，不能報錯。
- **設定只有一份**：userConfig（settings.json 的 `pluginConfigs`）。面板設定區和
  `/config` 改的是同一份，寫回走 `$.config.set`，列的 key 從 `$.config.list()` 找
  （插件從哪裡載入會影響名字，`canopy`、`canopy@inline`、`canopy@canopy`），不自己拼。
  寫成功後引擎帶新值重載模組，所以 Config 在 `register` 開頭讀一次就好。
- **接收 `$` 的函式要宣告在檔案最上層**：validate 會擋把 `$` 傳給 `register` 內部
  閉包的寫法（例如 `openPane` 曾寫在裡面）。需要的設定與文字當參數傳進去。
- **介面文字只寫在 `i18n.ts`**：每種語言一份 `Strings`，型別保證鍵一致。新增語言＝
  加一份表、加進 `LANGUAGES` 與 plugin.json 的 `options`。
- **Svg 不開 `isInteractive`**：開了桌面版改用 iframe 畫，沒給高度就是 150px，
  整張圖被縮成一小塊（2026-10-06 實測）。tests 裡有斷言釘住。
- **SVG 根元素只給 `viewBox`，不給 width／height**：圖片就撐滿欄寬（Chromium 實測）。
  viewBox 寬度照 `bodyColumns × 7.8` 估（夾在 360–1600），估偏只影響字的大小。
  tests 裡有斷言釘住。
- **SVG 顏色全走 CSS 變數**：`auto` 主題用 `prefers-color-scheme` 切換深淺兩套，
  圖片模式下它跟著頁面的深淺色走（Chromium 實測）。介面上的 Text（分支清單、
  終端機線圖）不知道主題，用深淺底都讀得清楚的中間色（`laneColor`）。
- **Svg 的 source 上限 131072 字元**：`renderSvg` 超過就少畫幾列，面板會說明。
- **文字也畫在 SVG 裡**：介面的列高量不到，文字和線圖分開畫會對不齊。
- **提示列的 Button 不設 hotkey**：輸入框空著時按數字鍵會按到提示列的按鈕，
  會吃掉使用者打的數字。
- **提示列與面板的每一行是一段 `<Text>`**（內嵌上色片段），不要拆成 flex 的
  多個項目：面板窄的時候各自折行，會被擠成好幾欄（2026-10-06 實測）。
- **畫面讀的狀態放 `$.state`**（契約在 `types/index.d.ts`），不放模組變數：
  熱重載會把模組變數清掉。render hook 裡只讀不寫。
- **重新整理排到 dispatch 之外**（`$.clock.after`），不在 `turn.complete`、
  `tool.call` 裡 await git，免得拖住回合收尾與工具呼叫。同時只跑一輪，期間又有
  請求就跑完再補一輪。
- **lanes.ts 記 `via`**：第一父邊沿子節點那道往下、到父節點才彎；其餘父邊在合併點
  就彎進自己那道。文字線圖逐列畫格子需要它，SVG 也靠它不讓合併線疊在主線上。

## 發版

改 `mod/.claude-plugin/plugin.json` 與 `.claude-plugin/marketplace.json` 兩處的
`version`（兩處要一致），在 CHANGELOG 加一節。別人的 `/plugin` 更新看的是版本號。

## 視覺

沿用伺服器版 2026-08-26 拍板的定稿：lane 色票、分支色塊、線不被列分隔線切斷。
深色卡片底 `#151a20`，淺色 `#f6f8fa`；兩套色票與字型堆疊在 `svg.ts` 開頭。
README 的示範截圖（`docs/`）用虛構資料產生，改了配色要重截。
