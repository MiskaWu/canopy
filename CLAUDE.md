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

這個工具的主要宿主是 Claude Code Desktop 的瀏覽器面板（經
`http://127-0-0-1.nip.io:7777` 開啟）。該殼的規則（2026-08-26 以 /diag 實測、
main.log 證實為 DNS rebinding 防護 `Blocked subresource to private-resolving host`）：

- **頂層文件導航全通**：連結、表單 POST 都會讓 App 重新代抓一份文件，Origin header 保留。
- **頁面執行期的所有網路請求全滅**：fetch（同源也一樣）、EventSource、img/script
  子資源、Google Fonts，一律 Failed to fetch。

由此推出兩條**不可違反的鐵律**：

1. **前端必須維持單檔自包含**（vite-plugin-singlefile）。任何外部資產引用在面板裡
   直接消失。新增依賴時確認它會被 inline。
2. **任何新功能必須在 static 模式下可用**。live 模式（fetch+SSE）只是增強，不是基準。
   static 模式的手段只有三種：資料由伺服器嵌進 HTML（`window.__DATA__`，見
   api.go 的 `makeIndexHandler`）、UI 狀態放 URL query（`f`/`open`/`pin`）、
   互動用 `<a>` 連結或表單 POST（成敗都 303 回首頁帶 `pushed`/`pushErr` query）。
   模式由開頁時的 fetch 探測決定（api.ts `probeNetwork`）。

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

## 視覺定稿（勿隨手改）

`/mockup` 是 2026-08-26 與使用者拍板的設計基準：

- 線圖的線**不可被任何東西切斷**：列分隔線從文字區開始（`--gx`），SVG z-index 在列之上。
- 推送按鈕是分支色塊旁的 `↑N`（N＝未推 commit 數），狀態即動作，不另設未推徽章。
- 字型：Inter + Noto Sans TC 內文、JetBrains Mono 給 SHA/分支名/數字。
  深色定調（面板環境），色票在 styles.css `:root`。

## 驗證手段

- `curl http://127.0.0.1:7777/api/repos | python3 -m json.tool` 看摘要。
- `curl "http://127.0.0.1:7777/?open=<id>"` 檢查嵌入的 `window.__DATA__`。
- SSE 全鏈：開著 `curl -N /api/events`，在任一 repo commit，應在 1 秒內收到事件。
- 面板端行為只能請使用者實測；`/diag` 頁自動輸出該環境的能力清單。
- 推送端點測錯誤路徑就好（不存在的 remote/branch），不要對真 repo 測成功路徑。
