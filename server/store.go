package main

import (
	"context"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ── data model ──────────────────────────────────────────────

type SessionInfo struct {
	State      string `json:"state"` // "live" | "idle"
	LastActive int64  `json:"lastActive"`
}

type WorktreeInfo struct {
	Path    string       `json:"path"`
	Name    string       `json:"name"`
	Main    bool         `json:"main"`
	Dirty   bool         `json:"dirty"`
	Session *SessionInfo `json:"session,omitempty"`
}

type Branch struct {
	Name       string        `json:"name"`
	SHA        string        `json:"sha"`
	Upstream   string        `json:"upstream,omitempty"`
	Ahead      int           `json:"ahead"`
	Behind     int           `json:"behind"`
	NoUpstream bool          `json:"noUpstream"`
	Gone       bool          `json:"gone"`
	Merged     bool          `json:"merged"`
	IsHead     bool          `json:"isHead"`
	Worktree   *WorktreeInfo `json:"worktree,omitempty"`
}

type Commit struct {
	SHA     string   `json:"sha"`
	Parents []string `json:"parents"`
	Time    int64    `json:"time"`
	Refs    []string `json:"refs"`
	Subject string   `json:"subject"`
}

type Snapshot struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	Path       string   `json:"path"`
	HeadBranch string   `json:"headBranch"`
	HeadSHA    string   `json:"headSha"`
	NoRemote   bool     `json:"noRemote"`
	Remotes    []string `json:"remotes"`
	Commits    []Commit `json:"commits"`
	Branches   []Branch `json:"branches"`
	BuiltAt    int64    `json:"builtAt"`
}

type Summary struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	HeadBranch  string `json:"headBranch"`
	Worktrees   int    `json:"worktrees"`
	Branches    int    `json:"branches"`
	Dirty       int    `json:"dirty"`
	AheadTotal  int    `json:"aheadTotal"`
	Diverged    int    `json:"diverged"`
	NoUpstream  int    `json:"noUpstream"`
	MergedOpen  int    `json:"mergedOpen"`
	SessionLive bool   `json:"sessionLive"`
	LastCommit  int64  `json:"lastCommit"`
	NoRemote    bool   `json:"noRemote"`
	Active      bool   `json:"active"`
}

type Repo struct {
	ID        string
	Path      string // 主 worktree 絕對路徑
	CommonDir string // 共用 .git 絕對路徑
	mu        sync.Mutex
	snapshot  *Snapshot
	summary   Summary
}

type Store struct {
	root string
	home string
	hub  *Hub

	mu    sync.RWMutex
	repos map[string]*Repo

	lastFetch atomic64
}

// atomic64 是簡化的 atomic int64（避免多引一個 import 別名）。
type atomic64 struct {
	mu sync.Mutex
	v  int64
}

func (a *atomic64) Store(v int64) { a.mu.Lock(); a.v = v; a.mu.Unlock() }
func (a *atomic64) Load() int64   { a.mu.Lock(); defer a.mu.Unlock(); return a.v }

func newStore(root string, hub *Hub) *Store {
	home, _ := os.UserHomeDir()
	return &Store{root: root, home: home, hub: hub, repos: map[string]*Repo{}}
}

// ── git helpers ─────────────────────────────────────────────

func gitRun(dir string, timeout time.Duration, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	return strings.TrimRight(string(out), "\n"), err
}

func git(dir string, args ...string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimRight(string(out), "\n")
}

// ── discovery ───────────────────────────────────────────────

var skipDirs = map[string]bool{"node_modules": true, ".cache": true, "vendor": true, "dist": true}

