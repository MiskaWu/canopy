package main

import (
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

// Watcher：inotify 盯住每個 repo 的 refs 相關路徑，事件 debounce 後重建快照。
// fsnotify 不支援遞迴，refs/ 底下的子目錄要自己走訪掛點、新目錄出現時補掛。
type Watcher struct {
	store   *Store
	fsw     *fsnotify.Watcher
	mu      sync.Mutex
	dirRepo map[string]string // watched dir -> repo id
	timers  map[string]*time.Timer
}

func newWatcher(store *Store) (*Watcher, error) {
	fsw, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	return &Watcher{store: store, fsw: fsw, dirRepo: map[string]string{}, timers: map[string]*time.Timer{}}, nil
}

func (w *Watcher) addDir(dir, repoID string) {
	if err := w.fsw.Add(dir); err != nil {
		return
	}
	w.mu.Lock()
	w.dirRepo[dir] = repoID
	w.mu.Unlock()
}

// watchRepo 掛上一個 repo 的所有監看點：
// common dir 本體（HEAD、packed-refs）、refs/ 全樹、worktrees/ 各自的 gitdir（HEAD 移動）。
func (w *Watcher) watchRepo(r *Repo) {
	w.addDir(r.CommonDir, r.ID)
	for _, sub := range []string{"refs", "worktrees"} {
		root := filepath.Join(r.CommonDir, sub)
		filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
			if err == nil && d.IsDir() {
				w.addDir(p, r.ID)
			}
			return nil
		})
	}
}

const debounceDelay = 300 * time.Millisecond

func (w *Watcher) schedule(repoID string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if t, ok := w.timers[repoID]; ok {
		t.Reset(debounceDelay)
		return
	}
	w.timers[repoID] = time.AfterFunc(debounceDelay, func() {
		w.mu.Lock()
		delete(w.timers, repoID)
		w.mu.Unlock()
		w.store.rebuild(repoID)
	})
}

func (w *Watcher) loop() {
	for {
		select {
		case ev, ok := <-w.fsw.Events:
			if !ok {
				return
			}
			// lock 檔是 git 操作的中間產物，跳過可少一半雜訊（debounce 仍會兜底）
			if strings.HasSuffix(ev.Name, ".lock") {
				continue
			}
			dir := filepath.Dir(ev.Name)
			w.mu.Lock()
			repoID, known := w.dirRepo[dir]
			w.mu.Unlock()
			if !known {
				continue
			}
			// refs/worktrees 底下長出新目錄 → 補掛監看
			if ev.Op.Has(fsnotify.Create) {
				if info, err := os.Stat(ev.Name); err == nil && info.IsDir() {
					w.addDir(ev.Name, repoID)
				}
			}
			w.schedule(repoID)
		case err, ok := <-w.fsw.Errors:
			if !ok {
				return
			}
			log.Printf("watch error: %v", err)
		}
	}
}

// ── background loops ────────────────────────────────────────

// fetchLoop：定期對每個有 remote 的 repo fetch --prune。
// fetch 寫入 remote refs 時 watcher 會自然觸發重建，這裡不用另外通知。
func (s *Store) fetchLoop(interval time.Duration) {
	if interval <= 0 {
		return
	}
	for {
		time.Sleep(interval)
		for _, r := range s.allRepos() {
			r.mu.Lock()
			noRemote := r.snapshot == nil || r.snapshot.NoRemote
			r.mu.Unlock()
			if noRemote {
				continue
			}
			gitRun(r.Path, 60*time.Second, "fetch", "--prune", "--quiet")
		}
		s.lastFetch.Store(time.Now().Unix())
		s.hub.broadcast(map[string]any{"type": "fetch", "at": time.Now().Unix()})
	}
}

// slowLoop：髒污與 session 活性走慢輪詢（refs 事件抓不到 working tree 的變化）。
// 摘要沒變就不廣播，安靜時前端不會收到任何東西。
func (s *Store) slowLoop() {
	for {
		time.Sleep(60 * time.Second)
		for _, r := range s.allRepos() {
			s.rebuild(r.ID)
		}
	}
}

// rescanLoop：定期重掃根目錄，接住全新的 repo；新 repo 掛監看並建快照。
func (s *Store) rescanLoop(w *Watcher) {
	for {
		time.Sleep(3 * time.Minute)
		for _, id := range s.discover() {
			if r := s.repo(id); r != nil {
				w.watchRepo(r)
				s.rebuild(id)
			}
		}
	}
}
