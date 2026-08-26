import { useEffect, useState } from 'react'
import { doPush, fetchPushPreview } from './api'
import type { Branch, PushPreviewEntry } from './types'

export interface PushTarget {
  repoId: string
  branch: Branch
  remotes: string[]
}

interface Props {
  target: PushTarget
  staticMode: boolean // true = 面板的殼：用表單 POST 導航送出，資料來自嵌入的 preview
  preview?: PushPreviewEntry
  backQuery: string
  onClose: () => void
}

export function PushDialog({ target, staticMode, preview, backQuery, onClose }: Props) {
  const { repoId, branch, remotes } = target
  const [remote, setRemote] = useState(remotes.includes('origin') ? 'origin' : (remotes[0] ?? 'origin'))
  const [livePreview, setLivePreview] = useState<PushPreviewEntry | null>(null)
  const [confirmMain, setConfirmMain] = useState(false)
  const [state, setState] = useState<'idle' | 'pushing' | 'done'>('idle')
  const [error, setError] = useState('')

  const isMainline = branch.name === 'main' || branch.name === 'master'

  useEffect(() => {
    if (staticMode) return
    setLivePreview(null)
    fetchPushPreview(repoId, branch.name, remote)
      .then((p) => setLivePreview({ commits: p.commits, noUpstream: p.noUpstream }))
      .catch((e) => setError(String(e)))
  }, [staticMode, repoId, branch.name, remote])

  const pv = staticMode ? preview : livePreview
  const commits = pv?.commits ?? []
  const noUpstream = pv?.noUpstream ?? branch.noUpstream
  const count = commits.length || branch.ahead

  async function submitLive() {
    setState('pushing')
    setError('')
    try {
      await doPush(repoId, branch.name, remote, confirmMain)
      setState('done')
      setTimeout(onClose, 600)
    } catch (e) {
      setState('idle')
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const body = (
    <>
      <h3>
        推送 <span className="mono bname">{branch.name}</span>
      </h3>
      <div className="to">
        →{' '}
        {remotes.length > 1 ? (
          <select name="remote" value={remote} onChange={(e) => setRemote(e.target.value)}>
            {remotes.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        ) : (
          <span className="mono">{remote}</span>
        )}
      </div>
      {!staticMode && pv === null && !error && <div className="dim">讀取 commit 清單…</div>}
      {commits.map((c) => (
        <div key={c.sha} className="cmt">
          <span className="sha mono">{c.sha}</span>
          <span>{c.subject}</span>
        </div>
      ))}
      {staticMode && commits.length === 0 && (
        <div className="dim">（無嵌入的預覽，將推送 {branch.ahead} 個 commit）</div>
      )}
      {noUpstream && (
        <div className="hint">
          此分支尚無 upstream，將以 <span className="mono">-u</span> 建立{' '}
          <span className="mono">
            {remote}/{branch.name}
          </span>
        </div>
      )}
      {isMainline && (
        <label className="hint danger">
          <input
            type="checkbox"
            name="confirmMain"
            value="1"
            checked={confirmMain}
            onChange={(e) => setConfirmMain(e.target.checked)}
          />{' '}
          我確定要推主線分支 {branch.name}
        </label>
      )}
      {error && <div className="hint danger">{error}</div>}
    </>
  )

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dlg" onClick={(e) => e.stopPropagation()}>
        {staticMode ? (
          <form method="POST" action="/api/push">
            <input type="hidden" name="id" value={repoId} />
            <input type="hidden" name="branch" value={branch.name} />
            <input type="hidden" name="back" value={backQuery} />
            {remotes.length <= 1 && <input type="hidden" name="remote" value={remote} />}
            {body}
            <div className="btns">
              <button type="button" className="btn" onClick={onClose}>
                取消
              </button>
              <button type="submit" className="btn primary" disabled={count === 0 || (isMainline && !confirmMain)}>
                推送 {count} 個 commit
              </button>
            </div>
          </form>
        ) : (
          <>
            {body}
            <div className="btns">
              <button className="btn" onClick={onClose}>
                取消
              </button>
              <button
                className="btn primary"
                disabled={state !== 'idle' || count === 0 || (isMainline && !confirmMain)}
                onClick={submitLive}
              >
                {state === 'pushing' ? '推送中…' : state === 'done' ? '完成 ✓' : `推送 ${count} 個 commit`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
