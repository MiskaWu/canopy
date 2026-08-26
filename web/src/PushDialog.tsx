import { useEffect, useState } from 'react'
import { doPush, fetchPushPreview } from './api'
import type { Branch, PushPreview } from './types'

export interface PushTarget {
  repoId: string
  branch: Branch
  remotes: string[]
}

interface Props {
  target: PushTarget
  onClose: () => void
}

export function PushDialog({ target, onClose }: Props) {
  const { repoId, branch, remotes } = target
  const [remote, setRemote] = useState(remotes[0] ?? 'origin')
  const [preview, setPreview] = useState<PushPreview | null>(null)
  const [confirmMain, setConfirmMain] = useState(false)
  const [state, setState] = useState<'idle' | 'pushing' | 'done'>('idle')
  const [error, setError] = useState('')

  const isMainline = branch.name === 'main' || branch.name === 'master'

  useEffect(() => {
    setPreview(null)
    fetchPushPreview(repoId, branch.name, remote)
      .then(setPreview)
      .catch((e) => setError(String(e)))
  }, [repoId, branch.name, remote])

  const commits = preview?.commits ?? []

  async function submit() {
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

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dlg" onClick={(e) => e.stopPropagation()}>
        <h3>
          推送 <span className="mono bname">{branch.name}</span>
        </h3>
        <div className="to">
          →{' '}
          {remotes.length > 1 ? (
            <select value={remote} onChange={(e) => setRemote(e.target.value)}>
              {remotes.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          ) : (
            <span className="mono">{remote}</span>
          )}
        </div>
        {preview === null && !error && <div className="dim">讀取 commit 清單…</div>}
        {commits.map((c) => (
          <div key={c.sha} className="cmt">
            <span className="sha mono">{c.sha}</span>
            <span>{c.subject}</span>
          </div>
        ))}
        {preview?.noUpstream && (
          <div className="hint">
            此分支尚無 upstream，將以 <span className="mono">-u</span> 建立{' '}
            <span className="mono">
              {remote}/{branch.name}
            </span>
          </div>
        )}
        {isMainline && (
          <label className="hint danger">
            <input type="checkbox" checked={confirmMain} onChange={(e) => setConfirmMain(e.target.checked)} />{' '}
            我確定要推主線分支 {branch.name}
          </label>
        )}
        {error && <div className="hint danger">{error}</div>}
        <div className="btns">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button
            className="btn primary"
            disabled={state !== 'idle' || commits.length === 0 || (isMainline && !confirmMain)}
            onClick={submit}
          >
            {state === 'pushing' ? '推送中…' : state === 'done' ? '完成 ✓' : `推送 ${commits.length} 個 commit`}
          </button>
        </div>
      </div>
    </div>
  )
}
