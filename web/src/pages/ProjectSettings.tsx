import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, errText } from '../lib/api'
import type { Project } from '../lib/types'
import { Banner, Field, PageHead, Panel, Spinner, Tabs } from '../components/ui'
import { PromptEditor } from '../components/PromptEditor'
import { AdapterPanel } from './Adapters'
import {
  StageFields, HealthBanner, useStageHealth, useStoredSecrets, draftToPatch,
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
    webSearchApiKeyEnv: s('webSearchApiKeyEnv'),
    model: s('model'),
    reasoningEffort: s('reasoningEffort'),
    timeoutMs: s('timeoutMs'),
  }
}

interface PromptRow {
  id: string
  group: 'phase1' | 'phase2'
  title: string
  blurb?: string
  body: string
  source: 'project' | 'builtin'
  builtin: string
}

function PromptsPanel({ projectId }: { projectId: string }) {
  const qc = useQueryClient()
  const [selected, setSelected] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const list = useQuery({
    queryKey: ['prompts', projectId],
    queryFn: () => api.get<{ prompts: PromptRow[] }>(`/api/projects/${projectId}/prompts`),
  })

  useEffect(() => {
    if (!list.data?.prompts) return
    const next: Record<string, string> = {}
    for (const p of list.data.prompts) next[p.id] = p.body
    setDrafts(next)
    setSelected((cur) => cur ?? list.data!.prompts[0]?.id ?? null)
  }, [list.data])

  const save = useMutation({
    mutationFn: (prompt_config: Record<string, string> | null) =>
      api.patch(`/api/projects/${projectId}`, { prompt_config }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['prompts', projectId] }),
  })

  const prompts = list.data?.prompts ?? []
  const current = prompts.find((p) => p.id === selected)
  const draft = current ? (drafts[current.id] ?? current.body) : ''
  const dirty = prompts.some((p) => (drafts[p.id] ?? p.body) !== p.body)

  function saveAll() {
    const body: Record<string, string> = {}
    for (const p of prompts) {
      const text = drafts[p.id] ?? p.body
      if (text !== p.builtin) body[p.id] = text
    }
    save.mutate(Object.keys(body).length > 0 ? body : null)
  }

  const phase1 = prompts.filter((p) => p.group === 'phase1')
  const phase2 = prompts.filter((p) => p.group === 'phase2')

  return (
    <Panel
      title="Prompts"
      actions={<>
        {current && (
          <button
            disabled={!current || (drafts[current.id] ?? current.body) === current.builtin || save.isPending}
            onClick={() => setDrafts({ ...drafts, [current.id]: current.builtin })}
          >
            Reset this prompt
          </button>
        )}
        <button className="primary" onClick={saveAll} disabled={!dirty || save.isPending}>
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
      </>}
    >
      {save.isError && <Banner tone="danger">{errText(save.error)}</Banner>}
      {list.isError && <Banner tone="danger">{errText(list.error)}</Banner>}
      {list.isLoading && <Spinner label="Loading prompts…" />}
      <div style={{ color: 'var(--text-dim)', fontSize: 13, marginBottom: 'var(--s3)' }}>
        These are the PI subagent prompts the courtroom actually loads. Edit the text, then Save once.
        A pause/resume rereads whatever is saved here.
      </div>
      {prompts.length > 0 && (
        <div className="prompt-layout">
          <nav className="prompt-nav">
            <div className="group">Phase 1</div>
            {phase1.map((p) => (
              <button key={p.id} className={p.id === selected ? 'active' : ''} onClick={() => setSelected(p.id)}>
                {p.title}
                <span className="src">{(drafts[p.id] ?? p.body) !== p.builtin ? 'edited' : 'built-in'}</span>
              </button>
            ))}
            <div className="group">Phase 2</div>
            {phase2.map((p) => (
              <button key={p.id} className={p.id === selected ? 'active' : ''} onClick={() => setSelected(p.id)}>
                {p.title}
                <span className="src">{(drafts[p.id] ?? p.body) !== p.builtin ? 'edited' : 'built-in'}</span>
              </button>
            ))}
          </nav>
          {current && (
            <div>
              {current.blurb && (
                <p style={{ color: 'var(--text-dim)', fontSize: 13, margin: '0 0 var(--s3)' }}>{current.blurb}</p>
              )}
              <PromptEditor
                value={draft}
                onChange={(next) => setDrafts({ ...drafts, [current.id]: next })}
                onSave={saveAll}
                disabled={save.isPending}
              />
            </div>
          )}
        </div>
      )}
    </Panel>
  )
}

