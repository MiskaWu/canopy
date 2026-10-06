# Changelog

## 0.3.1 — 2026-10-06

- Uncommitted changes and untracked files are told apart: `✎ 2 uncommitted` for
  tracked files, a quieter `? 1 untracked` for new ones, with the untracked paths
  listed under the branch. A checkout holding nothing but, say, a tool's folder no
  longer looks like unfinished work; whether to ignore it is yours to decide in
  `.gitignore`, which canopy respects.

## 0.3.0 — 2026-10-06

- Push from the pane, **off by default**. Each branch with unpushed commits gets a
  `↑N Push` button that first shows the commits and the exact command; only your
  confirmation runs it. The command is always `git push [-u] <remote> <branch>`, never
  forced, with no password prompts.
- New settings: worktree branches (push like any branch, only in repositories that
  opt in through a local git config key — `canopy.worktreePushRemote` unless you name
  your own — or never), protected branches (two confirmations; the remote's default
  branch is always protected), and repositories with a pre-push hook (push from a
  terminal instead, or push anyway).

## 0.2.0 — 2026-10-06

- Settings, editable in the pane (**Settings** button) and under `/config`: language
  (English, 繁體中文), auto-refresh interval, commits in the graph, graph theme.
- English is the default language.
- The graph follows the app's light or dark appearance (or stays dark or light if you
  pick one), and fills the pane's width instead of guessing it.
- Installable from this repository as a plugin marketplace.
- Session activity is best effort: when Claude Code's session folder cannot be read,
  the badge is simply left out.

## 0.1.0 — 2026-10-06

- First version as a Claude Code mod: the nudge above the prompt, the graph pane and
  `/canopy`. Replaces the earlier Go server and web panel (last at `841bce3`).
