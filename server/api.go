package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

// ── SSE hub ─────────────────────────────────────────────────

type Hub struct {
	mu      sync.Mutex
	clients map[chan []byte]bool
}

func newHub() *Hub { return &Hub{clients: map[chan []byte]bool{}} }

func (h *Hub) broadcast(v any) {
	data, _ := json.Marshal(v)
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.clients {
		select {
		case ch <- data:
		default: // 客戶端塞住就丟，SSE 斷線重連後會重抓
		}
	}
}

func (h *Hub) handleSSE(c *gin.Context) {
	w := c.Writer
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	ch := make(chan []byte, 16)
	h.mu.Lock()
	h.clients[ch] = true
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		delete(h.clients, ch)
		h.mu.Unlock()
	}()
	// 先把 header 沖出去：Go 在第一次寫入前不會送出 header，而 EventSource 收不到
	// 回應就一直停在 CONNECTING。沒這一行的話，安靜時段要等到下一個事件或 25 秒後
	// 的心跳才會 open，客戶端早就 timeout 了（2026-08-27 在面板診斷頁抓到）。
	fmt.Fprint(w, ": open\n\n")
	w.Flush()
	heartbeat := time.NewTicker(25 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-c.Request.Context().Done():
			return
		case data := <-ch:
			fmt.Fprintf(w, "data: %s\n\n", data)
			w.Flush()
		case <-heartbeat.C:
			fmt.Fprint(w, ": ping\n\n")
			w.Flush()
		}
	}
}

// ── helpers ─────────────────────────────────────────────────

func writeErr(c *gin.Context, code int, msg string) {
	c.JSON(code, gin.H{"error": msg})
}

// originAllowed：CSRF 防線。瀏覽器發的跨站請求會帶 Origin，
// 不在白名單就拒絕；沒有 Origin 的（curl、同機腳本）視為本機使用者放行。
func originAllowed(c *gin.Context) bool {
	o := c.GetHeader("Origin")
	if o == "" {
		return true
	}
	for _, allowed := range []string{
		"http://127-0-0-1.nip.io:7777",
		"http://127.0.0.1.nip.io:7777",
		"http://localhost:7777",
		"http://127.0.0.1:7777",
		"http://localhost:5173", // vite dev
		"http://127.0.0.1:5173",
	} {
		if o == allowed {
			return true
		}
	}
	return false
}

// ── handlers ────────────────────────────────────────────────

func (s *Store) summaries() []Summary {
	var sums []Summary
	for _, repo := range s.allRepos() {
		repo.mu.Lock()
		if repo.snapshot != nil {
			sums = append(sums, repo.summary)
		}
		repo.mu.Unlock()
	}
	sort.Slice(sums, func(i, j int) bool {
		if sums[i].Active != sums[j].Active {
			return sums[i].Active
		}
		return sums[i].Name < sums[j].Name
	})
	return sums
}

func (s *Store) handleRepos(c *gin.Context) {
	c.JSON(200, gin.H{
		"root":      s.root,
		"lastFetch": s.lastFetch.Load(),
		"repos":     s.summaries(),
	})
}

func (s *Store) handleRepo(c *gin.Context) {
	repo := s.repo(c.Query("id"))
	if repo == nil {
		writeErr(c, 404, "unknown repo")
		return
	}
	repo.mu.Lock()
	snap := repo.snapshot
	repo.mu.Unlock()
	if snap == nil {
		writeErr(c, 503, "snapshot not ready")
		return
	}
	c.JSON(200, snap)
}

type previewCommit struct {
	SHA     string `json:"sha"`
	Subject string `json:"subject"`
}

func (s *Store) handlePushPreview(c *gin.Context) {
	repo, branch, remote := s.repo(c.Query("id")), c.Query("branch"), c.Query("remote")
	if repo == nil {
		writeErr(c, 404, "unknown repo")
		return
	}
	br := findBranch(repo, branch)
	if br == nil {
		writeErr(c, 404, "unknown branch")
		return
	}
	pv := previewFor(repo.Path, br)
	c.JSON(200, gin.H{
		"commits":    pv.Commits,
		"noUpstream": pv.NoUpstream,
		"upstream":   br.Upstream,
		"remote":     remote,
	})
}

type pushPreviewData struct {
	Commits    []previewCommit `json:"commits"`
	NoUpstream bool            `json:"noUpstream"`
}

func previewFor(repoPath string, br *Branch) pushPreviewData {
	var rangeArgs []string
	if br.NoUpstream || br.Gone {
		rangeArgs = []string{"log", "--format=%h|%s", "-n", "50", "refs/heads/" + br.Name, "--not", "--remotes"}
	} else {
		rangeArgs = []string{"log", "--format=%h|%s", "-n", "50", br.Upstream + "..refs/heads/" + br.Name}
	}
	var commits []previewCommit
	for _, line := range strings.Split(git(repoPath, rangeArgs...), "\n") {
		if line == "" {
			continue
		}
		f := strings.SplitN(line, "|", 2)
		if len(f) == 2 {
			commits = append(commits, previewCommit{f[0], f[1]})
		}
	}
	return pushPreviewData{Commits: commits, NoUpstream: br.NoUpstream || br.Gone}
}