// discover 走訪 root 找 .git，以 git-common-dir 絕對路徑去重。
// 回傳值是新發現的 repo id（呼叫端要為它們掛監看）。
func (s *Store) discover() []string {
	seen := map[string]bool{}
	var added []string
	filepath.WalkDir(s.root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		// .claude/（含 worktrees）整棵跳過：linked worktree 會從主 repo 的
		// worktree list 進到快照，不需要用走的找；裡面的 submodule 副本則是純雜訊。
		if d.IsDir() && (skipDirs[d.Name()] || d.Name() == ".claude") {
			return filepath.SkipDir
		}
		if d.Name() != ".git" {
			return nil
		}
		dir := filepath.Dir(p)
		common := git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir")
		ret := error(nil)
		if d.IsDir() {
			ret = filepath.SkipDir
		}
		// common dir 落在 .git/worktrees/ 裡＝某個 worktree 私有的 submodule 副本，跳過
		if common == "" || seen[common] || strings.Contains(common, "/.git/worktrees/") {
			return ret
		}
		seen[common] = true
		// 一般 repo（含經由 worktree 發現的）：common 是 <repo>/.git，取上層。
		// submodule：common 在 .git/modules/... 裡，主路徑就是發現它的 checkout 位置。
		mainPath := dir
		if filepath.Base(common) == ".git" {
			mainPath = filepath.Dir(common)
		}
		rel, _ := filepath.Rel(s.root, mainPath)
		s.mu.Lock()
		if _, ok := s.repos[rel]; !ok {
			s.repos[rel] = &Repo{ID: rel, Path: mainPath, CommonDir: common}
			added = append(added, rel)
		}
		s.mu.Unlock()
		return ret
	})
	return added
}

func (s *Store) repo(id string) *Repo {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.repos[id]
}