export default function ProjectSettings() {
  const { id } = useParams()
  const qc = useQueryClient()
  const [section, setSection] = useState('Agent & adapter')
  const [stage, setStage] = useState<Stage>('eval')
  const [drafts, setDrafts] = useState<Record<Stage, StageDraft>>({ eval: EMPTY_DRAFT, phase1: EMPTY_DRAFT, phase2: EMPTY_DRAFT })
  const [general, setGeneral] = useState({ name: '', description: '', defaultModel: '', defaultProvider: '', networkPolicy: 'allow', minEvals: '1' })
  const { health, run } = useStageHealth()
  const secrets = useStoredSecrets()

  const p = useQuery({ queryKey: ['project', id], queryFn: () => api.get<Project & { task_source?: { kind?: string } }>(`/api/projects/${id}`) })
  const globals = useQuery({ queryKey: ['model-config'], queryFn: () => api.get<{ stages: StageView[] }>('/api/settings/models') })

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
      minEvals: String(p.data.min_evals ?? 1),
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
      network_policy: general.networkPolicy,
      min_evals: Number(general.minEvals) || 1,
    })
  }

  function saveModels() {
    const body: Record<string, unknown> = {}
    for (const s of STAGES) {
      const patch = draftToPatch(drafts[s], false)
      if (patch) body[s] = { ...patch, apiType: drafts[s].apiType }
    }
    save.mutate({
      model_config: Object.keys(body).length > 0 ? body : null,
      default_model: general.defaultModel.trim() || null,
      default_provider: general.defaultProvider.trim() || null,
    })
  }

  const overrides = STAGES.filter((s) => draftToPatch(drafts[s], false) !== null)
  const h = health[stage]

  return (
    <>
      <PageHead
        title={p.data ? `${p.data.name} settings` : 'Project settings'}
        sub="The agent, the three model jobs, and the courtroom prompts. The queue is a separate page."
        actions={<>
          <Link to={`/projects/${id}`}><button>Overview</button></Link>
          <Link to={`/projects/${id}/evals`}><button>Evals</button></Link>
          <Link to={`/projects/${id}/queue`}><button>Queue</button></Link>
        </>}
      />

      {p.isLoading && <Spinner label="Loading project…" />}
      {p.isError && <Banner tone="danger">{errText(p.error)}</Banner>}
      {save.isError && <Banner tone="danger">{errText(save.error)}</Banner>}

      <Tabs
        tabs={['Agent & adapter', 'Models', 'Prompts']}
        active={section}
        onChange={setSection}
      />

      {section === 'Agent & adapter' && (<>
        <Panel
          title="The agent"
          actions={<button className="primary" onClick={saveGeneral} disabled={save.isPending || !general.name.trim()}>{save.isPending ? 'Saving…' : 'Save'}</button>}
        >
          <p style={{ color: 'var(--text-dim)', fontSize: 13, marginTop: 0 }}>
            One project tests one agent. The adapter page is how we launch it. Every model and provider setting, for the agent and for both judge passes, is on the Models tab.
          </p>
          <div className="form-grid">
            <Field label="Name">
              <input value={general.name} onChange={(e) => setGeneral({ ...general, name: e.target.value })} />
            </Field>
            <Field label="What you are testing">
              <input value={general.description} onChange={(e) => setGeneral({ ...general, description: e.target.value })} placeholder="A coding agent, a CLI, …" />
            </Field>
            <Field
              label="Network"
              hint={
                general.networkPolicy === 'allowlist'
                  ? 'Every packet is filtered against the eval package’s allowlist. Suite evals ship one entry covering the whole address space, so egress is open today but goes through the filter.'
                  : general.networkPolicy === 'offline'
                    ? 'Cuts the agent off the network. The model provider becomes unreachable. Leave allowlist unless you mean that.'
                    : 'Skips the filter entirely. Suite evals use allowlist instead, so this only affects non-suite packages.'
              }
            >
              <select value={general.networkPolicy} onChange={(e) => setGeneral({ ...general, networkPolicy: e.target.value })}>
                <option value="allowlist">allowlist (filtered egress)</option>
                <option value="allow">allow (unfiltered egress)</option>
                <option value="offline">offline (no network)</option>
              </select>
            </Field>
            <Field label="Minimum evals" hint="How many evals must be on the queue before a start is allowed">
              <input type="number" min={1} step={1} value={general.minEvals} onChange={(e) => setGeneral({ ...general, minEvals: e.target.value })} />
            </Field>
          </div>
        </Panel>
        {id && <AdapterPanel projectId={id} />}
      </>)}

      {section === 'Models' && (
        <Panel
          title="Models"
          actions={<>
            <button onClick={() => void run(stage, draftToPatch(drafts[stage], true))} disabled={h === 'running'}>
              {h === 'running' ? 'Checking…' : 'Health check'}
            </button>
            <button className="primary" onClick={saveModels} disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</button>
          </>}
        >
          <div style={{ color: 'var(--text-dim)', fontSize: 13, marginBottom: 'var(--s3)' }}>
            Three jobs, three endpoints. Blank fields use the global Models page. A value you type here wins for this project only.
            {overrides.length === 0
              ? ' This project currently uses the globals for all three.'
              : ` This project sets its own ${overrides.map((s) => STAGE_COPY[s].short).join(', ')}.`}
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
            secrets={secrets}
            onChange={(next) => setDrafts((prev) => ({ ...prev, [stage]: next }))}
          />
          {secrets.put.isError && <Banner tone="danger">{errText(secrets.put.error)}</Banner>}
          {secrets.del.isError && <Banner tone="danger">{errText(secrets.del.error)}</Banner>}
          {stage === 'eval' && (
            <>
              <div style={{ color: 'var(--text-dim)', fontSize: 12, margin: 'var(--s4) 0 var(--s3)' }}>
                What the agent CLI is told on its own command line. Leave both blank and it follows the API type and model above.
              </div>
              <div className="form-grid">
                <Field label="Provider flag" hint="We speak two wire formats. Blank follows the API type above.">
                  <select value={general.defaultProvider} onChange={(e) => setGeneral({ ...general, defaultProvider: e.target.value })}>
                    <option value="">follow API type ({drafts.eval.apiType})</option>
                    <option value="openai">openai</option>
                    <option value="anthropic">anthropic</option>
                  </select>
                </Field>
                <Field label="Model flag" hint="Any model id the endpoint serves. Blank uses the model above.">
                  <input
                    value={general.defaultModel}
                    onChange={(e) => setGeneral({ ...general, defaultModel: e.target.value })}
                    placeholder={drafts.eval.model || globals.data?.stages.find((x) => x.stage === 'eval')?.model || 'model id'}
                  />
                </Field>
              </div>
            </>
          )}
          {h && h !== 'running' && <div style={{ marginTop: 'var(--s3)' }}><HealthBanner result={h} /></div>}
        </Panel>
      )}

      {section === 'Prompts' && id && <PromptsPanel projectId={id} />}
    </>
  )
}
