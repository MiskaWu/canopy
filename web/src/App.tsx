import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchRepo, fetchRepos, loadLS, saveLS, subscribe } from './api'
import { Graph } from './Graph'
import { PushDialog, type PushTarget } from './PushDialog'
import type { Branch, ReposResponse, Snapshot, Summary } from './types'

type Filter = 'active' | 'pinned' | 'all'

function ago(unix: number): string {
  if (!unix) return '—'
  const s = Math.floor(Date.now() / 1000 - unix)
  if (s < 60) return `${Math.max(s, 1)} 秒前`
  if (s < 3600) return `${Math.floor(s / 60)} 分前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小時前`
  return `${Math.floor(s / 86400)} 天前`
}

export default function App() {
  const [data, setData] = useState<ReposResponse | null>(null)
  const [filter, setFilter] = useState<Filter>(() => loadLS<Filter>('gg.filter', 'active'))
  const [pinned, setPinned] = useState<string[]>(() => loadLS<string[]>('gg.pinned', []))
  const [expanded, setExpanded] = useState<string[]>(() => loadLS<string[]>('gg.expanded', []))
  const [snaps, setSnaps] = useState<Record<string, Snapshot>>({})
  const [pushTarget, setPushTarget] = useState<PushTarget | null>(null)
  const [quietOpen, setQuietOpen] = useState(false)

  const expandedRef = useRef(expanded)
  expandedRef.current = expanded

  const refreshList = useCallback(() => {
    fetchRepos().then(setData).catch(() => {})
  }, [])

  const refreshSnap = useCallback((id: string) => {
    fetchRepo(id)
      .then((snap) => setSnaps((s) => ({ ...s, [id]: snap })))
      .catch(() => {})
  }, [])

  useEffect(() => {
    refreshList()
    // 初始掃描期間 repo 逐一亮起來；用短輪詢補到 SSE 建立前的空窗
    const warmup = setInterval(refreshList, 2000)
    setTimeout(() => clearInterval(warmup), 15000)
    const off = subscribe((ev) => {
      if (ev.type === 'repo') {
        refreshList()
        if (expandedRef.current.includes(ev.id)) refreshSnap(ev.id)
      } else if (ev.type === 'fetch') {
        refreshList()
      }
    })
    return () => {
      clearInterval(warmup)
      off()
    }
  }, [refreshList, refreshSnap])

  useEffect(() => saveLS('gg.filter', filter), [filter])
  useEffect(() => saveLS('gg.pinned', pinned), [pinned])
  useEffect(() => saveLS('gg.expanded', expanded), [expanded])

  const repos = data?.repos ?? []
  const activeRepos = repos.filter((r) => r.active)
  const pinnedSet = new Set(pinned)

  let shown: Summary[]
  if (filter === 'all') shown = repos
  else if (filter === 'pinned') shown = repos.filter((r) => pinnedSet.has(r.id))
  else shown = activeRepos
  // 釘選的浮頂
  shown = [...shown].sort((a, b) => Number(pinnedSet.has(b.id)) - Number(pinnedSet.has(a.id)))
  const quiet = filter === 'active' ? repos.filter((r) => !r.active) : []

  const toggleExpand = (id: string) => {
    setExpanded((e) => {
      const on = e.includes(id)
      if (!on) refreshSnap(id)
      return on ? e.filter((x) => x !== id) : [...e, id]
    })
  }

  const togglePin = (id: string, ev: React.MouseEvent) => {
    ev.stopPropagation()
    setPinned((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))
  }

  const openPush = (id: string) => (branch: Branch) => {
    const snap = snaps[id]
    setPushTarget({ repoId: id, branch, remotes: snap?.remotes ?? ['origin'] })
  }

  return (
    <div className="wrap">
      <header>
        <h1>
          git-graph <span className="dim">· {data?.root?.replace(/^\/home\/[^/]+/, '~') ?? ''}</span>
        </h1>
        <div className="hstat">
          <span>{repos.length} repos</span>
          <span>⟳ fetch {data?.lastFetch ? ago(data.lastFetch) : '尚未'}</span>
          <span>
            <span className="dot-live" />
            即時
          </span>
        </div>
      </header>

      <div className="chips">
        {(
          [
            ['active', `有動靜 ${activeRepos.length}`],
            ['pinned', `已釘選 ${pinned.length}`],
            ['all', `全部 ${repos.length}`],
          ] as [Filter, string][]
        ).map(([f, label]) => (
          <div key={f} className={`chip${filter === f ? ' on' : ''}`} onClick={() => setFilter(f)}>
            {label}
          </div>
        ))}
      </div>

      {data === null && <div className="dim pad">連線中…</div>}
      {data !== null && repos.length === 0 && <div className="dim pad">初始掃描中…</div>}

      {shown.map((r) => (
        <div className="card" key={r.id}>
          <div className="card-h" onClick={() => toggleExpand(r.id)}>
            <span
              className="pin"
              style={{ opacity: pinnedSet.has(r.id) ? 1 : 0.25 }}
              onClick={(e) => togglePin(r.id, e)}
              title={pinnedSet.has(r.id) ? '取消釘選' : '釘選'}
            >
              📌
            </span>
            <span className="name">{r.name}</span>
            <span className="head mono">{r.headBranch}</span>
            <div className="meta">
              {r.worktrees > 1 && <span>{r.worktrees} worktrees</span>}
              {r.dirty > 0 && <span className="badge b-dirty">✎ {r.dirty} 未 commit</span>}
              {r.aheadTotal > 0 && <span className="badge b-ahead">↑ {r.aheadTotal} 未推</span>}
              {r.diverged > 0 && <span className="badge b-div">⚠ {r.diverged} 分岔</span>}
              {r.mergedOpen > 0 && <span className="badge b-stale">{r.mergedOpen} 已合併未清</span>}
              {!r.active && <span className="badge b-ok">✓ 乾淨</span>}
              {r.sessionLive && <span className="sess live">●</span>}
            </div>
          </div>
          {expanded.includes(r.id) &&
            (snaps[r.id] ? <Graph snap={snaps[r.id]} onPush={openPush(r.id)} /> : <div className="dim pad">載入線圖…</div>)}
        </div>
      ))}

      {quiet.length > 0 && (
        <div className="card">
          {(quietOpen ? quiet : quiet.slice(0, 3)).map((r) => (
            <div className="quiet-row" key={r.id} onClick={() => toggleExpand(r.id)}>
              <span className="name">{r.name}</span>
              <span className="mono qbranch">{r.headBranch}</span>
              <div className="right">
                <span className="badge b-ok">✓</span>
                <span>{ago(r.lastCommit)}</span>
              </div>
            </div>
          ))}
          {quiet.length > 3 && (
            <div className="fold" onClick={() => setQuietOpen(!quietOpen)}>
              {quietOpen ? '▴ 收合' : `▾ 其餘 ${quiet.length - 3} 個安靜的 repo`}
            </div>
          )}
        </div>
      )}

      <div className="legend">
        <span>● session 活躍</span>
        <span>○ 閒置（時間=最後活動）</span>
        <span>⌂ worktree</span>
        <span>✎ 未 commit</span>
        <span>↑ 未推（按鈕即推送）</span>
        <span>⚠ 與遠端分岔</span>
        <span>✓ 已合併/乾淨</span>
      </div>

      {pushTarget && <PushDialog target={pushTarget} onClose={() => setPushTarget(null)} />}
    </div>
  )
}
