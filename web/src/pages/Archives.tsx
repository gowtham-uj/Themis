import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, errText } from '../lib/api'
import type { ArchiveRow } from '../lib/types'
import { Banner, Empty, Mono, PageHead, Panel, Spinner, StateBadge } from '../components/ui'

interface ArchiveList { archives: ArchiveRow[]; total?: number }

function runLabel(archive: ArchiveRow): string {
  return archive.runName || (archive.runOrdinal != null ? `Run ${archive.runOrdinal}` : 'Unlinked run')
}

function layerLabel(archive: ArchiveRow): string {
  if (archive.phase.sealed === 'phase2') return 'Phase 2'
  if (archive.phase.sealed === 'phase1') return 'Phase 1'
  return 'Base'
}

export default function Archives() {
  const qc = useQueryClient()
  const [params] = useSearchParams()
  const pipelineRunId = params.get('pipeline_run_id')
  const [filter, setFilter] = useState('')
  const path = pipelineRunId ? `/api/archives?pipeline_run_id=${encodeURIComponent(pipelineRunId)}` : '/api/archives'
  const q = useQuery({ queryKey: ['archives', pipelineRunId], queryFn: () => api.get<ArchiveList>(path) })

  const clearAll = useMutation({
    mutationFn: () => api.del<{ deleted_rows: number; deleted_dirs: number }>('/api/archives'),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['archives'] }),
  })

  const rows = useMemo(() => {
    const term = filter.trim().toLowerCase()
    if (!term) return q.data?.archives ?? []
    return (q.data?.archives ?? []).filter((archive) =>
      [
        archive.runName,
        archive.runId,
        archive.projectName,
        archive.taskName,
        archive.agent.name,
        archive.agent.id,
        archive.model,
      ].some((value) => String(value ?? '').toLowerCase().includes(term)),
    )
  }, [filter, q.data?.archives])

  return (
    <>
      <PageHead
        title="Archives"
        sub={pipelineRunId ? <span>Archives for run <Mono>{pipelineRunId}</Mono></span> : `${q.data?.total ?? rows.length} sealed eval results`}
        actions={<>
          {pipelineRunId && <Link to="/archives"><button>All archives</button></Link>}
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Search run, project, eval, agent…"
            aria-label="Search archives"
            className="archive-search"
          />
          {!pipelineRunId && (
            <button
              className="danger"
              disabled={clearAll.isPending || rows.length === 0}
              onClick={() => {
                if (confirm('Delete every archive, its files, and its blobs? This cannot be undone.')) clearAll.mutate()
              }}
            >
              {/* "Clear all" sat next to the search box and read as "clear the
                  filter". It deletes every sealed archive and its blobs. */}
              {clearAll.isPending ? 'Deleting…' : 'Delete all archives'}
            </button>
          )}
        </>}
      />

      {q.isError && <Banner tone="danger">{errText(q.error)}</Banner>}
      {clearAll.isError && <Banner tone="danger">{errText(clearAll.error)}</Banner>}
      {q.isLoading && <Spinner label="Loading archives…" />}

      {!q.isLoading && rows.length === 0 && (
        <Empty title={filter ? 'No archives match that search' : 'No archives yet'}>
          {filter ? <button onClick={() => setFilter('')}>Clear search</button> : 'Archives appear after an eval seals its base evidence.'}
        </Empty>
      )}

      {rows.length > 0 && (
        <Panel title={`Sealed evals (${rows.length})`}>
          <div className="archive-list" role="list">
            {rows.map((archive) => (
              <Link className="archive-list-row" to={`/archives/${archive.runId}`} key={archive.runId} role="listitem">
                <div className="archive-primary">
                  <strong>{archive.taskName || 'Unnamed eval'}</strong>
                  <span>{runLabel(archive)} · {archive.projectName || archive.projectId}</span>
                </div>
                <div className="archive-agent">
                  <span>{archive.agent.name || archive.agent.id || 'Unknown agent'}</span>
                  <Mono>{archive.model || 'default model'}</Mono>
                </div>
                <span className={`chip ${archive.phase.sealed === 'phase2' ? 'phase2' : archive.phase.sealed === 'phase1' ? 'phase1' : ''}`}>
                  {layerLabel(archive)}
                </span>
                {archive.reward == null
                  ? <StateBadge state={archive.status} />
                  : <span className={`chip ${archive.reward === 1 ? 'pass' : 'fail'}`}>{archive.reward === 1 ? 'Passed' : 'Failed'}</span>}
                <time dateTime={archive.archivedAt}>{new Date(archive.archivedAt).toLocaleString()}</time>
                <span className="archive-open" aria-hidden="true">Open</span>
              </Link>
            ))}
          </div>
        </Panel>
      )}
    </>
  )
}
