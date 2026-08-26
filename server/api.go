package main

import (
	"encoding/json"
	"fmt"
	"net/http"
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

func (s *Store) handleRepos(w http.ResponseWriter, r *http.Request) {
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
	var rangeArgs []string
	if br.NoUpstream || br.Gone {
		rangeArgs = []string{"log", "--format=%h|%s", "-n", "50", "refs/heads/" + branch, "--not", "--remotes"}
	} else {
		rangeArgs = []string{"log", "--format=%h|%s", "-n", "50", br.Upstream + "..refs/heads/" + branch}
	}
	var commits []previewCommit
	for _, line := range strings.Split(git(repo.Path, rangeArgs...), "\n") {
		if line == "" {
			continue
		}
		f := strings.SplitN(line, "|", 2)
		if len(f) == 2 {
			commits = append(commits, previewCommit{f[0], f[1]})
		}
	}
	writeJSON(w, map[string]any{
		"commits":    commits,
		"noUpstream": br.NoUpstream || br.Gone,
		"upstream":   br.Upstream,
		"remote":     remote,
	})
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
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "bad request body")
		return
	}
	repo := s.repo(req.ID)
	if repo == nil {
		writeErr(w, 404, "unknown repo")
		return
	}
	br := findBranch(repo, req.Branch)
	if br == nil {
		writeErr(w, 404, "unknown branch")
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
		writeErr(w, 400, "unknown remote")
		return
	}
	if (req.Branch == "main" || req.Branch == "master") && !req.ConfirmMain {
		writeErr(w, 400, "pushing main/master requires confirmMain")
		return
	}
	args := []string{"push"}
	if br.NoUpstream || br.Gone {
		args = append(args, "-u")
	}
	args = append(args, req.Remote, req.Branch)
	out, err := gitRun(repo.Path, 60*time.Second, args...)
	if err != nil {
		writeErr(w, 502, strings.TrimSpace(out))
		return
	}
	s.rebuild(req.ID)
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
