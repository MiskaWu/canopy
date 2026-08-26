// git-graph 骨架版：連通性驗證用。
// 只做三件事：掃描 root 底下的 repo、以 git-common-dir 去重、
// 回一頁列出各 repo 分支/worktree 數量與文字版線圖的 HTML。
// 正式版的 SSE / inotify / push 都還沒進來。
package main

import (
	"flag"
	"fmt"
	"html/template"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

type Repo struct {
	Name      string // 相對於 root 的路徑
	Path      string // 絕對路徑（主 worktree）
	Branches  int
	Worktrees int
	Head      string
	Graph     string // git log --graph 文字版
}

func gitOut(dir string, args ...string) string {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimRight(string(out), "\n")
}

// scan 走訪 root 找 .git（目錄或檔案都算），用 git-common-dir 絕對路徑去重：
// 主 repo 與其所有 worktree 併成一筆，submodule 因 common dir 不同自成一筆。
func scan(root string) []Repo {
	seen := map[string]bool{}
	var repos []Repo
	filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() && (d.Name() == "node_modules" || d.Name() == ".cache" || d.Name() == "vendor") {
			return filepath.SkipDir
		}
		if d.Name() != ".git" {
			return nil
		}
		dir := filepath.Dir(p)
		common := gitOut(dir, "rev-parse", "--path-format=absolute", "--git-common-dir")
		if common == "" || seen[common] {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		seen[common] = true
		// 主 worktree 的路徑一律從 common dir 反推，避免先撞到 worktree 時取錯名字。
		mainPath := filepath.Dir(common)
		rel, _ := filepath.Rel(root, mainPath)
		branches := strings.Count(gitOut(mainPath, "branch", "--list"), "\n") + 1
		wt := strings.Count(gitOut(mainPath, "worktree", "list", "--porcelain"), "worktree ")
		repos = append(repos, Repo{
			Name:      rel,
			Path:      mainPath,
			Branches:  branches,
			Worktrees: wt,
			Head:      gitOut(mainPath, "rev-parse", "--abbrev-ref", "HEAD"),
			Graph:     gitOut(mainPath, "log", "--graph", "--oneline", "--all", "--decorate", "-n", "40"),
		})
		if d.IsDir() {
			return filepath.SkipDir
		}
		return nil
	})
	return repos
}

var page = template.Must(template.New("p").Parse(`<!doctype html>
<meta charset="utf-8">
<title>git-graph 骨架</title>
<style>
  body { background:#101418; color:#d8dee6; font-family:ui-monospace,monospace; margin:2rem; }
  h1 { font-size:1.1rem; } h2 { font-size:.95rem; margin:1.4rem 0 .3rem; color:#7fb4e6; }
  .meta { color:#8a93a0; font-size:.85rem; }
  pre { background:#161c22; padding:.8rem 1rem; border-radius:8px; overflow-x:auto; font-size:.8rem; line-height:1.45; }
  .ok { color:#69c87e; }
</style>
<h1>git-graph <span class="ok">連通性驗證成功 ✓</span></h1>
<p class="meta">root: {{.Root}} ・ 共 {{len .Repos}} 個 repo（worktree 已去重）</p>
{{range .Repos}}
<h2>{{.Name}}</h2>
<p class="meta">HEAD: {{.Head}} ・ 分支 {{.Branches}} ・ worktree {{.Worktrees}}</p>
{{if gt .Worktrees 1}}<pre>{{.Graph}}</pre>{{end}}
{{end}}`))

func main() {
	home, _ := os.UserHomeDir()
	root := flag.String("root", filepath.Join(home, "projects"), "掃描根目錄")
	addr := flag.String("addr", "127.0.0.1:7777", "監聽位址")
	flag.Parse()

	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		if err := page.Execute(w, struct {
			Root  string
			Repos []Repo
		}{*root, scan(*root)}); err != nil {
			log.Print(err)
		}
	})
	fmt.Printf("git-graph skeleton listening on http://%s (root=%s)\n", *addr, *root)
	log.Fatal(http.ListenAndServe(*addr, nil))
}