func (s *Store) allRepos() []*Repo {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]*Repo, 0, len(s.repos))
	for _, r := range s.repos {
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// ── snapshot build ──────────────────────────────────────────

const logLimit = "400"

func (s *Store) buildSnapshot(r *Repo) *Snapshot {
	p := r.Path
	snap := &Snapshot{ID: r.ID, Name: r.ID, Path: p, BuiltAt: time.Now().Unix()}

	snap.HeadBranch = git(p, "rev-parse", "--abbrev-ref", "HEAD")
	snap.HeadSHA = git(p, "rev-parse", "HEAD")
	remotes := git(p, "remote")
	if remotes != "" {
		snap.Remotes = strings.Split(remotes, "\n")
	}
	snap.NoRemote = len(snap.Remotes) == 0

	// worktrees（含 main），branch → worktree 對應與 detached HEAD 收集
	wtByBranch := map[string]*WorktreeInfo{}
	var detached []string
	for _, block := range strings.Split(git(p, "worktree", "list", "--porcelain"), "\n\n") {
		var wt WorktreeInfo
		var branch string
		isDetached := false
		for _, line := range strings.Split(block, "\n") {
			switch {
			case strings.HasPrefix(line, "worktree "):
				wt.Path = strings.TrimPrefix(line, "worktree ")
			case strings.HasPrefix(line, "branch refs/heads/"):
				branch = strings.TrimPrefix(line, "branch refs/heads/")
			case line == "detached":
				isDetached = true
			case strings.HasPrefix(line, "HEAD "):
				if isDetached {
					detached = append(detached, strings.TrimPrefix(line, "HEAD "))
				}
			}
		}
		if wt.Path == "" {
			continue
		}
		wt.Name = filepath.Base(wt.Path)
		wt.Main = wt.Path == p
		wt.Dirty = git(wt.Path, "status", "--porcelain") != ""
		wt.Session = s.sessionFor(wt.Path)
		if branch != "" {
			w := wt
			wtByBranch[branch] = &w
		}
	}

	// merged set（已包含進 HEAD 的分支）
	merged := map[string]bool{}
	for _, b := range strings.Split(git(p, "for-each-ref", "--merged", "HEAD", "--format=%(refname:short)", "refs/heads"), "\n") {
		if b != "" {
			merged[b] = true
		}
	}

	// branches
	for _, line := range strings.Split(git(p, "for-each-ref", "refs/heads",
		"--format=%(refname:short)|%(objectname)|%(upstream:short)|%(upstream:track)"), "\n") {
		if line == "" {
			continue
		}
		f := strings.SplitN(line, "|", 4)
		if len(f) < 4 {
			continue
		}
		b := Branch{Name: f[0], SHA: f[1], Upstream: f[2], Merged: merged[f[0]],
			IsHead: f[0] == snap.HeadBranch, Worktree: wtByBranch[f[0]]}
		track := strings.Trim(f[3], "[]")
		if f[2] == "" {
			b.NoUpstream = true
			if !snap.NoRemote {
				n, _ := strconv.Atoi(git(p, "rev-list", "--count", "refs/heads/"+f[0], "--not", "--remotes"))
				b.Ahead = n
			}
		} else if track == "gone" {
			b.Gone = true
		} else {
			for _, part := range strings.Split(track, ", ") {
				if n, ok := strings.CutPrefix(part, "ahead "); ok {
					b.Ahead, _ = strconv.Atoi(n)
				}
				if n, ok := strings.CutPrefix(part, "behind "); ok {
					b.Behind, _ = strconv.Atoi(n)
				}
			}
		}
		snap.Branches = append(snap.Branches, b)
	}

	// commits：--all 涵蓋所有 ref，另補 detached worktree HEAD
	args := []string{"log", "--topo-order", "-n", logLimit,
		"--format=%H|%P|%ct|%D|%s", "--all"}
	args = append(args, detached...)
	for _, line := range strings.Split(git(p, args...), "\n") {
		if line == "" {
			continue
		}
		f := strings.SplitN(line, "|", 5)
		if len(f) < 5 {
			continue
		}
		c := Commit{SHA: f[0], Subject: f[4]}
		if f[1] != "" {
			c.Parents = strings.Split(f[1], " ")
		}
		c.Time, _ = strconv.ParseInt(f[2], 10, 64)
		if f[3] != "" {
			for _, ref := range strings.Split(f[3], ", ") {
				ref = strings.TrimPrefix(ref, "HEAD -> ")
				if ref != "HEAD" && ref != "" {
					c.Refs = append(c.Refs, ref)
				}
			}
		}
		snap.Commits = append(snap.Commits, c)
	}
	return snap
}

func summarize(snap *Snapshot) Summary {
	sum := Summary{ID: snap.ID, Name: snap.Name, HeadBranch: snap.HeadBranch,
		Branches: len(snap.Branches), NoRemote: snap.NoRemote}
	wtSeen := map[string]bool{}
	for _, b := range snap.Branches {
		sum.AheadTotal += b.Ahead
		if b.Ahead > 0 && b.Behind > 0 {
			sum.Diverged++
		}
		if b.NoUpstream {
			sum.NoUpstream++
		}
		if b.Merged && !b.IsHead {
			sum.MergedOpen++
		}
		if b.Worktree != nil && !wtSeen[b.Worktree.Path] {
			wtSeen[b.Worktree.Path] = true
			sum.Worktrees++
			if b.Worktree.Dirty {
				sum.Dirty++
			}
			if b.Worktree.Session != nil && b.Worktree.Session.State == "live" {
				sum.SessionLive = true
			}
		}
	}
	if len(snap.Commits) > 0 {
		sum.LastCommit = snap.Commits[0].Time
	}
	sum.Active = sum.Dirty > 0 || sum.AheadTotal > 0 || sum.Branches > 1 || sum.Worktrees > 1
	return sum
}

// rebuild 重建單一 repo 的快照與摘要；摘要有變才廣播。
func (s *Store) rebuild(id string) {
	r := s.repo(id)
	if r == nil {
		return
	}
	snap := s.buildSnapshot(r)
	sum := summarize(snap)
	r.mu.Lock()
	changed := r.summary != sum || r.snapshot == nil ||
		r.snapshot.HeadSHA != snap.HeadSHA || len(r.snapshot.Commits) != len(snap.Commits)
	r.snapshot = snap
	r.summary = sum
	r.mu.Unlock()
	if changed {
		s.hub.broadcast(map[string]string{"type": "repo", "id": id})
	}
}

// ── claude session liveness ─────────────────────────────────

const sessionLiveWindow = 5 * time.Minute

func (s *Store) sessionFor(wtPath string) *SessionInfo {
	munged := strings.NewReplacer("/", "-", ".", "-").Replace(wtPath)
	dir := filepath.Join(s.home, ".claude", "projects", munged)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var latest time.Time
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".jsonl") {
			continue
		}
		if info, err := e.Info(); err == nil && info.ModTime().After(latest) {
			latest = info.ModTime()
		}
	}
	if latest.IsZero() {
		return nil
	}
	state := "idle"
	if time.Since(latest) < sessionLiveWindow {
		state = "live"
	}
	return &SessionInfo{State: state, LastActive: latest.Unix()}
}
