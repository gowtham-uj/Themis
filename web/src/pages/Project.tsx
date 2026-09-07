import { Link, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api, errText } from '../lib/api'
import type { Adapter, EvalQueue, EvalTask, PipelineRunSummary, Project } from '../lib/types'
import { Banner, CategoryChip, Empty, Mono, PageHead, Panel, StateBadge } from '../components/ui'

export default function Project() {
  const { id } = useParams()
  const p = useQuery({ queryKey: ['project', id], queryFn: () => api.get<Project>(`/api/projects/${id}`) })
  const adapters = useQuery({ queryKey: ['adapters', id], queryFn: () => api.get<{ adapters: Adapter[] }>(`/api/projects/${id}/adapters`) })
  const evals = useQuery({ queryKey: ['evals', id], queryFn: () => api.get<{ evals: EvalTask[] }>(`/api/projects/${id}/evals`) })
  const queues = useQuery({ queryKey: ['queues', id], queryFn: () => api.get<{ queues: { queue: EvalQueue; items: unknown[] }[] }>(`/api/projects/${id}/queues`) })
  const runs = useQuery({
    queryKey: ['pipeline-runs', id],
    queryFn: () => api.get<{ runs: PipelineRunSummary[]; total: number; active: number }>(`/api/projects/${id}/pipeline/runs`),
    refetchInterval: (query) => query.state.data?.active ? 3000 : false,
  })

  const adapter = adapters.data?.adapters[0]
  const queueRow = queues.data?.queues[0]
  // The server resolves this the same way for every project, so prefer it over a
  // client-side guess: the two used to disagree, and the projects list showed
  // "—" for a project whose detail page named the agent.
  const agentName = adapter?.name ?? adapter?.agent_id ?? adapter?.agentId ?? p.data?.resolved_agent_id ?? p.data?.default_agent_id ?? queueRow?.queue.builtinAdapterId ?? 'not set'

  return (
    <>
      <PageHead
        title={p.data?.name ?? 'Project'}
        sub={p.data?.description || 'One agent, one eval store, one queue.'}
        actions={<>
          <Link to={`/projects/${id}/queue`}><button className="primary">Start a run</button></Link>
          <Link to={`/projects/${id}/evals`}><button>Evals</button></Link>
          <Link to={`/projects/${id}/settings`}><button>Settings</button></Link>
        </>}
      />

      {p.isError && <Banner tone="danger">{errText(p.error)}</Banner>}
      {runs.isError && <Banner tone="danger">Cannot load runs: {errText(runs.error)}</Banner>}

      <div className="summary-strip" aria-label="Project run summary">
        <div><span>Runs</span><strong>{runs.data?.total ?? 0}</strong></div>
        <div><span>Active</span><strong>{runs.data?.active ?? 0}</strong></div>
        <div><span>Evals in store</span><strong>{evals.data?.evals.length ?? 0}</strong></div>
        <div><span>Queued</span><strong>{queueRow?.items.length ?? 0}</strong></div>
      </div>

      <Panel title="Runs" actions={<Link to={`/projects/${id}/queue`}><button className="primary">New run</button></Link>}>
        {runs.data?.runs.length === 0 && (
          <Empty title="No runs yet">
            A run is one independent copy of the queue blueprint. Name it when you start, then watch every eval and archive from its own panel.
            <div style={{ marginTop: 'var(--s3)' }}><Link to={`/projects/${id}/queue`}><button className="primary">Set up the first run</button></Link></div>
          </Empty>
        )}
        {runs.data && runs.data.runs.length > 0 && (
          <div className="run-list">
            {runs.data.runs.map((run) => {
              const label = run.name || `Run ${run.ordinal ?? ''}`
              return (
                <Link className="run-list-row" to={`/projects/${id}/runs/${run.id}`} key={run.id}>
                  <div className="run-list-main">
                    <strong>{label}</strong>
                    <span className="hint"><Mono>{run.id}</Mono></span>
                  </div>
                  <div className="run-list-progress">
                    <span>{run.completedEvals} of {run.evals} evals advanced</span>
                    <span>{run.archives} archive{run.archives === 1 ? '' : 's'}</span>
                  </div>
                  <StateBadge state={run.state} />
                  <time dateTime={run.createdAt}>{run.createdAt ? new Date(run.createdAt).toLocaleString() : '—'}</time>
                  <span className="run-list-open" aria-hidden="true">Open</span>
                </Link>
              )
            })}
          </div>
        )}
      </Panel>

      <Panel title="The agent">
        <p style={{ color: 'var(--text)', marginTop: 0 }}>
          {agentName}
          {p.data?.default_model ? <> on <Mono>{p.data.default_model}</Mono></> : ' using the default model'}
        </p>
        <p style={{ color: 'var(--text-dim)', fontSize: 13 }}>
          A project tests one agent. The adapter is how we launch it. Models for the agent, the judge, and the across-evals pass live in settings. Blank fields there use the global defaults.
        </p>
        <div className="badge-row">
          <Link to={`/projects/${id}/settings`}><button>{adapter ? 'Adapter' : 'Set adapter'}</button></Link>
          <Link to={`/projects/${id}/settings`}><button>Settings</button></Link>
        </div>
      </Panel>

      <Panel title="Eval store" actions={<Link to={`/projects/${id}/evals`}><button>Manage</button></Link>}>
        {evals.data?.evals.length === 0 && (
          <Empty title="No evals yet">
            Import packages into this project, then add them to the queue.
            <div style={{ marginTop: 'var(--s3)' }}>
              <Link to={`/projects/${id}/evals`}><button className="primary">Open evals</button></Link>
            </div>
          </Empty>
        )}
        {evals.data && evals.data.evals.length > 0 && (
          <table>
            <thead><tr><th>Name</th><th>Category</th></tr></thead>
            <tbody>{evals.data.evals.slice(0, 10).map((t) => (
              <tr key={t.id}>
                <td style={{ color: 'var(--text)' }}>{t.name}</td>
                <td><CategoryChip value={(t.category_name ?? t.categoryName) as string | null} /></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Panel>

      <Panel title="Queue" actions={<Link to={`/projects/${id}/queue`}><button className="primary">Open queue</button></Link>}>
        {!queueRow && (
          <Empty title="No queue yet">
            The queue is the blueprint: which evals, and whether to run the agent, judge each eval, or look across them. Opening it creates it.
          </Empty>
        )}
        {queueRow && (
          <p style={{ color: 'var(--text-dim)', fontSize: 13, margin: 0 }}>
            {queueRow.items.length} eval{queueRow.items.length === 1 ? '' : 's'} on the queue.
            Agent <Mono>{queueRow.queue.agentId ?? queueRow.queue.builtinAdapterId}</Mono>,
            model <Mono>{queueRow.queue.model ?? '—'}</Mono>.
            A start is a run: one container, its own archives, a live view.
          </p>
        )}
      </Panel>
    </>
  )
}
