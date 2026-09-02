import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, errText } from '../lib/api'
import type { Adapter, EvalQueue, EvalTask, Project } from '../lib/types'
import { Banner, Empty, Mono, PageHead, Panel, Tabs } from '../components/ui'
import {
  StageFields, HealthBanner, useStageHealth, draftToPatch,
  EMPTY_DRAFT, STAGES, STAGE_COPY, type Stage, type StageDraft, type StageView,
} from '../components/model-stage'

/** Read a saved override back into an editable draft; blanks mean "inherit". */
function draftFromSaved(saved: Record<string, unknown> | undefined): StageDraft {
  if (!saved) return EMPTY_DRAFT
  const s = (k: string) => (saved[k] == null ? '' : String(saved[k]))
  return {
    apiType: saved.apiType === 'anthropic' ? 'anthropic' : 'openai',
    baseUrl: s('baseUrl'),
    apiKeyEnv: s('apiKeyEnv'),
    model: s('model'),
    reasoningEffort: s('reasoningEffort'),
    timeoutMs: s('timeoutMs'),
  }
}

/** Per-project model overrides, laid out exactly like the global Models page. */
function ModelPanel({ projectId, project }: { projectId: string; project?: Project }) {
  const qc = useQueryClient()
  const [stage, setStage] = useState<Stage>('eval')
  const [drafts, setDrafts] = useState<Record<Stage, StageDraft>>({ eval: EMPTY_DRAFT, phase1: EMPTY_DRAFT, phase2: EMPTY_DRAFT })
  const { health, run } = useStageHealth()

  const globals = useQuery({ queryKey: ['model-config'], queryFn: () => api.get<{ stages: StageView[] }>('/api/settings/models') })

  useEffect(() => {
    const mc = project?.model_config
    setDrafts({ eval: draftFromSaved(mc?.eval), phase1: draftFromSaved(mc?.phase1), phase2: draftFromSaved(mc?.phase2) })
  }, [project?.model_config])

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {}
      for (const s of STAGES) {
        const patch = draftToPatch(drafts[s], false)
        if (patch) body[s] = { ...patch, apiType: drafts[s].apiType }
      }
      return api.patch<Project>(`/api/projects/${projectId}`, { model_config: Object.keys(body).length > 0 ? body : null })
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['project', projectId] }),
  })

  const overrides = STAGES.filter((s) => draftToPatch(drafts[s], false) !== null)
  const h = health[stage]

  return (
    <Panel
      title="Model providers"
      actions={<>
        <button onClick={() => void run(stage, draftToPatch(drafts[stage], true))} disabled={h === 'running'}>
          {h === 'running' ? 'Checking…' : 'Health check'}
        </button>
        <button className="primary" onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</button>
      </>}
    >
      <div style={{ color: 'var(--text-dim)', fontSize: 12, marginBottom: 'var(--s3)' }}>
        Blank fields inherit the global setting shown as the placeholder.
        {overrides.length === 0 ? ' This project inherits every stage.' : ` This project overrides ${overrides.map((s) => STAGE_COPY[s].short).join(', ')}.`}
      </div>
      {save.isError && <Banner tone="danger">{errText(save.error)}</Banner>}
      <Tabs
        tabs={STAGES.map((s) => STAGE_COPY[s].short)}
        active={STAGE_COPY[stage].short}
        onChange={(t) => setStage(STAGES.find((s) => STAGE_COPY[s].short === t) ?? 'eval')}
      />
      <div style={{ color: 'var(--text-dim)', fontSize: 12, margin: 'var(--s3) 0' }}>{STAGE_COPY[stage].sub}</div>
      <StageFields
        stage={stage}
        draft={drafts[stage]}
        inherited={globals.data?.stages.find((x) => x.stage === stage)}
        onChange={(next) => setDrafts((prev) => ({ ...prev, [stage]: next }))}
      />
      {h && h !== 'running' && <div style={{ marginTop: 'var(--s3)' }}><HealthBanner result={h} /></div>}
    </Panel>
  )
}

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
          <Link to={`/projects/${id}/adapters`}><button className="primary">Adapters</button></Link>
          <Link to={`/projects/${id}/evals`}><button>Evals</button></Link>
          <Link to={`/projects/${id}/queue`}><button>Queue</button></Link>
          <Link to={`/projects/${id}/live`}><button>Live</button></Link>
        </>}
      />

      {p.isError && <Banner tone="danger">{errText(p.error)}</Banner>}

      <Panel title="Summary">
        <div className="badge-row">
          <span className="chip">model: <Mono>{p.data?.default_model ?? '—'}</Mono></span>
          <span className="chip">provider: <Mono>{p.data?.default_provider ?? '—'}</Mono></span>
          <span className="chip">network: <Mono>{p.data?.network_policy ?? 'allow'}</Mono></span>
        </div>
      </Panel>

      {id && <ModelPanel projectId={id} project={p.data} />}

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
