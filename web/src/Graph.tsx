import { useMemo } from 'react'
import { layoutGraph } from './lanes'
import type { Branch, Snapshot } from './types'

const LC = ['#6cb0f0', '#58c98b', '#e0a84f', '#d585d0', '#55c6c0', '#9a8cf0']
const RH = 34
const X0 = 12
const XW = 15

function ago(unix: number): string {
  const s = Math.max(1, Math.floor(Date.now() / 1000 - unix))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

interface Props {
  snap: Snapshot
  onPush: (branch: Branch) => void
}

export function Graph({ snap, onPush }: Props) {
  const commits = snap.commits ?? []
  const branches = snap.branches ?? []
  const layout = useMemo(() => layoutGraph(commits, snap.headSha), [commits, snap.headSha])

  const byTip = useMemo(() => {
    const m = new Map<string, Branch[]>()
    for (const b of branches) {
      const list = m.get(b.sha) ?? []
      list.push(b)
      m.set(b.sha, list)
    }
    return m
  }, [branches])

  const gw = X0 + layout.maxLane * XW + 14
  const cx = (lane: number) => X0 + lane * XW
  const cy = (row: number) => row * RH + RH / 2

  const paths: React.ReactElement[] = []
  layout.edges.forEach((e, k) => {
    const x1 = cx(e.fromLane)
    const y1 = cy(e.fromRow)
    const x2 = cx(e.toLane)
    const y2 = cy(e.toRow)
    const col = LC[Math.max(e.fromLane, e.toLane) % LC.length]
    if (x1 === x2) {
      paths.push(<line key={k} x1={x1} y1={y1} x2={x2} y2={y2} stroke={col} strokeWidth={2} />)
    } else if (e.toRow - e.fromRow === 1) {
      paths.push(
        <path key={k} d={`M ${x1} ${y1} C ${x1} ${y1 + RH * 0.7}, ${x2} ${y2 - RH * 0.7}, ${x2} ${y2}`}
          stroke={col} strokeWidth={2} fill="none" />,
      )
    } else {
      const yb = cy(e.toRow - 1)
      paths.push(
        <g key={k} stroke={col} strokeWidth={2} fill="none">
          <line x1={x1} y1={y1} x2={x1} y2={yb} />
          <path d={`M ${x1} ${yb} C ${x1} ${yb + RH * 0.7}, ${x2} ${y2 - RH * 0.7}, ${x2} ${y2}`} />
        </g>,
      )
    }
  })
  layout.stubs.forEach((s, k) => {
    const x = cx(s.lane)
    const y = cy(s.row)
    paths.push(
      <line key={`s${k}`} x1={x} y1={y} x2={x} y2={y + 14} stroke={LC[s.lane % LC.length]}
        strokeWidth={2} opacity={0.35} strokeDasharray="2 3" />,
    )
  })

  return (
    <div className="graph">
      <svg width={gw} height={commits.length * RH}>
        {paths}
        {commits.map((c, i) => {
          const lane = layout.lanes[i]
          const col = LC[lane % LC.length]
          const isMerge = (c.parents?.length ?? 0) > 1
          const isHead = c.sha === snap.headSha
          return (
            <g key={c.sha}>
              {isHead && <circle cx={cx(lane)} cy={cy(i)} r={7} fill="none" stroke={col} strokeWidth={1.5} opacity={0.55} />}
              <circle cx={cx(lane)} cy={cy(i)} r={isMerge ? 3 : 4}
                fill={isMerge ? 'var(--bg)' : col} stroke={col} strokeWidth={2} />
            </g>
          )
        })}
      </svg>
      <div className="rows">
        {commits.map((c, i) => {
          const lane = layout.lanes[i]
          const col = LC[lane % LC.length]
          const tips = byTip.get(c.sha) ?? []
          const isMerge = (c.parents?.length ?? 0) > 1
          const localNames = new Set(tips.map((b) => b.name))
          const remoteRefs = (c.refs ?? []).filter((r) => !localNames.has(r))
          const pad = gw + 10
          return (
            <div key={c.sha} className="row" style={{ paddingLeft: pad, ['--gx' as string]: `${pad}px` }}>
              {tips.map((b) => (
                <TipChips key={b.name} b={b} col={col} noRemote={snap.noRemote} onPush={onPush} />
              ))}
              {remoteRefs.map((r) => (
                <span key={r} className="bch refchip">{r}</span>
              ))}
              <span className={`sub${isMerge ? ' merge' : ''}`}>{c.subject}</span>
              <span className="sha mono">{c.sha.slice(0, 7)}</span>
              <span className="age">{ago(c.time)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function TipChips({ b, col, noRemote, onPush }: { b: Branch; col: string; noRemote: boolean; onPush: (b: Branch) => void }) {
  const canPush = !noRemote && b.ahead > 0
  const wt = b.worktree
  return (
    <>
      <span className="bch" style={{ color: col, background: `${col}1a`, borderColor: `${col}55` }}>
        {b.name}
        {b.isHead ? ' · HEAD' : ''}
      </span>
      {canPush && (
        <button className="push" title={`推送 ${b.name}`} onClick={() => onPush(b)}>
          ↑{b.ahead}
        </button>
      )}
      {wt && !wt.main && <span className="wt">⌂ {wt.name}</span>}
      {wt?.session &&
        (wt.session.state === 'live' ? (
          <span className="sess live">●</span>
        ) : (
          <span className="sess idle">○ {ago(wt.session.lastActive)}</span>
        ))}
      {wt?.dirty && <span className="badge b-dirty">✎ 未commit</span>}
      {b.noUpstream && !noRemote && <span className="badge b-ahead">無upstream</span>}
      {b.gone && <span className="badge b-stale">upstream 已消失</span>}
      {b.ahead > 0 && b.behind > 0 && <span className="badge b-div">⚠ ↑{b.ahead}↓{b.behind}</span>}
      {b.merged && !b.isHead && <span className="badge b-ok">✓ 已合併</span>}
    </>
  )
}
