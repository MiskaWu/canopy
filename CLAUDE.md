# canopy — 開發指南

本機 git 線圖面板：Go 後端掃描/監看所有 repo，React 前端畫線圖，可從面板推送。
產物是單一 binary（前端以 go:embed 內嵌）。

## 結構與建置

```
server/   Go：main.go(wiring/embed) store.go(掃描/快照) watch.go(inotify/背景迴圈) api.go(HTTP/SSE/push)
          mockup.html(視覺定稿) diag.html(面板能力診斷) dist/(web build 產物，gitignored)
web/      Vite + React + TS：src/{App,Graph,PushDialog}.tsx lanes.ts(lane演算法) api.ts types.ts
deploy/   canopy.service（systemd user unit）
```

- `make` = web build → `cp web/dist server/dist` → `go vet` + `go build -o canopy ./server`。
- `make install` 部署並重啟 systemd user unit。
- 前端單獨開發：`cd web && npm run dev`（vite 會 proxy /api 到 127.0.0.1:7777）。
- Go 端沒 dist 會編譯失敗（embed），先跑過一次 `make web`。

## 最重要的環境約束：Desktop 面板殼

這個工具的主要宿主是 Claude Code Desktop 的瀏覽器面板。**2026-08-27 在面板內逐項
重測（/diag），結論和先前記載的相反：被擋的不是面板，是 nip.io 那個網址。**

- **面板只吃 nip.io 連結**。assistant 訊息裡的 `http://127-0-0-1.nip.io:7777`
  會在面板內開啟；`http://127.0.0.1:7777`、`http://localhost:7777` 都會被丟給系統
  預設瀏覽器（認法：/diag 的 userAgent 有 `Claude/…MSIX` 才是面板）。
- **但從 nip.io 載入的頁面，子資源請求全滅**：fetch（同源也一樣）、EventSource、
  img、script src、外部 CSS 一律失敗。原因是 Chromium 的 DNS rebinding 防護——
  nip.io 是「公開網域解析到私有位址」，正是它盯的目標（main.log：
  `Blocked subresource to private-resolving host`）。判斷依據是**頁面自己的來源**，
  不是請求的目標：從 127.0.0.1 那頁反過來要 nip.io 的資料是通的。頂層導航不受影響。
- **換到 127.0.0.1 就全通**：fetch、POST、EventSource、img、script src，連外部網域
  （fonts.googleapis.com）都 PASS。
- **跳過去只能靠頁面內導航**。index.html 的第一段 script 判斷 hostname 含 nip.io
  就 `location.replace()` 到 127.0.0.1。**伺服器 302 不行**，面板會判定成外部連結
  丟給系統瀏覽器（兩種都實測過）。那段 script 必須留在 head 最前面，趕在瀏覽器
  開始抓字型等資產之前跳走。

所以正常路徑是：使用者點 nip.io 連結，面板開啟，頁面自己跳到 127.0.0.1，
之後走 live 模式（fetch + SSE），不重載也不閃。

由此推出三條**不可違反的鐵律**：

1. **跳轉失敗必須還能用**。static 模式是那條退路，不是遺跡：任何新功能都要在它
   底下可用。它的手段只有三種——資料由伺服器嵌進 HTML（`window.__DATA__`，見
   api.go 的 `makeIndexHandler`）、UI 狀態放 URL query（`f`/`open`/`pin`）、
   互動用 `<a>` 連結或表單 POST（成敗都 303 回首頁帶 `pushed`/`pushErr` query）。
   模式由開頁時的 fetch 探測決定（api.ts `probeNetwork`）。
2. **前端維持單檔自包含**（vite-plugin-singlefile）。跳轉失敗時停在 nip.io，
   那裡什麼外部資產都拿不到，單檔是唯一還能完整渲染的形態。唯一的例外是
   index.html 那行 Google Fonts：它在 127.0.0.1 底下載得到（實測 PASS），
   跳轉失敗時就退回系統字型堆疊——那是可接受的降級，不是壞掉。
3. **第一次繪製就必須是完整畫面**。static 退路每 10 秒整頁重載，那時首次繪製不是
   載入過程而是使用者實際看到的畫面；live 模式雖然不重載，開頁那一次同樣受益。
   靠 vite.config.ts 的 `blockingInlineScript`：把打包格式壓成 IIFE、script 標籤降成
   同步、位置搬到 `#root` 之後，React 才會在首次繪製前掛載完。**改回 `type="module"`
   就等於改回 defer，「載入中」那一幀會立刻回來。**

   static 退路另外靠兩個機制維持連續性，改動時別拆：App.tsx 的 `rememberedMode()`
   先用記得的模式開場（探測要一次往返，首幀等不了；localStorage 按來源分開，
   nip.io 與 127.0.0.1 各記各的），以及 `stashScroll()`／`pendingScroll` 在自動重載
   前後保住捲動位置。

