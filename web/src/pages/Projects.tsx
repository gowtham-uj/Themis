import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api, errText } from '../lib/api'
import type { Project } from '../lib/types'
import { Banner, Empty, Field, Modal, Mono, PageHead, Tabs } from '../components/ui'
import {
  StageFields, HealthBanner, useStageHealth, draftToPatch,
  EMPTY_DRAFT, STAGES, STAGE_COPY, type Stage, type StageDraft, type StageView,
} from '../components/model-stage'

const BLANK: Record<Stage, StageDraft> = { eval: EMPTY_DRAFT, phase1: EMPTY_DRAFT, phase2: EMPTY_DRAFT }

export default function Projects() {
  const qc = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [stage, setStage] = useState<Stage>('eval')
  const [drafts, setDrafts] = useState<Record<Stage, StageDraft>>(BLANK)
  const { health, run } = useStageHealth()

  const q = useQuery({ queryKey: ['projects'], queryFn: () => api.get<{ projects: Project[] }>('/api/projects') })
  // The global config supplies placeholder values, so a blank field in the
  // form shows what the project will actually inherit.
  const globals = useQuery({ queryKey: ['model-config'], queryFn: () => api.get<{ stages: StageView[] }>('/api/settings/models') })
  const inherited = (s: Stage) => globals.data?.stages.find((x) => x.stage === s)

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post<Project>('/api/projects', body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['projects'] }); closeModal() },
    onError: (e) => setError(errText(e)),
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/projects/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['projects'] }),
    onError: (e) => setError(errText(e)),
  })

  function openModal() { setError(null); setDrafts(BLANK); setStage('eval'); setCreating(true) }
  function closeModal() { setCreating(false) }

  // A stage counts as overridden once it has any value beyond the API type,
  // which every stage carries by default.
  const overrides = STAGES.filter((s) => draftToPatch(drafts[s], false) !== null)
  const h = health[stage]

  function modelConfigBody() {
    const out: Record<string, unknown> = {}
    for (const s of overrides) out[s] = draftToPatch(drafts[s], true)
    return Object.keys(out).length > 0 ? out : undefined
  }

  return (
    <>
      <PageHead title="Projects" actions={<button className="primary" onClick={openModal}>New project</button>} sub={`${q.data?.projects.length ?? 0} projects`} />
      {error && <Banner tone="danger">{error}</Banner>}

      <section className="panel">
        {q.isLoading && <Empty title="Loading projects…" />}
        {q.isError && <Banner tone="danger">Failed to load projects: {errText(q.error)}</Banner>}
        {q.data && q.data.projects.length === 0 && <Empty title="No projects yet"><button className="primary" onClick={openModal}>Create your first project</button></Empty>}
        {q.data && q.data.projects.length > 0 && (
          <table>
            <thead><tr><th>Name</th><th>Id</th><th>Model</th><th>Providers</th><th>Network</th><th style={{ width: 260 }}>Open</th><th /></tr></thead>
            <tbody>
              {q.data.projects.map((p) => {
                const own = STAGES.filter((s) => p.model_config?.[s])
                return (
                  <tr key={p.id}>
                    <td style={{ color: 'var(--text)', fontWeight: 600 }}>{p.name}</td>
                    <td><Mono copy>{p.id}</Mono></td>
                    <td><Mono>{p.default_model ?? '—'}</Mono></td>
                    <td className="badge-row">
                      {own.length === 0
                        ? <span className="chip">inherits global</span>
                        : own.map((s) => <span key={s} className={`chip ${s === 'eval' ? 'accent' : s}`}>{STAGE_COPY[s].short}</span>)}
                    </td>
                    <td><Mono>{p.network_policy ?? 'allow'}</Mono></td>
                    <td className="badge-row">
                      <Link to={`/projects/${p.id}`}><button>Overview</button></Link>
                      <Link to={`/projects/${p.id}/adapters`}><button>Adapters</button></Link>
                      <Link to={`/projects/${p.id}/evals`}><button>Evals</button></Link>
                      <Link to={`/projects/${p.id}/queue`}><button>Queue</button></Link>
                      <Link to={`/projects/${p.id}/live`}><button>Live</button></Link>
                    </td>
                    <td><button className="danger" onClick={() => { if (confirm(`Delete project ${p.name}?`)) remove.mutate(p.id) }}>Delete</button></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </section>

      <Modal title="New project" open={creating} onClose={closeModal}>
        <form
          style={{ width: 'min(780px, 86vw)', display: 'flex', flexDirection: 'column', gap: 'var(--s4)' }}
          onSubmit={(e) => {
            e.preventDefault()
            const f = new FormData(e.currentTarget)
            create.mutate({
              name: f.get('name'),
              slug: f.get('slug'),
              default_model: f.get('default_model') || undefined,
              default_provider: f.get('default_provider') || undefined,
              model_config: modelConfigBody(),
            })
          }}
        >
          <div className="form-grid">
            <Field label="Name"><input name="name" required autoFocus /></Field>
            <Field label="Slug" hint="Defaults to a slugified name"><input name="slug" /></Field>
            <Field label="Default model" hint="Queue-level pin shown on runs"><input name="default_model" placeholder="deepseek-v4-flash" /></Field>
            <Field label="Default provider"><input name="default_provider" placeholder="openai-compatible" /></Field>
          </div>

          <div>
            <div className="page-head" style={{ marginBottom: 'var(--s2)' }}>
              <h2 style={{ fontSize: 14 }}>Model providers</h2>
              <button type="button" onClick={() => void run(stage, draftToPatch(drafts[stage], true))} disabled={health[stage] === 'running'}>
                {health[stage] === 'running' ? 'Checking…' : 'Health check'}
              </button>
            </div>
            <div style={{ color: 'var(--text-dim)', fontSize: 12, marginBottom: 'var(--s3)' }}>
              Each stage reaches its own endpoint. Leave a field blank to inherit the global setting shown as its placeholder.
              {overrides.length > 0 && <> This project overrides {overrides.map((s) => STAGE_COPY[s].short).join(', ')}.</>}
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
              inherited={inherited(stage)}
              onChange={(next) => setDrafts((prev) => ({ ...prev, [stage]: next }))}
            />
            {h && h !== 'running' && <div style={{ marginTop: 'var(--s3)' }}><HealthBanner result={h} /></div>}
          </div>

          <div style={{ display: 'flex', gap: 'var(--s2)' }}>
            <button type="submit" className="primary" disabled={create.isPending}>{create.isPending ? 'Creating…' : 'Create project'}</button>
            <button type="button" onClick={closeModal}>Cancel</button>
          </div>
        </form>
      </Modal>
    </>
  )
}
