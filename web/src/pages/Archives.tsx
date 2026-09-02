import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, errText } from '../lib/api'
import { Banner, Empty, Mono, PageHead, Panel, Spinner, StateBadge, Tabs } from '../components/ui'

interface PhaseState {
  sealed: 'base' | 'phase1' | 'phase2'
  phase1: { trackId: string; resultVersionId: string; sealedAt: string } | null
  phase2: { campaignId: string; state: string; memberCount: number; publishedAt: string | null } | null
}

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
  phase?: PhaseState
}

// The layer actually sealed over the base evidence, plus what is still in
// flight. A phase2 record that has not reached `published` means the campaign
// wrote artifacts but the resealed view is not the archive of record yet.
function sealLabel(phase: PhaseState | undefined): { text: string; cls: string; title: string } {
  if (!phase || phase.sealed === 'base') {
    const pending = phase?.phase2 && phase.phase2.state !== 'published'
    return {
      text: 'Base',
      cls: 'chip',
      title: pending ? `Base evidence only. Phase-2 publication is ${phase!.phase2!.state}.` : 'Base evidence only. Not judged.',
    }
  }
  if (phase.sealed === 'phase1') {
    const p2 = phase.phase2 ? ` Phase-2 publication is ${phase.phase2.state}.` : ''
    return { text: 'Phase 1', cls: 'chip phase1', title: `Sealed with a judge/ view over the base.${p2}` }
  }
  return { text: 'Phase 2', cls: 'chip phase2', title: 'Resealed with a phase2/ view over the Phase-1 view.' }
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
    queryFn: () => api.text(`/api/archives/${detailId}/files/${filePath}`),
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
            <thead><tr><th>Run</th><th>Task</th><th>Agent</th><th>Model</th><th>Status</th><th>Sealed at</th><th>Campaign</th><th>Reward</th><th>Date</th><th /></tr></thead>
            <tbody>{rows.map((a) => {
              const seal = sealLabel(a.phase)
              return (
              <tr key={a.runId}>
                <td><Mono copy>{a.runId}</Mono></td>
                <td style={{ color: 'var(--text)' }}>{a.taskName ?? '—'}</td>
                <td><Mono>{a.agent?.id ?? '—'}</Mono></td>
                <td><Mono>{a.model ?? '—'}</Mono></td>
                <td><StateBadge state={a.status} /></td>
                <td><span className={seal.cls} title={seal.title}>{seal.text}</span></td>
                <td>{a.phase?.phase2
                  ? <span title={`Publication ${a.phase.phase2.state}`}><Mono>{a.phase.phase2.campaignId}</Mono> <span className="hint">{a.phase.phase2.memberCount} evals</span></span>
                  : '—'}</td>
                <td className="num">{a.reward ?? '—'}</td>
                <td><Mono>{a.sealedAt ? String(a.sealedAt).slice(0, 10) : '—'}</Mono></td>
                <td><button onClick={() => { setDetailId(a.runId); setFilePath(null) }}>Files</button></td>
              </tr>
            )})}</tbody>
          </table>
        </Panel>
      )}

      {detail && (
        <Panel title={<span>Archive <Mono copy>{detail.runId}</Mono></span>}>
          <div className="badge-row" style={{ marginBottom: 'var(--s3)' }}>
            <span className={sealLabel(detail.phase).cls}>{sealLabel(detail.phase).text}</span>
            {detail.phase?.phase1 && <span className="hint">judge track {detail.phase.phase1.trackId}, result {detail.phase.phase1.resultVersionId}</span>}
            {detail.phase?.phase2 && <span className="hint">campaign {detail.phase.phase2.campaignId} over {detail.phase.phase2.memberCount} evals, publication {detail.phase.phase2.state}</span>}
            {!detail.phase?.phase1 && !detail.phase?.phase2 && <span className="hint">base evidence only, no judgement sealed over it</span>}
          </div>
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
