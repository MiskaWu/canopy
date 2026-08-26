import type { PushPreview, ReposResponse, Snapshot } from './types'

async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: ${res.status}`)
  return res.json()
}

export const fetchRepos = () => getJSON<ReposResponse>('/api/repos')

export const fetchRepo = (id: string) =>
  getJSON<Snapshot>(`/api/repo?id=${encodeURIComponent(id)}`)

export const fetchPushPreview = (id: string, branch: string, remote: string) =>
  getJSON<PushPreview>(
    `/api/push-preview?id=${encodeURIComponent(id)}&branch=${encodeURIComponent(branch)}&remote=${encodeURIComponent(remote)}`,
  )

export async function doPush(id: string, branch: string, remote: string, confirmMain: boolean) {
  const res = await fetch('/api/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, branch, remote, confirmMain }),
  })
  const body = await res.json()
  if (!res.ok) throw new Error(body.error ?? `push failed: ${res.status}`)
  return body as { ok: boolean; output: string }
}

export type ServerEvent = { type: 'repo'; id: string } | { type: 'fetch'; at: number }

// SSE 訂閱；EventSource 斷線會自動重連。
export function subscribe(onEvent: (ev: ServerEvent) => void): () => void {
  const es = new EventSource('/api/events')
  es.onmessage = (m) => {
    try {
      onEvent(JSON.parse(m.data))
    } catch {
      /* 忽略非 JSON 的心跳 */
    }
  }
  return () => es.close()
}

// localStorage 便利包裝：讀寫都可能丟例外（隱私模式等），一律吞掉用預設值。
export function loadLS<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

export function saveLS(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* ignore */
  }
}