// bootData 是嵌進首頁 HTML 的啟動資料：靜態模式（Desktop 面板的殼，
// 執行期無網路）就靠它渲染整個介面。
type bootData struct {
	Root        string                                `json:"root"`
	LastFetch   int64                                 `json:"lastFetch"`
	GeneratedAt int64                                 `json:"generatedAt"`
	Repos       []Summary                             `json:"repos"`
	Snapshots   map[string]*Snapshot                  `json:"snapshots"`
	Previews    map[string]map[string]pushPreviewData `json:"previews"`
}

func (s *Store) makeIndexHandler(indexHTML []byte) gin.HandlerFunc {
	const marker = "window.__DATA__ = null;"
	return func(c *gin.Context) {
		bd := bootData{
			Root: s.root, LastFetch: s.lastFetch.Load(), GeneratedAt: time.Now().Unix(),
			Repos:     s.summaries(),
			Snapshots: map[string]*Snapshot{},
			Previews:  map[string]map[string]pushPreviewData{},
		}
		for _, id := range strings.Split(c.Query("open"), ",") {
			repo := s.repo(id)
			if repo == nil {
				continue
			}
			repo.mu.Lock()
			snap := repo.snapshot
			repo.mu.Unlock()
			if snap == nil {
				continue
			}
			bd.Snapshots[id] = snap
			pv := map[string]pushPreviewData{}
			for i := range snap.Branches {
				b := snap.Branches[i]
				if b.Ahead > 0 && !snap.NoRemote {
					pv[b.Name] = previewFor(snap.Path, &b)
				}
			}
			bd.Previews[id] = pv
		}
		data, err := json.Marshal(bd) // json.Marshal 會轉義 <>&，嵌進 <script> 安全
		if err != nil {
			c.String(500, err.Error())
			return
		}
		c.Header("Cache-Control", "no-store")
		c.Data(200, "text/html; charset=utf-8",
			bytes.Replace(indexHTML, []byte(marker), append([]byte("window.__DATA__ = "), data...), 1))
	}
}

type pushReq struct {
	ID          string `json:"id"`
	Branch      string `json:"branch"`
	Remote      string `json:"remote"`
	ConfirmMain bool   `json:"confirmMain"`
}

// handlePush：唯一會改變狀態的端點。
// 指令固定由伺服器組成 `git push <remote> <branch>`，前端傳不進任何旗標。
func (s *Store) handlePush(c *gin.Context) {
	if !originAllowed(c) {
		writeErr(c, 403, "origin not allowed")
		return
	}
	var req pushReq
	isForm := strings.HasPrefix(c.ContentType(), "application/x-www-form-urlencoded")
	var back string
	if isForm {
		req = pushReq{
			ID: c.PostForm("id"), Branch: c.PostForm("branch"),
			Remote: c.PostForm("remote"), ConfirmMain: c.PostForm("confirmMain") != "",
		}
		back = strings.TrimPrefix(c.PostForm("back"), "?")
	} else if err := json.NewDecoder(c.Request.Body).Decode(&req); err != nil {
		writeErr(c, 400, "bad request body")
		return
	}
	// 表單模式的回應是導航：成敗都 303 回首頁，結果放 query 讓頁面顯示
	fail := func(code int, msg string) {
		if isForm {
			c.Redirect(http.StatusSeeOther, "/?"+back+"&pushErr="+url.QueryEscape(msg))
		} else {
			writeErr(c, code, msg)
		}
	}
	repo := s.repo(req.ID)
	if repo == nil {
		fail(404, "unknown repo")
		return
	}
	br := findBranch(repo, req.Branch)
	if br == nil {
		fail(404, "unknown branch")
		return
	}
	validRemote := false
	repo.mu.Lock()
	if repo.snapshot != nil {
		for _, rm := range repo.snapshot.Remotes {
			if rm == req.Remote {
				validRemote = true
			}
		}
	}
	repo.mu.Unlock()
	if !validRemote {
		fail(400, "unknown remote")
		return
	}
	if (req.Branch == "main" || req.Branch == "master") && !req.ConfirmMain {
		fail(400, "pushing main/master requires confirmMain")
		return
	}
	args := []string{"push"}
	if br.NoUpstream || br.Gone {
		args = append(args, "-u")
	}
	args = append(args, req.Remote, req.Branch)
	out, err := gitRun(repo.Path, 60*time.Second, args...)
	if err != nil {
		fail(502, strings.TrimSpace(out))
		return
	}
	s.rebuild(req.ID)
	if isForm {
		c.Redirect(http.StatusSeeOther, "/?"+back+"&pushed="+url.QueryEscape(req.Branch))
		return
	}
	c.JSON(200, gin.H{"ok": true, "output": strings.TrimSpace(out)})
}

func findBranch(repo *Repo, name string) *Branch {
	repo.mu.Lock()
	defer repo.mu.Unlock()
	if repo.snapshot == nil {
		return nil
	}
	for i := range repo.snapshot.Branches {
		if repo.snapshot.Branches[i].Name == name {
			b := repo.snapshot.Branches[i]
			return &b
		}
	}
	return nil
}
