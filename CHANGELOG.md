# Changelog

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
