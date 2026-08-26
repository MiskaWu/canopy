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

func (h *Hub) handleSSE(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", 500)
		return
	}
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
	heartbeat := time.NewTicker(25 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case data := <-ch:
			fmt.Fprintf(w, "data: %s\n\n", data)
			fl.Flush()
		case <-heartbeat.C:
			fmt.Fprint(w, ": ping\n\n")
			fl.Flush()
		}
	}
}

// ── helpers ─────────────────────────────────────────────────

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	w.WriteHeader(code)
	writeJSON(w, map[string]string{"error": msg})
}

// originAllowed：CSRF 防線。瀏覽器發的跨站請求會帶 Origin，
// 不在白名單就拒絕；沒有 Origin 的（curl、同機腳本）視為本機使用者放行。
func originAllowed(r *http.Request) bool {
	o := r.Header.Get("Origin")
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

func (s *Store) handleRepos(w http.ResponseWriter, r *http.Request) {
	sums := s.summaries()
	writeJSON(w, map[string]any{
		"root":      s.root,
		"lastFetch": s.lastFetch.Load(),
		"repos":     sums,
	})
}

func (s *Store) handleRepo(w http.ResponseWriter, r *http.Request) {
	repo := s.repo(r.URL.Query().Get("id"))
	if repo == nil {
		writeErr(w, 404, "unknown repo")
		return
	}
	repo.mu.Lock()
	snap := repo.snapshot
	repo.mu.Unlock()
	if snap == nil {
		writeErr(w, 503, "snapshot not ready")
		return
	}
	writeJSON(w, snap)
}

type previewCommit struct {
	SHA     string `json:"sha"`
	Subject string `json:"subject"`
}

func (s *Store) handlePushPreview(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	repo, branch, remote := s.repo(q.Get("id")), q.Get("branch"), q.Get("remote")
	if repo == nil {
		writeErr(w, 404, "unknown repo")
		return
	}
	br := findBranch(repo, branch)
	if br == nil {
		writeErr(w, 404, "unknown branch")
		return
	}
	pv := previewFor(repo.Path, br)
	writeJSON(w, map[string]any{
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

func (s *Store) makeIndexHandler(indexHTML []byte) http.HandlerFunc {
	const marker = "window.__DATA__ = null;"
	return func(w http.ResponseWriter, r *http.Request) {
		bd := bootData{
			Root: s.root, LastFetch: s.lastFetch.Load(), GeneratedAt: time.Now().Unix(),
			Repos:     s.summaries(),
			Snapshots: map[string]*Snapshot{},
			Previews:  map[string]map[string]pushPreviewData{},
		}
		for _, id := range strings.Split(r.URL.Query().Get("open"), ",") {
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
			http.Error(w, err.Error(), 500)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.Write(bytes.Replace(indexHTML, []byte(marker), append([]byte("window.__DATA__ = "), data...), 1))
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
func (s *Store) handlePush(w http.ResponseWriter, r *http.Request) {
	if !originAllowed(r) {
		writeErr(w, 403, "origin not allowed")
		return
	}
	var req pushReq
	isForm := strings.HasPrefix(r.Header.Get("Content-Type"), "application/x-www-form-urlencoded")
	var back string
	if isForm {
		if err := r.ParseForm(); err != nil {
			writeErr(w, 400, "bad form")
			return
		}
		req = pushReq{
			ID: r.FormValue("id"), Branch: r.FormValue("branch"),
			Remote: r.FormValue("remote"), ConfirmMain: r.FormValue("confirmMain") != "",
		}
		back = strings.TrimPrefix(r.FormValue("back"), "?")
	} else if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "bad request body")
		return
	}
	// 表單模式的回應是導航：成敗都 303 回首頁，結果放 query 讓頁面顯示
	fail := func(code int, msg string) {
		if isForm {
			http.Redirect(w, r, "/?"+back+"&pushErr="+url.QueryEscape(msg), http.StatusSeeOther)
		} else {
			writeErr(w, code, msg)
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
		http.Redirect(w, r, "/?"+back+"&pushed="+url.QueryEscape(req.Branch), http.StatusSeeOther)
		return
	}
	writeJSON(w, map[string]any{"ok": true, "output": strings.TrimSpace(out)})
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
