// canopy：本機 git 線圖面板。
// 掃描 root 底下所有 repo（worktree 以 git-common-dir 去重），
// inotify 盯 refs、SSE 推播、定期 fetch，前端（web/，go:embed 進 binary）畫線圖。
package main

import (
	"embed"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/gin-gonic/gin"
)

//go:embed mockup.html
var mockupHTML []byte

//go:embed diag.html
var diagHTML []byte

// 1x1 透明 PNG，診斷頁測 <img> 子資源用
var diagPNG = []byte{
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
	0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0xfc, 0xff, 0xff, 0x3f,
	0x03, 0x00, 0x08, 0xfc, 0x02, 0xfe, 0xa7, 0x35, 0x81, 0x84, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
	0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
}

//go:embed all:dist
var webDist embed.FS

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func main() {
	home, _ := os.UserHomeDir()
	root := flag.String("root", envOr("GITGRAPH_ROOT", filepath.Join(home, "projects")), "掃描根目錄")
	addr := flag.String("addr", envOr("GITGRAPH_ADDR", "127.0.0.1:7777"), "監聽位址")
	fetchEvery := flag.Duration("fetch-interval", 5*time.Minute, "自動 fetch 間隔（0 停用）")
	flag.Parse()

	hub := newHub()
	store := newStore(*root, hub)
	watcher, err := newWatcher(store)
	if err != nil {
		log.Fatal(err)
	}

	// 初始掃描丟背景跑，服務先開門；前端靠 SSE 看著 repo 逐一亮起來
	go func() {
		for _, id := range store.discover() {
			if r := store.repo(id); r != nil {
				watcher.watchRepo(r)
			}
			store.rebuild(id)
		}
	}()
	go watcher.loop()
	go store.fetchLoop(*fetchEvery)
	go store.slowLoop()
	go store.rescanLoop(watcher)

	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Recovery())

	r.GET("/api/repos", store.handleRepos)
	r.GET("/api/repo", store.handleRepo)
	r.GET("/api/push-preview", store.handlePushPreview)
	r.POST("/api/push", store.handlePush)
	r.GET("/api/events", hub.handleSSE)
	r.GET("/mockup", func(c *gin.Context) {
		c.Data(200, "text/html; charset=utf-8", mockupHTML)
	})
	r.GET("/diag", func(c *gin.Context) {
		c.Data(200, "text/html; charset=utf-8", diagHTML)
	})
	// 診斷頁會用 GET 和 POST 兩種方法打這個端點，不限方法
	r.Any("/api/diag", func(c *gin.Context) {
		c.Header("Access-Control-Allow-Origin", "*")
		c.String(200, "diag ok method=%s origin=%q", c.Request.Method, c.GetHeader("Origin"))
	})
	r.GET("/api/diag.png", func(c *gin.Context) {
		c.Data(200, "image/png", diagPNG)
	})
	r.GET("/api/diag.js", func(c *gin.Context) {
		c.Data(200, "text/javascript", []byte("window.__diagjs='loaded'"))
	})

	// 單檔前端 + 資料嵌入：每次載入首頁時把摘要與展開中 repo 的快照
	// 直接寫進 HTML（面板的殼執行期沒有網路，這是它唯一的資料通道）
	indexHTML, err := webDist.ReadFile("dist/index.html")
	if err != nil {
		log.Fatal(err)
	}
	r.GET("/", store.makeIndexHandler(indexHTML))
	// 不認得的路徑一律回首頁（沿用 mux 時代 "/" 兜底的行為）
	r.NoRoute(func(c *gin.Context) {
		c.Redirect(http.StatusFound, "/")
	})

	fmt.Printf("canopy listening on http://%s (root=%s)\n", *addr, *root)
	log.Fatal(http.ListenAndServe(*addr, r))
}
