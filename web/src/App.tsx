import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { fetchRepo, fetchRepos, loadLS, probeNetwork, saveLS, subscribe } from './api'
import { Graph } from './Graph'
import { PushDialog, type PushTarget } from './PushDialog'
import type { Branch, ReposResponse, Snapshot, Summary } from './types'

type Filter = 'active' | 'pinned' | 'all'
// live：真瀏覽器，fetch + SSE 即時。
// static：Desktop 面板的殼——只有「載入整份文件」可用，
//         資料嵌在 HTML、UI 狀態放網址、互動用連結/表單、定時 reload。
type Mode = 'probing' | 'live' | 'static'

const boot = window.__DATA__

// static 模式的自動重載會把整份文件丟掉重建，捲動位置跟著沒了。
// 只有「這次重載是自動觸發的」才復原：使用者自己點連結導航（換過濾、展開 repo）
// 仍照瀏覽器預設處理，不會被硬拉回原位。
const SCROLL_KEY = 'gg.reloadScroll'

function stashScroll() {
  try {
    sessionStorage.setItem(SCROLL_KEY, String(window.scrollY))
  } catch {
    /* 隱私模式等，放棄復原即可 */
  }
}

// 在模組載入時就取走並清掉：讀到值＝上一幀是自動重載留下的。
const pendingScroll = (() => {
  try {
    const raw = sessionStorage.getItem(SCROLL_KEY)
    sessionStorage.removeItem(SCROLL_KEY)
    return raw === null ? null : Number(raw)
  } catch {
    return null
  }
})()

// 自動重載間隔。面板裡沒有 SSE，這是 static 模式唯一的更新管道。
const RELOAD_MS = 10000

// 探測要一次網路往返才有結果，但第一次繪製等不了它：static 模式的 UI 狀態在網址、
// live 模式的在 localStorage，猜錯的話探測回來就會整個重排——那也是一次閃。
// 所以先用記得的結果開場，探測仍照跑，只在結果不同時修正並更新記錄。
const MODE_KEY = 'gg.mode'

function rememberedMode(): Mode {
  const v = loadLS<string>(MODE_KEY, '')
  if (v === 'live' || v === 'static') return v
  // 沒有記錄時看主機名：面板固定從 nip.io 那個網址開（見 CLAUDE.md），
  // 一般瀏覽器多半直接連 127.0.0.1。認不出來就照舊等探測。
  return location.hostname.includes('nip.io') ? 'static' : 'probing'
}

const q = new URLSearchParams(location.search)
const urlFilter = ((['active', 'pinned', 'all'] as const).find((f) => f === q.get('f')) ?? 'active') as Filter
const urlOpen = (q.get('open') ?? '').split(',').filter(Boolean)
const urlPin = (q.get('pin') ?? '').split(',').filter(Boolean)
const urlQuiet = q.get('quiet') === '1'
const pushedMsg = q.get('pushed') ?? ''
const pushErrMsg = q.get('pushErr') ?? ''

function hrefFor(f: Filter, open: string[], pin: string[], quiet: boolean): string {
  const p = new URLSearchParams()
  if (f !== 'active') p.set('f', f)
  if (open.length) p.set('open', open.join(','))
  if (pin.length) p.set('pin', pin.join(','))
  if (quiet) p.set('quiet', '1')
  const s = p.toString()
  return s ? `/?${s}` : '/'
}

const toggled = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id])

function ago(unix: number): string {
  if (!unix) return '—'
  const s = Math.floor(Date.now() / 1000 - unix)
  if (s < 60) return `${Math.max(s, 1)} 秒前`
  if (s < 3600) return `${Math.floor(s / 60)} 分前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小時前`
  return `${Math.floor(s / 86400)} 天前`
}

