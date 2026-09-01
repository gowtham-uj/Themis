import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, errText } from '../lib/api'
import { Banner, Empty, Mono, PageHead, Panel, Spinner, StateBadge, Tabs } from '../components/ui'

interface ArchiveRow {
  runId: string
  projectName?: string | null
  queueName?: string | null
  taskName?: string | null
  agent?: { id?: string; commit?: string | null; image?: string | null }
  model?: string
  status?: string
  reward?: number | null
  sealedAt?: string
}

interface ArchiveList { archives: ArchiveRow[]; total?: number }

// High-signal files in every sealed archive (base layout). Served via
// /api/archives/:runId/files/<path>.
const KNOWN_FILES = [
  'eval_lifecycle_logs/events.jsonl',
  'eval_lifecycle_logs/run.json',
  'eval_lifecycle_logs/run-metrics.json',
  'eval_lifecycle_logs/eval.json',
  'diffs/diff.patch',
  'raw_std/raw-stdout.log',
  'raw_std/raw-stderr.log',
]

export default function Archives() {
  const [filter, setFilter] = useState('')
  const [detailId, setDetailId] = useState<string | null>(null)
  const [filePath, setFilePath] = useState<string | null>(null)

  const q = useQuery({ queryKey: ['archives'], queryFn: () => api.get<ArchiveList>('/api/archives') })

  const file = useQuery({
    queryKey: ['archive-file', detailId, filePath],
    enabled: !!detailId && !!filePath,
    queryFn: () => api.get<string>(`/api/archives/${detailId}/files/${filePath}`).then((t) => t as string),
    retry: false,
  })

  const rows = (q.data?.archives ?? []).filter((a) => {
    if (!filter) return true
    const f = filter.toLowerCase()
    return [a.taskName, a.agent?.id, a.model, a.runId, a.projectName].some((s) => String(s ?? '').toLowerCase().includes(f))
  })

  const detail = rows.find((r) => r.runId === detailId)

  return (
    <>
      <PageHead
        title="Archives"
        sub={`${q.data?.total ?? rows.length} sealed eval results`}
        actions={<input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by task, agent, model, run…" style={{ minWidth: 280 }} aria-label="Filter archives" />}
      />
      {q.isError && <Banner tone="danger">{errText(q.error)}</Banner>}
      {q.isLoading && <Spinner label="Loading archives…" />}

      {!q.isLoading && rows.length === 0 && <Empty title={filter ? 'No archives match that filter' : 'No archives yet'}>{filter ? <button onClick={() => setFilter('')}>Clear filter</button> : undefined}</Empty>}

      {rows.length > 0 && (
        <Panel title="Sealed runs">
          <table>
            <thead><tr><th>Run</th><th>Task</th><th>Agent</th><th>Model</th><th>Status</th><th>Reward</th><th>Sealed</th><th /></tr></thead>
            <tbody>{rows.map((a) => (
              <tr key={a.runId}>
                <td><Mono copy>{a.runId}</Mono></td>
                <td style={{ color: 'var(--text)' }}>{a.taskName ?? '—'}</td>
                <td><Mono>{a.agent?.id ?? '—'}</Mono></td>
                <td><Mono>{a.model ?? '—'}</Mono></td>
                <td><StateBadge state={a.status} /></td>
                <td className="num">{a.reward ?? '—'}</td>
                <td><Mono>{a.sealedAt ? String(a.sealedAt).slice(0, 10) : '—'}</Mono></td>
                <td><button onClick={() => { setDetailId(a.runId); setFilePath(null) }}>Files</button></td>
              </tr>
            ))}</tbody>
          </table>
        </Panel>
      )}

      {detail && (
        <Panel title={<span>Archive <Mono copy>{detail.runId}</Mono></span>}>
          <Tabs tabs={KNOWN_FILES.map((f) => f.split('/').pop()!)} active={filePath ? filePath.split('/').pop()! : KNOWN_FILES[0]!.split('/').pop()!}
            onChange={(name) => setFilePath(KNOWN_FILES.find((f) => f.endsWith(name))!)} />
          {file.isLoading && <Spinner label="Reading file…" />}
          {file.isError && <Banner tone="danger">Cannot read that file: {errText(file.error)}</Banner>}
          {file.data !== undefined && <pre className="code" style={{ maxHeight: 480 }}>{file.data}</pre>}
        </Panel>
      )}
    </>
  )
}