## 架構不變量

- **git 是唯一真相來源**，伺服器只有記憶體內快照，沒有自己的持久狀態。
- **掃描去重**（store.go `discover`）：以 `git rev-parse --git-common-dir` 絕對路徑為鍵。
  common 以 `.git` 結尾＝一般 repo（主路徑取其上層）；否則是 submodule（主路徑＝發現
  它的 checkout 位置）。common 含 `/.git/worktrees/` ＝ worktree 私有 submodule 副本，
  跳過。`.claude/` 整棵不走訪（linked worktree 由主 repo 的 worktree list 進快照）。
- **監看**（watch.go）：fsnotify 不支援遞迴——refs/ 與 worktrees/ 底下要走訪掛點、
  Create 出新目錄要補掛。事件 debounce 300ms、`.lock` 檔跳過。髒污與 session 活性
  走 60s 慢輪詢（rebuild 後摘要沒變不廣播）。
- **推送安全**（api.go `handlePush`）：指令固定由伺服器組成
  `git push [-u] <remote> <branch>`，**前端永遠傳不進任何旗標**；remote 必須存在於
  該 repo；main/master 需要 `confirmMain`；Origin 白名單含 nip.io 兩種寫法與
  localhost（見 `originAllowed`），無 Origin（curl）放行。改動這段時不得放寬這些。
- **雙模共用一份元件**：Graph.tsx 是純渲染；App.tsx 依 `isStatic` 決定互動元素是
  連結還是 onClick。改 UI 時兩條路都要接。
- **static 模式的重載只在看得見時發生**：分頁被藏起來就跳過，切回來且資料已超過
  `RELOAD_MS` 才補一次。推送框開著時整個暫停。
- **退路的觸發與表現**（2026-08-27）：跳到 127.0.0.1 這件事踩在一個本專案控制不了
  的行為上——面板肯不肯讓頁面自己導航過去。哪天 Desktop 改版不肯了，使用者就停在
  nip.io，`probeNetwork` 探測失敗，前端自動退回 static：資料改由伺服器嵌進 HTML、
  每 10 秒整頁重載、互動走連結與表單 POST、字型退回系統字型堆疊。**功能一項不缺，
  代價是重載看得見。** 怎麼分辨：右上角「資料 N 秒前 ⟳」是 static，綠點「即時」
  是 live。看到前者不代表壞了，代表退路正在生效。

## 視覺定稿（勿隨手改）

`/mockup` 是 2026-08-26 與使用者拍板的設計基準：

- 線圖的線**不可被任何東西切斷**：列分隔線從文字區開始（`--gx`），SVG z-index 在列之上。
- 推送按鈕是分支色塊旁的 `↑N`（N＝未推 commit 數），狀態即動作，不另設未推徽章。
- 字型：Inter + Noto Sans TC 內文、JetBrains Mono 給 SHA/分支名/數字。
  深色定調（面板環境），色票在 styles.css `:root`。

## 驗證手段

- `curl http://127.0.0.1:7777/api/repos | python3 -m json.tool` 看摘要。
- `curl "http://127.0.0.1:7777/?open=<id>"` 檢查嵌入的 `window.__DATA__`。
- SSE 全鏈：開著 `curl -N /api/events`，**連上就該立刻收到 header 與 `: open`**
  （沒有這行等於 header 沒沖出去，客戶端會卡在 CONNECTING 直到下一個事件或 25 秒
  後的心跳）；接著在任一 repo commit，應在 1 秒內收到事件。只測「有事件」會漏掉
  安靜時段連不上的情況——2026-08-27 就是這樣漏掉的。
- 面板端行為只能請使用者實測；`/diag` 頁自動輸出該環境的能力清單（fetch 四種寫法、
  POST、img、script src、EventSource、外部 CSS，外加三顆手動按的導航測試）。
  **請使用者測時要給 `http://127-0-0-1.nip.io:7777/tolocal?via=js`**——直接給
  127.0.0.1 的連結會開在系統瀏覽器，測到的不是面板。看 userAgent 有沒有
  `Claude/…MSIX` 就能分辨。
- 推送端點測錯誤路徑就好（不存在的 remote/branch），不要對真 repo 測成功路徑。
