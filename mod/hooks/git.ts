import type { CanopyBranch, CanopyCommit, CanopySnapshot, CanopyWorktree } from '../types'

// 快照組裝：server/store.go buildSnapshot 的移植，範圍縮到 session 所在的那一個 repo
// （連同它所有的 worktree）。git 是唯一真相來源，這裡只讀不寫。

/** 跑一條 git 指令，成功回 stdout（去掉尾端換行），失敗一律回 ''。 */
export type Git = (args: readonly string[], cwd: string) => Promise<string>

/** 某個 worktree 路徑對應的 Claude session 最後活動時間（毫秒），沒有就 null。 */
export type SessionProbe = (worktreePath: string) => Promise<number | null>

export class NotARepo extends Error {}

const LIVE_WINDOW_MS = 5 * 60 * 1000
const SEP = '\x1f'

export async function buildSnapshot(
  git: Git,
  cwd: string,
  limit: number,
  probe: SessionProbe,
  now: number,
): Promise<CanopySnapshot> {
  const top = await git(['rev-parse', '--show-toplevel'], cwd)
  if (top === '') throw new NotARepo(cwd)

  const [cwdBranch, headSha, remoteOut, wtOut] = await Promise.all([
    git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
    git(['rev-parse', 'HEAD'], cwd),
    git(['remote'], cwd),
    git(['worktree', 'list', '--porcelain'], cwd),
  ])
  const remotes = lines(remoteOut)
  const noRemote = remotes.length === 0

  // worktree 清單：第一筆是主 worktree。detached 的 HEAD 另外收進 log 範圍。
  const parsed = parseWorktrees(wtOut)
  const main = parsed[0]
  const repoPath = main?.path ?? top
  const detached = parsed.flatMap(w => (w.detachedSha === null ? [] : [w.detachedSha]))
  const worktrees = await Promise.all(
    parsed.map(async (w): Promise<[string | null, CanopyWorktree]> => {
      const [status, last] = await Promise.all([git(['status', '--porcelain'], w.path), probe(w.path)])
      const session = last === null ? null : { isLive: now - last < LIVE_WINDOW_MS, lastActive: Math.floor(last / 1000) }
      const name = w.path.split('/').pop() ?? w.path
      return [w.branch, { path: w.path, name, isMain: w.path === repoPath, isDirty: status !== '', session }]
    }),
  )
  const wtByBranch = new Map<string, CanopyWorktree>()
  for (const [branch, wt] of worktrees) if (branch !== null) wtByBranch.set(branch, wt)

  // 「已合併」以主 worktree 的分支為準：worktree 流程裡分支是併進 main 才算數。
  const mainBranch = main?.branch ?? ''
  const mergedTarget = mainBranch === '' ? 'HEAD' : `refs/heads/${mainBranch}`
  const [mergedOut, refOut, logOut] = await Promise.all([
    git(['for-each-ref', '--merged', mergedTarget, '--format=%(refname:short)', 'refs/heads'], repoPath),
    git(['for-each-ref', 'refs/heads', `--format=%(refname:short)${SEP}%(objectname)${SEP}%(upstream:short)${SEP}%(upstream:track)`], repoPath),
    git(
      ['log', '--topo-order', '-n', String(limit), `--format=%H${SEP}%P${SEP}%ct${SEP}%D${SEP}%an${SEP}%s`, '--exclude=refs/stash', '--all', ...detached],
      repoPath,
    ),
  ])
  const merged = new Set(lines(mergedOut))

  const branches: CanopyBranch[] = []
  for (const line of lines(refOut)) {
    const [name = '', sha = '', upstream = '', trackRaw = ''] = line.split(SEP)
    if (name === '') continue
    const track = trackRaw.replace(/^\[|\]$/g, '')
    const b: CanopyBranch = {
      name,
      sha,
      upstream: upstream === '' ? null : upstream,
      ahead: 0,
      behind: 0,
      noUpstream: upstream === '',
      gone: track === 'gone',
      merged: merged.has(name),
      isCurrent: name === cwdBranch,
      worktree: wtByBranch.get(name) ?? null,
    }
    for (const part of track.split(', ')) {
      const ahead = /^ahead (\d+)$/.exec(part)
      const behind = /^behind (\d+)$/.exec(part)
      if (ahead) b.ahead = Number(ahead[1])
      if (behind) b.behind = Number(behind[1])
    }
    branches.push(b)
  }

  // 沒有 upstream（或 upstream 消失）的分支：未推數＝不在任何 remote 上的 commit 數
  if (!noRemote) {
    await pool(
      branches.filter(b => b.noUpstream || b.gone),
      8,
      async b => {
        const n = await git(['rev-list', '--count', `refs/heads/${b.name}`, '--not', '--remotes'], repoPath)
        b.ahead = Number(n) || 0
      },
    )
  }

  const commits: CanopyCommit[] = []
  for (const line of lines(logOut)) {
    const f = line.split(SEP)
    if (f.length < 6) continue
    const [sha = '', parents = '', time = '', decor = '', author = ''] = f
    const refs = decor === '' ? [] : decor.split(', ').map(r => r.replace(/^HEAD -> /, '')).filter(r => r !== '' && r !== 'HEAD')
    commits.push({
      sha,
      parents: parents === '' ? [] : parents.split(' '),
      time: Number(time),
      refs,
      author,
      subject: f.slice(5).join(SEP),
    })
  }

  return {
    repoName: repoPath.split('/').pop() ?? repoPath,
    repoPath,
    cwdBranch,
    headSha,
    mainBranch,
    noRemote,
    remotes,
    branches,
    commits,
    builtAt: now,
  }
}

type ParsedWorktree = { path: string; branch: string | null; detachedSha: string | null }

export function parseWorktrees(out: string): ParsedWorktree[] {
  const result: ParsedWorktree[] = []
  for (const block of out.split('\n\n')) {
    let path = ''
    let branch: string | null = null
    let head: string | null = null
    let isDetached = false
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length)
      else if (line.startsWith('branch refs/heads/')) branch = line.slice('branch refs/heads/'.length)
      else if (line.startsWith('HEAD ')) head = line.slice('HEAD '.length)
      else if (line === 'detached') isDetached = true
    }
    if (path !== '') result.push({ path, branch, detachedSha: isDetached ? head : null })
  }
  return result
}

/** Claude Code 存放 session 記錄的資料夾名：路徑裡非英數字元一律換成 `-`。 */
export function projectDirName(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-')
}

function lines(out: string): string[] {
  return out.split('\n').filter(line => line !== '')
}

async function pool<T>(items: readonly T[], width: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const lane = async () => {
    while (next < items.length) {
      const item = items[next++] as T
      await fn(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, lane))
}
