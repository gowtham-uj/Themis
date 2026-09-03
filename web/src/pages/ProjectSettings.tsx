import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, errText } from '../lib/api'
import type { Adapter, EvalQueue, PipelineQueue, Project, QueueItem } from '../lib/types'
import { Banner, Empty, Field, Mono, PageHead, Panel, Spinner, StateBadge, Tabs } from '../components/ui'
import {
  StageFields, HealthBanner, useStageHealth, draftToPatch,
  EMPTY_DRAFT, STAGES, STAGE_COPY, type Stage, type StageDraft, type StageView,
} from '../components/model-stage'

interface QueueRow { queue: EvalQueue; items: QueueItem[]; container: { id?: string } | null }

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

/** Parse an optional JSON object textarea. Blank means clear the field. */
function parseJsonField(text: string, label: string): Record<string, unknown> | null {
  const t = text.trim()
  if (!t) return null
  const parsed = JSON.parse(t) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`)
  }
  return parsed as Record<string, unknown>
}

/**
 * Everything one eval queue owns: adapter selection, provider and model,
 * network policy, ports, sandbox, and adapter overrides. The backend refuses
 * these edits while the queue's container runs, so the form disables itself in
 * that case instead of letting a save fail with a conflict.
 */
function QueueCard({
  projectId, row, builtins, shared,
}: {
  projectId: string
  row: QueueRow
  builtins: string[]
  shared: Adapter[]
}) {
  const qc = useQueryClient()
  const { queue, items } = row
  const live = Boolean(row.container)
  const [err, setErr] = useState<string | null>(null)
  const [form, setForm] = useState({
    name: '', description: '', model: '', provider: '', networkPolicy: 'allow',
    adapterKind: 'builtin' as 'builtin' | 'shared',
    builtinAdapterId: '', sharedAdapterId: '', agentCommit: '',
    ports: '', sandbox: '', adapterOverrides: '',
  })

  useEffect(() => {
    setForm({
      name: queue.name ?? '',
      description: queue.description ?? '',
      model: queue.model ?? '',
      provider: queue.provider ?? '',
      networkPolicy: queue.networkPolicy ?? 'allow',
      adapterKind: queue.sharedAdapterId ? 'shared' : 'builtin',
      builtinAdapterId: queue.builtinAdapterId ?? '',
      sharedAdapterId: queue.sharedAdapterId ?? '',
      agentCommit: queue.agentCommit ?? '',
      ports: queue.ports?.length ? JSON.stringify(queue.ports) : '',
      sandbox: queue.sandbox ? JSON.stringify(queue.sandbox, null, 2) : '',
      adapterOverrides: queue.adapterOverrides ? JSON.stringify(queue.adapterOverrides, null, 2) : '',
    })
  }, [queue])

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/api/projects/${projectId}/queues/${queue.id}`, body),
    onSuccess: () => { setErr(null); void qc.invalidateQueries({ queryKey: ['queues', projectId] }) },
    onError: (e) => setErr(errText(e)),
  })

  // Start is a PUT, stop is a DELETE, and pause/resume/abort ride one PATCH.
  const control = useMutation({
    mutationFn: (action: 'start' | 'stop' | 'pause' | 'resume' | 'abort') => {
      const url = `/api/projects/${projectId}/queues/${queue.id}/container`
      if (action === 'start') return api.put(url, {})
      if (action === 'stop') return api.del(url)
      return api.patch(url, { action })
    },
    onSuccess: () => { setErr(null); void qc.invalidateQueries({ queryKey: ['queues', projectId] }) },
    onError: (e) => setErr(errText(e)),
  })

  function submit() {
    let body: Record<string, unknown>
    try {
      body = {
        name: form.name.trim(),
        description: form.description.trim() || null,
        model: form.model.trim(),
        provider: form.provider.trim(),
        network_policy: form.networkPolicy,
        sandbox: parseJsonField(form.sandbox, 'Sandbox'),
        adapter_overrides: parseJsonField(form.adapterOverrides, 'Adapter overrides'),
        ports: form.ports.trim() ? JSON.parse(form.ports) : [],
      }
      if (form.adapterKind === 'shared' && form.sharedAdapterId) {
        body.shared_adapter_id = form.sharedAdapterId
      } else if (form.adapterKind === 'builtin' && form.builtinAdapterId) {
        body.builtin_adapter_id = form.builtinAdapterId
      }
      if (form.agentCommit.trim()) body.agent_commit = form.agentCommit.trim()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      return
    }
    save.mutate(body)
  }

  const set = (k: keyof typeof form, v: string) => setForm({ ...form, [k]: v })

  return (
    <Panel
      title={<span>{queue.name} <Mono copy>{queue.id}</Mono></span>}
      actions={<>
        <StateBadge state={queue.status} />
        {live ? (
          <>
            <button onClick={() => control.mutate('pause')}>Pause</button>
            <button onClick={() => control.mutate('resume')}>Resume</button>
            <button onClick={() => control.mutate('abort')}>Abort run</button>
            <button className="danger" onClick={() => control.mutate('stop')}>Stop container</button>
          </>
        ) : (
          <button onClick={() => control.mutate('start')}>Start container</button>
        )}
        <button className="primary" onClick={submit} disabled={live || save.isPending}>
          {save.isPending ? 'Saving…' : 'Save queue'}
        </button>
      </>}
    >
      {err && <Banner tone="danger">{err}</Banner>}
      {live && (
        <Banner tone="warn">
          A container is running for this queue. Stop it before changing execution settings.
        </Banner>
      )}

      <div className="form-grid">
        <Field label="Name"><input value={form.name} disabled={live} onChange={(e) => set('name', e.target.value)} /></Field>
        <Field label="Description">
          <input value={form.description} disabled={live} onChange={(e) => set('description', e.target.value)} placeholder="What this queue runs" />
        </Field>
        <Field label="Adapter source" hint="A queue points at a built-in adapter or a shared one, never both">
          <select value={form.adapterKind} disabled={live} onChange={(e) => set('adapterKind', e.target.value)}>
            <option value="builtin">Built-in</option>
            <option value="shared">Shared adapter</option>
          </select>
        </Field>
        {form.adapterKind === 'builtin' ? (
          <Field label="Built-in adapter">
            <select value={form.builtinAdapterId} disabled={live} onChange={(e) => set('builtinAdapterId', e.target.value)}>
              <option value="">keep current</option>
              {builtins.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </Field>
        ) : (
          <Field label="Shared adapter">
            <select value={form.sharedAdapterId} disabled={live} onChange={(e) => set('sharedAdapterId', e.target.value)}>
              <option value="">keep current</option>
              {shared.map((a) => <option key={a.id} value={a.id}>{a.agentId ?? a.agent_id ?? a.name ?? a.id}</option>)}
            </select>
          </Field>
        )}
        <Field label="Provider"><input value={form.provider} disabled={live} onChange={(e) => set('provider', e.target.value)} placeholder="openai-compatible" /></Field>
        <Field label="Model" hint="What the agent under test runs on">
          <input value={form.model} disabled={live} onChange={(e) => set('model', e.target.value)} placeholder="deepseek-v4-flash" />
        </Field>
        <Field label="Network policy">
          <select value={form.networkPolicy} disabled={live} onChange={(e) => set('networkPolicy', e.target.value)}>
            <option value="allow">allow</option>
            <option value="offline">offline</option>
            <option value="allowlist">allowlist</option>
          </select>
        </Field>
        <Field label="Agent commit" hint="Full SHA, source-built adapters only">
          <input value={form.agentCommit} disabled={live} onChange={(e) => set('agentCommit', e.target.value)} placeholder="leave blank to keep" />
        </Field>
        <Field label="Ports" hint='JSON array, for example [{"container":3000,"host":3000}]'>
          <input value={form.ports} disabled={live} onChange={(e) => set('ports', e.target.value)} placeholder="[]" />
        </Field>
      </div>

      <div className="form-grid" style={{ marginTop: 'var(--s3)' }}>
        <Field label="Sandbox" hint="JSON object, blank clears it">
          <textarea rows={4} value={form.sandbox} disabled={live} onChange={(e) => set('sandbox', e.target.value)} />
        </Field>
        <Field label="Adapter overrides" hint="JSON object, blank clears it">
          <textarea rows={4} value={form.adapterOverrides} disabled={live} onChange={(e) => set('adapterOverrides', e.target.value)} />
        </Field>
      </div>

      <div className="badge-row" style={{ marginTop: 'var(--s3)' }}>
        <span className="chip">agent: <Mono>{queue.agentId ?? '—'}</Mono></span>
        <span className="chip">revision: <Mono>{String(queue.revision ?? '—')}</Mono></span>
        <span className="chip">{items.length} evals queued</span>
        <Link to={`/projects/${projectId}/queue`}><button>Manage evals</button></Link>
      </div>
    </Panel>
  )
}

