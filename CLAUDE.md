# canopy — 開發指南

Claude Code mod：session 所在 repo 的 git 線圖。有未推 commit 時在輸入框上方
提示，點開面板看整棵樹。2026-10-06 起只有 mod 這一種形態，伺服器版（Go＋React
網頁面板）已淘汰，最後一版在 `841bce3`。

## 結構

```
mod/                       插件本體，CLAUDE_CODE_PLUGIN_DIRS 指這裡
  .claude-plugin/plugin.json
  .claude-plugin/types/    引擎每次載入時寫入的型別（自帶 .gitignore，不要手改）
  hooks/hooks.json         → register.tsx
  hooks/register.tsx       提示列、面板、/canopy 指令、重新整理的排程
  hooks/git.ts             跑 git 組快照
  hooks/lanes.ts           lane 排版，含每條邊走哪一道（via）
  hooks/svg.ts             桌面版線圖：整張畫成一份 SVG
  hooks/textgraph.ts       終端機線圖：框線字元
  types/index.d.ts         $.state 契約
  tests/                   claude plugin test
  tsconfig.json            extends 引擎寫入的型別設定
```

插件放在 `mod/` 子目錄而不是 repo 根目錄：根目錄底下有 `.claude/worktrees/`，
整個 repo 當插件資料夾的話，每個 worktree 的檔案變動都會被引擎監看到。

## 驗證

- **commit 前跑 `make test`**（validate ＋ `claude plugin test`）。這個 repo 沒有
  CI，這條就是全套。`claude plugin test` 要帶 `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`
  （function hooks 還是 early access），Makefile 已經帶了。
- `make typecheck` 需要 `mod/.claude-plugin/types/`，那是引擎載入 mod 時才寫的：
  主 checkout 那份被 settings 載入過就有，新開的 worktree 沒有。worktree 裡要查型別，
  用 plugin-authoring skill 給的型別檔另寫一份 tsconfig（放在 repo 外）。
- **測試看的是 mod 的 hook 與畫出來的樹，看不到桌面版實際長相**。介面上的事
  （寬度、換行、Svg 大小）只能請使用者在 Desktop 實看，截圖回來對。
- settings 載入的是主 checkout 的 `mod/`，worktree 裡的改動合併前不會生效。要在
  session 裡實測 worktree 的版本，用 plugin-authoring skill 的熱重載資料夾（把
  `mod/` 複製過去）；它和已載入的同名插件同時存在時的行為還沒驗證過。

## 不可違反的約束

- **只讀**：不 fetch、不推、不寫 repo。推送是使用者自己的事（以及 worktree 推送
  防護的事），mod 不碰。
- **git 一律帶 `GIT_OPTIONAL_LOCKS=0`**：`git status` 不搶 index.lock，不會卡到
  正在 commit 的 session。
- **範圍是 session 所在的 repo**（連同它所有 worktree），不掃整個 `~/projects`。
- **Svg 不開 `isInteractive`**：開了桌面版改用 iframe 畫，沒給高度就是 150px，
  整張圖被縮成一小塊（2026-10-06 實測）。圖片模式照原比例、寬度不超過欄位。
  tests 裡有斷言釘住。
- **Svg 的 source 上限 131072 字元**：`renderSvg` 超過就少畫幾列，面板會說明。
- **SVG 寬度＝`bodyColumns × 7.8` px**（夾在 360–1600）。7.8 是估的，Desktop 上
  沒量過；圖右邊空一大塊或字太小就是這個數不對。
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

## 視覺

沿用伺服器版 2026-08-26 拍板的定稿：深色卡片底（`#151a20`）、lane 色票
（`LANE_COLORS`）、分支色塊、線不被列分隔線切斷。色票與字型堆疊在 `svg.ts` 開頭。