export default function App() {
  const [mode, setMode] = useState<Mode>(rememberedMode)
  const [data, setData] = useState<ReposResponse | null>(
    boot ? { root: boot.root, lastFetch: boot.lastFetch, repos: boot.repos } : null,
  )
  const [liveFilter, setLiveFilter] = useState<Filter>(() => loadLS<Filter>('gg.filter', 'active'))
  const [livePinned, setLivePinned] = useState<string[]>(() => loadLS<string[]>('gg.pinned', []))
  const [liveExpanded, setLiveExpanded] = useState<string[]>(() => loadLS<string[]>('gg.expanded', []))
  const [snaps, setSnaps] = useState<Record<string, Snapshot>>(boot?.snapshots ?? {})
  const [pushTarget, setPushTarget] = useState<PushTarget | null>(null)
  const [liveQuietOpen, setLiveQuietOpen] = useState(false)
  const [connErr, setConnErr] = useState('')

  const isStatic = mode === 'static'
  const filter = isStatic ? urlFilter : liveFilter
  const pinned = isStatic ? urlPin : livePinned
  const expanded = isStatic ? urlOpen : liveExpanded
  // 安靜清單的展開要撐過 static 退路的整頁重載，所以跟 f/open/pin 一樣放網址
  const quietOpen = isStatic ? urlQuiet : liveQuietOpen

  const expandedRef = useRef(liveExpanded)
  expandedRef.current = liveExpanded

  const refreshList = useCallback(() => {
    fetchRepos()
      .then((d) => {
        setData(d)
        setConnErr('')
      })
      .catch((e) => setConnErr(`${location.href} → ${e instanceof Error ? e.message : e}`))
  }, [])

  const refreshSnap = useCallback((id: string) => {
    fetchRepo(id)
      .then((snap) => setSnaps((s) => ({ ...s, [id]: snap })))
      .catch(() => {})
  }, [])

  useEffect(() => {
    probeNetwork().then((ok) => {
      const probed: Mode = ok ? 'live' : 'static'
      setMode(probed)
      saveLS(MODE_KEY, probed)
    })
  }, [])

  // live 模式：fetch 初始資料 + SSE 即時更新
  useEffect(() => {
    if (mode !== 'live') return
    refreshList()
    liveExpanded.forEach(refreshSnap)
    const off = subscribe((ev) => {
      if (ev.type === 'repo') {
        refreshList()
        if (expandedRef.current.includes(ev.id)) refreshSnap(ev.id)
      } else if (ev.type === 'fetch') {
        refreshList()
      }
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, refreshList, refreshSnap])

  // static 模式：定時整頁重載（推送框開著時暫停）。
  // 若殼擋掉 script reload，header 的 ⟳ 連結是手動保底。
  // 分頁被藏起來時不重載——沒人在看，重建文件只是白費工；切回來時補一次，
  // 這樣使用者看到的永遠是剛抓的資料。
  useEffect(() => {
    if (mode !== 'static' || pushTarget) return
    const reload = () => {
      stashScroll()
      location.reload()
    }
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') reload()
    }, RELOAD_MS)
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      // 資料還新就不重載——切走又切回來不該每次都重建整份文件。
      if (Date.now() / 1000 - (boot?.generatedAt ?? 0) >= RELOAD_MS / 1000) reload()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [mode, pushTarget])

  // 復原捲動位置。打包後的 script 是同步的，跑到這裡時版面已經是完整高度，
  // 所以這次 scrollTo 會落在正確位置，不必等 layout。
  useLayoutEffect(() => {
    if (pendingScroll !== null) window.scrollTo(0, pendingScroll)
  }, [])

  // 「資料 N 秒前」每秒跳動：數字歸零＝自動重載活著；一路爬升＝reload 被擋
  const [, setTick] = useState(0)
  useEffect(() => {
    if (mode !== 'static') return
    const t = setInterval(() => setTick((x) => x + 1), 1000)
    return () => clearInterval(t)
  }, [mode])

  useEffect(() => {
    if (!isStatic) saveLS('gg.filter', liveFilter)
  }, [isStatic, liveFilter])
  useEffect(() => {
    if (!isStatic) saveLS('gg.pinned', livePinned)
  }, [isStatic, livePinned])
  useEffect(() => {
    if (!isStatic) saveLS('gg.expanded', liveExpanded)
  }, [isStatic, liveExpanded])

  const repos = data?.repos ?? []
  const activeRepos = repos.filter((r) => r.active)
  const pinnedSet = new Set(pinned)

  let shown: Summary[]
  if (filter === 'all') shown = [...repos]
  else if (filter === 'pinned') shown = repos.filter((r) => pinnedSet.has(r.id))
  else shown = repos.filter((r) => r.active)
  // 展開中的 repo 一定要有卡片，即使不在目前過濾範圍
  const shownIds = new Set(shown.map((r) => r.id))
  for (const id of expanded) {
    const r = repos.find((x) => x.id === id)
    if (r && !shownIds.has(id)) shown.push(r)
  }
  shown.sort((a, b) => Number(pinnedSet.has(b.id)) - Number(pinnedSet.has(a.id)))
  const quiet = filter === 'active' ? repos.filter((r) => !r.active && !expanded.includes(r.id)) : []

  const toggleExpand = (id: string) => {
    setLiveExpanded((e) => {
      const on = e.includes(id)
      if (!on) refreshSnap(id)
      return on ? e.filter((x) => x !== id) : [...e, id]
    })
  }

  const openPush = (id: string) => (branch: Branch) => {
    const snap = snaps[id]
    setPushTarget({ repoId: id, branch, remotes: snap?.remotes ?? ['origin'] })
  }

  const backQuery = hrefFor(filter, expanded, pinned, quietOpen).replace(/^\/\??/, '')

  return (
    <div className="wrap">
      <header>
        <h1>
          canopy <span className="dim">· {data?.root?.replace(/^\/home\/[^/]+/, '~') ?? ''}</span>
        </h1>
        <div className="hstat">
          <span>{repos.length} repos</span>
          <span>⟳ fetch {data?.lastFetch ? ago(data.lastFetch) : '尚未'}</span>
          {mode === 'live' && (
            <span>
              <span className="dot-live" />
              即時
            </span>
          )}
          {isStatic && boot && (
            <a className="refresh" href={hrefFor(filter, expanded, pinned, quietOpen)} title="重新整理">
              資料 {ago(boot.generatedAt)} ⟳
            </a>
          )}
        </div>
      </header>

      <div className="chips">
        {(
          [
            ['active', `有動靜 ${activeRepos.length}`],
            ['pinned', `已釘選 ${pinned.length}`],
            ['all', `全部 ${repos.length}`],
          ] as [Filter, string][]
        ).map(([f, label]) =>
          isStatic ? (
            <a key={f} className={`chip${filter === f ? ' on' : ''}`} href={hrefFor(f, expanded, pinned, quietOpen)}>
              {label}
            </a>
          ) : (
            <div key={f} className={`chip${filter === f ? ' on' : ''}`} onClick={() => setLiveFilter(f)}>
              {label}
            </div>
          ),
        )}
      </div>

      {pushedMsg && isStatic && (
        <div className="toast ok">
          已推送 <span className="mono">{pushedMsg}</span>
          <a href={hrefFor(filter, expanded, pinned, quietOpen)}>✕</a>
        </div>
      )}
      {pushErrMsg && isStatic && (
        <div className="toast err">
          推送失敗：{pushErrMsg}
          <a href={hrefFor(filter, expanded, pinned, quietOpen)}>✕</a>
        </div>
      )}

      {connErr && mode === 'live' && <div className="pad connerr">API 連不上：{connErr}</div>}
      {data === null && <div className="dim pad">{mode === 'probing' ? '載入中…' : '連線中…'}</div>}
      {data !== null && repos.length === 0 && <div className="dim pad">初始掃描中…</div>}

      {shown.map((r) => {
        const inner = (
          <>
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
          </>
        )
        const pinHref = hrefFor(filter, expanded, toggled(pinned, r.id), quietOpen)
        const expandHref = hrefFor(filter, toggled(expanded, r.id), pinned, quietOpen)
        return (
          <div className="card" key={r.id}>
            <div className="card-h">
              {isStatic ? (
                <a className="pin" style={{ opacity: pinnedSet.has(r.id) ? 1 : 0.25 }} href={pinHref} title="釘選">
                  📌
                </a>
              ) : (
                <span
                  className="pin"
                  style={{ opacity: pinnedSet.has(r.id) ? 1 : 0.25 }}
                  onClick={() => setLivePinned((p) => toggled(p, r.id))}
                  title="釘選"
                >
                  📌
                </span>
              )}
              {isStatic ? (
                <a className="grow" href={expandHref}>
                  {inner}
                </a>
              ) : (
                <div className="grow" onClick={() => toggleExpand(r.id)}>
                  {inner}
                </div>
              )}
            </div>
            {expanded.includes(r.id) &&
              (snaps[r.id] ? (
                <Graph snap={snaps[r.id]} onPush={openPush(r.id)} />
              ) : (
                <div className="dim pad">載入線圖…</div>
              ))}
          </div>
        )
      })}

      {quiet.length > 0 && (
        <div className="card">
          {(quietOpen ? quiet : quiet.slice(0, 3)).map((r) => {
            const inner = (
              <>
                <span className="name">{r.name}</span>
                <span className="mono qbranch">{r.headBranch}</span>
                <div className="right">
                  <span className="badge b-ok">✓</span>
                  <span>{ago(r.lastCommit)}</span>
                </div>
              </>
            )
            return isStatic ? (
              <a className="quiet-row" key={r.id} href={hrefFor(filter, toggled(expanded, r.id), pinned, quietOpen)}>
                {inner}
              </a>
            ) : (
              <div className="quiet-row" key={r.id} onClick={() => toggleExpand(r.id)}>
                {inner}
              </div>
            )
          })}
          {quiet.length > 3 &&
            (isStatic ? (
              <a className="fold" href={hrefFor(filter, expanded, pinned, !quietOpen)}>
                {quietOpen ? '▴ 收合' : `▾ 其餘 ${quiet.length - 3} 個安靜的 repo`}
              </a>
            ) : (
              <div className="fold" onClick={() => setLiveQuietOpen(!quietOpen)}>
                {quietOpen ? '▴ 收合' : `▾ 其餘 ${quiet.length - 3} 個安靜的 repo`}
              </div>
            ))}
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

      {pushTarget && (
        <PushDialog
          target={pushTarget}
          staticMode={isStatic}
          preview={boot?.previews?.[pushTarget.repoId]?.[pushTarget.branch.name]}
          backQuery={backQuery}
          onClose={() => setPushTarget(null)}
        />
      )}
    </div>
  )
}