/** Phase automation for the project's one pipeline queue, plus manual advance. */
function PipelinePanel({ projectId, evalQueues }: { projectId: string; evalQueues: EvalQueue[] }) {
  const qc = useQueryClient()
  const [err, setErr] = useState<string | null>(null)
  const [linkTo, setLinkTo] = useState('')

  const p = useQuery({
    queryKey: ['pipeline', projectId],
    queryFn: () => api.get<{ queue: PipelineQueue | null; generation: { id: string; state?: string; ordinal?: number } | null }>(`/api/projects/${projectId}/pipeline`),
  })
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['pipeline', projectId] })

  const create = useMutation({
    mutationFn: () => api.post(`/api/projects/${projectId}/pipeline`, { eval_queue_id: linkTo, auto_phase2: true }),
    onSuccess: () => { setErr(null); invalidate() },
    onError: (e) => setErr(errText(e)),
  })
  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/api/projects/${projectId}/pipeline`, body),
    onSuccess: () => { setErr(null); invalidate() },
    onError: (e) => setErr(errText(e)),
  })
  const newGeneration = useMutation({
    mutationFn: () => api.post(`/api/projects/${projectId}/pipeline/generation`, {}),
    onSuccess: () => { setErr(null); invalidate() },
    onError: (e) => setErr(errText(e)),
  })
  const advance = useMutation({
    mutationFn: (generationId: string) => api.post(`/api/projects/${projectId}/pipeline/generation/${generationId}/advance`, { trigger: 'auto' }),
    onSuccess: () => { setErr(null); invalidate() },
    onError: (e) => setErr(errText(e)),
  })

  if (p.isLoading) return <Panel title="Pipeline phases"><Spinner label="Loading pipeline…" /></Panel>

  const queue = p.data?.queue ?? null
  const gen = p.data?.generation ?? null

  if (!queue) {
    return (
      <Panel title="Pipeline phases">
        {err && <Banner tone="danger">{err}</Banner>}
        <div style={{ color: 'var(--text-dim)', fontSize: 12, marginBottom: 'var(--s3)' }}>
          One pipeline queue per project drives eval execution, then Phase 1 on each sealed eval, then Phase 2
          across the whole generation. Link it to an eval queue to turn that chain on.
        </div>
        <div className="form-grid">
          <Field label="Eval queue to drive">
            <select value={linkTo} onChange={(e) => setLinkTo(e.target.value)}>
              <option value="">select a queue</option>
              {evalQueues.map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}
            </select>
          </Field>
        </div>
        <button className="primary" style={{ marginTop: 'var(--s3)' }} disabled={!linkTo || create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? 'Creating…' : 'Create pipeline'}
        </button>
      </Panel>
    )
  }

  const toggle = (k: 'auto_eval' | 'auto_phase1' | 'auto_phase2', v: boolean) => patch.mutate({ [k]: v })

  return (
    <Panel
      title="Pipeline phases"
      actions={<>
        <StateBadge state={queue.status} />
        <button onClick={() => patch.mutate({ status: queue.status === 'paused' ? 'running' : 'paused' })}>
          {queue.status === 'paused' ? 'Resume' : 'Pause'}
        </button>
        <button onClick={() => newGeneration.mutate()} disabled={newGeneration.isPending}>New generation</button>
        {gen && <button className="primary" onClick={() => advance.mutate(gen.id)} disabled={advance.isPending}>Advance</button>}
      </>}
    >
      {err && <Banner tone="danger">{err}</Banner>}
      <div className="form-grid">
        <Field label="Run evals automatically" hint="Start the eval queue container when a generation opens">
          <select value={String(queue.autoEval ?? true)} onChange={(e) => toggle('auto_eval', e.target.value === 'true')}>
            <option value="true">on</option><option value="false">off</option>
          </select>
        </Field>
        <Field label="Run Phase 1 automatically" hint="Judge each eval as soon as its archive seals">
          <select value={String(queue.autoPhase1 ?? true)} onChange={(e) => toggle('auto_phase1', e.target.value === 'true')}>
            <option value="true">on</option><option value="false">off</option>
          </select>
        </Field>
        <Field label="Run Phase 2 automatically" hint="Start the campaign once every Phase 1 result publishes">
          <select value={String(queue.autoPhase2 ?? true)} onChange={(e) => toggle('auto_phase2', e.target.value === 'true')}>
            <option value="true">on</option><option value="false">off</option>
          </select>
        </Field>
      </div>
      <div className="badge-row" style={{ marginTop: 'var(--s3)' }}>
        <span className="chip">pipeline: <Mono>{queue.id}</Mono></span>
        <span className="chip">eval queue: <Mono>{queue.evalQueueId ?? '—'}</Mono></span>
        <span className="chip">revision: <Mono>{String(queue.revision)}</Mono></span>
        {gen
          ? <><span className="chip">generation {gen.ordinal ?? ''} <Mono>{gen.id}</Mono></span><StateBadge state={gen.state} /></>
          : <span className="chip">no generation yet</span>}
      </div>
    </Panel>
  )
}

export default function ProjectSettings() {
  const { id } = useParams()
  const qc = useQueryClient()
  const [section, setSection] = useState('Project')
  const [stage, setStage] = useState<Stage>('eval')
  const [drafts, setDrafts] = useState<Record<Stage, StageDraft>>({ eval: EMPTY_DRAFT, phase1: EMPTY_DRAFT, phase2: EMPTY_DRAFT })
  const [general, setGeneral] = useState({ name: '', description: '', defaultModel: '', defaultProvider: '', networkPolicy: 'allow', taskSource: 'ui-builder' })
  const { health, run } = useStageHealth()

  const p = useQuery({ queryKey: ['project', id], queryFn: () => api.get<Project & { task_source?: { kind?: string } }>(`/api/projects/${id}`) })
  const globals = useQuery({ queryKey: ['model-config'], queryFn: () => api.get<{ stages: StageView[] }>('/api/settings/models') })
  const queues = useQuery({ queryKey: ['queues', id], queryFn: () => api.get<{ queues: QueueRow[] }>(`/api/projects/${id}/queues`) })
  const builtins = useQuery({ queryKey: ['builtin-adapters'], queryFn: () => api.get<{ adapters: string[] }>('/api/adapters/builtin') })
  const shared = useQuery({ queryKey: ['shared-adapters'], queryFn: () => api.get<{ adapters: Adapter[] }>('/api/adapters/store') })

  useEffect(() => {
    if (!p.data) return
    const mc = p.data.model_config
    setDrafts({ eval: draftFromSaved(mc?.eval), phase1: draftFromSaved(mc?.phase1), phase2: draftFromSaved(mc?.phase2) })
    setGeneral({
      name: p.data.name ?? '',
      description: p.data.description ?? '',
      defaultModel: p.data.default_model ?? '',
      defaultProvider: p.data.default_provider ?? '',
      networkPolicy: p.data.network_policy ?? 'allow',
      taskSource: p.data.task_source?.kind ?? 'ui-builder',
    })
  }, [p.data])

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch<Project>(`/api/projects/${id}`, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['project', id] }),
  })

  function saveGeneral() {
    save.mutate({
      name: general.name.trim(),
      description: general.description.trim() || null,
      default_model: general.defaultModel.trim() || null,
      default_provider: general.defaultProvider.trim() || null,
      network_policy: general.networkPolicy,
      task_source: { kind: general.taskSource },
    })
  }

  function saveModels() {
    const body: Record<string, unknown> = {}
    for (const s of STAGES) {
      const patch = draftToPatch(drafts[s], false)
      if (patch) body[s] = { ...patch, apiType: drafts[s].apiType }
    }
    save.mutate({ model_config: Object.keys(body).length > 0 ? body : null })
  }

  const overrides = STAGES.filter((s) => draftToPatch(drafts[s], false) !== null)
  const h = health[stage]
  const rows = queues.data?.queues ?? []

  return (
    <>
      <PageHead
        title={p.data ? `${p.data.name} settings` : 'Project settings'}
        sub="Every project and queue setting, including the phase providers, lives on this page."
        actions={<>
          <Link to={`/projects/${id}`}><button>Overview</button></Link>
          <Link to={`/projects/${id}/adapters`}><button>Adapters</button></Link>
          <Link to={`/projects/${id}/evals`}><button>Evals</button></Link>
          <Link to={`/projects/${id}/queue`}><button>Queue runs</button></Link>
        </>}
      />

      {p.isLoading && <Spinner label="Loading project…" />}
      {p.isError && <Banner tone="danger">{errText(p.error)}</Banner>}
      {save.isError && <Banner tone="danger">{errText(save.error)}</Banner>}

      <Tabs
        tabs={['Project', 'Model providers', 'Pipeline phases', `Queues (${rows.length})`]}
        active={section}
        onChange={setSection}
      />

      {section === 'Project' && (
        <Panel
          title="General"
          actions={<button className="primary" onClick={saveGeneral} disabled={save.isPending || !general.name.trim()}>{save.isPending ? 'Saving…' : 'Save'}</button>}
        >
          <div className="form-grid">
            <Field label="Name">
              <input value={general.name} onChange={(e) => setGeneral({ ...general, name: e.target.value })} />
            </Field>
            <Field label="Description">
              <input value={general.description} onChange={(e) => setGeneral({ ...general, description: e.target.value })} placeholder="What this project evaluates" />
            </Field>
            <Field label="Default model" hint="Pinned on new queues; each queue can override it">
              <input value={general.defaultModel} onChange={(e) => setGeneral({ ...general, defaultModel: e.target.value })} placeholder="deepseek-v4-flash" />
            </Field>
            <Field label="Default provider">
              <input value={general.defaultProvider} onChange={(e) => setGeneral({ ...general, defaultProvider: e.target.value })} placeholder="openai-compatible" />
            </Field>
            <Field label="Network policy" hint="What the agent container may reach">
              <select value={general.networkPolicy} onChange={(e) => setGeneral({ ...general, networkPolicy: e.target.value })}>
                <option value="allow">allow</option>
                <option value="offline">offline</option>
                <option value="allowlist">allowlist</option>
              </select>
            </Field>
            <Field label="Eval source" hint="Where this project's evals come from">
              <select value={general.taskSource} onChange={(e) => setGeneral({ ...general, taskSource: e.target.value })}>
                <option value="ui-builder">ui-builder</option>
                <option value="github">github</option>
                <option value="upload">upload</option>
              </select>
            </Field>
          </div>
          <div className="badge-row" style={{ marginTop: 'var(--s3)' }}>
            <span className="chip">id: <Mono copy>{id ?? ''}</Mono></span>
          </div>
        </Panel>
      )}

      {section === 'Model providers' && (
        <Panel
          title="Model providers"
          actions={<>
            <button onClick={() => void run(stage, draftToPatch(drafts[stage], true))} disabled={h === 'running'}>
              {h === 'running' ? 'Checking…' : 'Health check'}
            </button>
            <button className="primary" onClick={saveModels} disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</button>
          </>}
        >
          <div style={{ color: 'var(--text-dim)', fontSize: 12, marginBottom: 'var(--s3)' }}>
            Each stage reaches its own endpoint. Blank fields inherit the global setting shown as the placeholder.
            {overrides.length === 0
              ? ' This project inherits every stage.'
              : ` This project overrides ${overrides.map((s) => STAGE_COPY[s].short).join(', ')}.`}
          </div>
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
      )}

      {section === 'Pipeline phases' && id && (
        <PipelinePanel projectId={id} evalQueues={rows.map((r) => r.queue)} />
      )}

      {section.startsWith('Queues') && (
        <>
          {queues.isLoading && <Spinner label="Loading queues…" />}
          {rows.length === 0 && !queues.isLoading && (
            <Empty title="No queues yet"><Link to={`/projects/${id}/queue`}><button className="primary">Create a queue</button></Link></Empty>
          )}
          {id && rows.map((row) => (
            <QueueCard
              key={row.queue.id}
              projectId={id}
              row={row}
              builtins={builtins.data?.adapters ?? []}
              shared={shared.data?.adapters ?? []}
            />
          ))}
        </>
      )}
    </>
  )
}
