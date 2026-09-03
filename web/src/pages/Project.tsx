import { Link, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api, errText } from '../lib/api'
import type { Adapter, EvalQueue, EvalTask, Project } from '../lib/types'
import { Banner, Empty, Mono, PageHead, Panel } from '../components/ui'
import { STAGES, STAGE_COPY } from '../components/model-stage'

export default function Project() {
  const { id } = useParams()
  const p = useQuery({ queryKey: ['project', id], queryFn: () => api.get<Project>(`/api/projects/${id}`) })
  const adapters = useQuery({ queryKey: ['adapters', id], queryFn: () => api.get<{ adapters: Adapter[] }>(`/api/projects/${id}/adapters`) })
  const evals = useQuery({ queryKey: ['evals', id], queryFn: () => api.get<{ evals: EvalTask[] }>(`/api/projects/${id}/evals`) })
  const queues = useQuery({ queryKey: ['queues', id], queryFn: () => api.get<{ queues: { queue: EvalQueue; items: unknown[] }[] }>(`/api/projects/${id}/queues`) })

  return (
    <>
      <PageHead
        title={p.data?.name ?? 'Project'}
        sub={id ? <Mono>{id}</Mono> : undefined}
        actions={<>
          <Link to={`/projects/${id}/settings`}><button className="primary">Settings</button></Link>
          <Link to={`/projects/${id}/adapters`}><button>Adapters</button></Link>
          <Link to={`/projects/${id}/evals`}><button>Evals</button></Link>
          <Link to={`/projects/${id}/queue`}><button>Queue</button></Link>
          <Link to={`/projects/${id}/live`}><button>Live</button></Link>
        </>}
      />

      {p.isError && <Banner tone="danger">{errText(p.error)}</Banner>}

      <Panel title="Summary" actions={<Link to={`/projects/${id}/settings`}><button>Edit settings</button></Link>}>
        <div className="badge-row">
          <span className="chip">model: <Mono>{p.data?.default_model ?? '—'}</Mono></span>
          <span className="chip">provider: <Mono>{p.data?.default_provider ?? '—'}</Mono></span>
          <span className="chip">network: <Mono>{p.data?.network_policy ?? 'allow'}</Mono></span>
        </div>
        <div className="badge-row" style={{ marginTop: 'var(--s2)' }}>
          {STAGES.every((s) => !p.data?.model_config?.[s])
            ? <span className="chip">providers: inherits global for every stage</span>
            : STAGES.map((s) => (
                <span key={s} className={`chip ${p.data?.model_config?.[s] ? (s === 'eval' ? 'accent' : s) : ''}`}>
                  {STAGE_COPY[s].short}: {p.data?.model_config?.[s] ? String(p.data.model_config[s].model ?? 'overridden') : 'inherited'}
                </span>
              ))}
        </div>
      </Panel>

      <Panel title={`Adapters (${adapters.data?.adapters.length ?? 0})`}>
        {adapters.data?.adapters.length === 0 && <Empty title="No adapters"><Link to={`/projects/${id}/adapters`}><button>Create an adapter</button></Link></Empty>}
        {adapters.data && adapters.data.adapters.length > 0 && (
          <table>
            <thead><tr><th>Agent</th><th>Install</th><th>Source</th><th>Provider / model</th><th>Image</th></tr></thead>
            <tbody>{adapters.data.adapters.slice(0, 10).map((a, i) => (
              <tr key={a.id ?? i}>
                <td style={{ color: 'var(--text)', fontWeight: 600 }}>{a.agent_id ?? a.agentId ?? a.name}</td>
                <td><Mono>{a.install_type ?? a.installType ?? '—'}</Mono></td>
                <td><Mono>{a.sourceRepo ?? '—'}</Mono></td>
                <td><Mono>{a.defaultProvider ?? '—'} / {a.default_model ?? a.defaultModel ?? '—'}</Mono></td>
                <td><Mono copy>{a.image ?? '—'}</Mono></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Panel>

      <Panel title={`Evals (${evals.data?.evals.length ?? 0})`}>
        {evals.data?.evals.length === 0 && <Empty title="No evals"><Link to={`/projects/${id}/evals`}><button>Import evals</button></Link></Empty>}
        {evals.data && evals.data.evals.length > 0 && (
          <table>
            <thead><tr><th>Name</th><th>Category</th><th>Id</th></tr></thead>
            <tbody>{evals.data.evals.slice(0, 10).map((t) => (
              <tr key={t.id}>
                <td style={{ color: 'var(--text)' }}>{t.name}</td>
                <td><span className="chip">{String(t.categoryName ?? '—')}</span></td>
                <td><Mono copy>{t.id}</Mono></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Panel>

      <Panel title={`Queues (${queues.data?.queues.length ?? 0})`}>
        {queues.data?.queues.length === 0 && <Empty title="No queues"><Link to={`/projects/${id}/queue`}><button>Create a queue</button></Link></Empty>}
        {queues.data && queues.data.queues.length > 0 && (
          <table>
            <thead><tr><th>Name</th><th>Agent</th><th>Model</th><th>Status</th><th>Items</th></tr></thead>
            <tbody>{queues.data.queues.map(({ queue, items }) => (
              <tr key={queue.id}>
                <td style={{ color: 'var(--text)' }}>{queue.name}</td>
                <td><Mono>{queue.agentId ?? queue.builtinAdapterId ?? '—'}</Mono></td>
                <td><Mono>{queue.model ?? '—'}</Mono></td>
                <td><Mono>{queue.status}</Mono></td>
                <td className="num">{items.length}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Panel>
    </>
  )
}
