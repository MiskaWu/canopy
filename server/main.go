// git-graph：本機 git 線圖面板。
// 掃描 root 底下所有 repo（worktree 以 git-common-dir 去重），
// inotify 盯 refs、SSE 推播、定期 fetch，前端（web/，go:embed 進 binary）畫線圖。
package main

import (
	"embed"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

//go:embed mockup.html
var mockupHTML []byte

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

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/repos", store.handleRepos)
	mux.HandleFunc("GET /api/repo", store.handleRepo)
	mux.HandleFunc("GET /api/push-preview", store.handlePushPreview)
	mux.HandleFunc("POST /api/push", store.handlePush)
	mux.HandleFunc("GET /api/events", hub.handleSSE)
	mux.HandleFunc("/mockup", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write(mockupHTML)
	})

	dist, err := fs.Sub(webDist, "dist")
	if err != nil {
		log.Fatal(err)
	}
	fileServer := http.FileServerFS(dist)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, "/")
		if p != "" {
			if f, err := dist.Open(p); err == nil {
				f.Close()
				fileServer.ServeHTTP(w, r)
				return
			}
		}
		r.URL.Path = "/" // SPA fallback
		fileServer.ServeHTTP(w, r)
	})

	fmt.Printf("git-graph listening on http://%s (root=%s)\n", *addr, *root)
	log.Fatal(http.ListenAndServe(*addr, mux))
}
