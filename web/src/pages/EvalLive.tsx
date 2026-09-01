import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api, errText } from '../lib/api'
import type { Run } from '../lib/types'
import { Banner, Mono, PageHead, Panel, Spinner, StateBadge } from '../components/ui'

export default function EvalLive() {
  const { id } = useParams()
  const q = useQuery({
    queryKey: ['runs', id],
    queryFn: () => api.get<{ runs: Run[] }>(`/api/projects/${id}/runs`),
    refetchInterval: 5000,
  })

  const runs = q.data?.runs ?? []

  return (
    <>
      <PageHead title="Eval live space" sub="Per-eval status, updated every 5s" />
      {q.isError && <Banner tone="danger">{errText(q.error)}</Banner>}
      {q.isLoading && <Spinner label="Loading runs…" />}

      <Panel title={`Runs (${runs.length})`}>
        {runs.length === 0 && <div className="empty"><div className="title">No runs yet</div>Start a queue to see live per-eval progress.</div>}
        {runs.length > 0 && (
          <table>
            <thead><tr><th>Run</th><th>Eval</th><th>Agent</th><th>Model</th><th>Status</th><th>Reward</th><th>Error</th></tr></thead>
            <tbody>{runs.map((r) => (
              <tr key={r.id}>
                <td><Mono copy>{r.id}</Mono></td>
                <td><Mono copy>{r.taskId ?? '—'}</Mono></td>
                <td><Mono>{r.agentId ?? '—'}</Mono></td>
                <td><Mono>{r.model ?? '—'}</Mono></td>
                <td><StateBadge state={r.status} /></td>
                <td className="num">{r.officialReward ?? '—'}</td>
                <td style={{ color: r.error ? 'var(--danger)' : 'var(--text-faint)' }}>{r.error ?? '—'}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Panel>
    </>
  )
}
