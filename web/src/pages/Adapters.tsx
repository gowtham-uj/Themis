import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, errText } from '../lib/api'
import type { Adapter, AdapterVersion, EvalQueue, Project } from '../lib/types'
import { Banner, Empty, Field, Modal, Mono, Panel, Spinner, StateBadge } from '../components/ui'

interface DocSection {
  id: string
  title: string
  body: string[]
  code?: { language: string; label: string; source: string }
  fields?: { name: string; required?: boolean; description: string }[]
}

interface AdapterDocs {
  version: number
  title: string
  summary: string
  sections: DocSection[]
  credential_contract: { credentials: { name: string; apiType: string | null; stageManaged: boolean; description: string }[] }
  template_placeholders: { name: string; description: string }[]
  evidence_roles: { name: string; description: string }[]
  readiness: { order: string[]; requirements: { step: string; rule: string; blocks: string[] }[] }
}

interface Readiness {
  canRunEvals: boolean
  canRunPhase1: boolean
  canRunPhase2: boolean
  minEvals: number
  enabledEvals: number
  checks: { step: string; ok: boolean; detail: string; action?: string }[]
}

/**
 * Adapter management for one project: setup checklist, the adapter list, the
 * create form, and the authoring docs. Rendered inside project settings, which
 * is the one place a project is configured.
 */
export function AdapterPanel({ projectId: id }: { projectId: string }) {
  const qc = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'danger' | 'ok'; text: string } | null>(null)
  const [docOpen, setDocOpen] = useState(false)

  const q = useQuery({ queryKey: ['adapters', id], queryFn: () => api.get<{ adapters: Adapter[] }>(`/api/projects/${id}/adapters`) })
  const docs = useQuery({ queryKey: ['adapter-docs'], queryFn: () => api.get<AdapterDocs>('/api/adapters/docs') })
  const readiness = useQuery({ queryKey: ['readiness', id], queryFn: () => api.get<Readiness>(`/api/projects/${id}/readiness`) })
  // The project row carries the agent its queue actually launches, which for a
  // built-in adapter is the only place that name exists.
  const project = useQuery({ queryKey: ['project', id], queryFn: () => api.get<Project>(`/api/projects/${id}`) })
  const builtinAdapter = q.data?.adapters.length === 0 ? project.data?.resolved_agent_id ?? null : null

  // The form collects a generator script, so it posts to the generator route.
  // `/adapters` is the raw contract route and requires an `image` the form has
  // no field for; sending the form there fails with "image is required".
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post<Adapter>(`/api/projects/${id}/adapters/from-generator`, body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['adapters', id] }); setCreating(false); setMsg({ tone: 'ok', text: 'Adapter created' }) },
    onError: (e) => setMsg({ tone: 'danger', text: errText(e) }),
  })

  return (
    <>
      {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}

      {readiness.data && !readiness.data.canRunEvals && (
        <Banner tone="warn">
          Setup is incomplete, so eval runs are blocked. {readiness.data.checks.filter((c) => !c.ok).map((c) => `${c.step}: ${c.detail}. ${c.action ?? ''}`).join(' ')}
        </Banner>
      )}

      <Panel title="Setup steps" actions={<button onClick={() => setDocOpen(true)}>Adapter docs</button>}>
        {readiness.isLoading && <Spinner label="Checking setup…" />}
        {readiness.isError && <Banner tone="danger">{errText(readiness.error)}</Banner>}
        {readiness.data && (
          <table>
            <thead><tr><th>Step</th><th>Status</th><th>Now</th><th>To unblock</th></tr></thead>
            <tbody>{readiness.data.checks.map((c) => (
              <tr key={c.step}>
                <td style={{ color: 'var(--text)', fontWeight: 600 }}>{c.step}</td>
                <td><span className="chip">{c.ok ? 'ready' : 'blocked'}</span></td>
                <td>{c.detail}</td>
                <td>{c.ok ? '—' : (c.action ?? '')}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Panel>

      <Panel
        title={`Adapters (${q.data?.adapters.length ?? 0})`}
        actions={<button className="primary" onClick={() => setCreating(true)}>New adapter</button>}
      >
        {q.isLoading && <Spinner label="Loading adapters…" />}
        {q.isError && <Banner tone="danger">{errText(q.error)}</Banner>}
        {q.data?.adapters.length === 0 && (
          // A project running a built-in adapter owns no adapter row, so a bare
          // "No adapters yet / Create one" contradicted the Setup steps table
          // directly above it, which reports the adapter step ready. Say which
          // situation this is.
          builtinAdapter
            ? <Empty title={`Using the built-in ${builtinAdapter} adapter`}>
                <p style={{ color: 'var(--text-dim)', fontSize: 13, margin: 0 }}>
                  Nothing to configure here. Build your own adapter only if you need a launch command the built-in one does not cover.
                </p>
                <button onClick={() => setCreating(true)}>New adapter</button>
              </Empty>
            : <Empty title="No adapters yet"><button className="primary" onClick={() => setCreating(true)}>Create one</button></Empty>
        )}
        {q.data && q.data.adapters.length > 0 && (
          <table>
            <thead><tr><th>Agent</th><th>Install type</th><th>Source repo / commit</th><th>Provider</th><th>Model</th><th>Image</th><th /></tr></thead>
            <tbody>{q.data.adapters.map((a, i) => (
              <tr key={a.id ?? i}>
                <td style={{ color: 'var(--text)', fontWeight: 600 }}>{a.agent_id ?? a.agentId ?? a.name}</td>
                <td><span className="chip">{a.install_type ?? a.installType ?? '—'}</span></td>
                <td><Mono>{a.sourceRepo ?? '—'}</Mono> <Mono copy>{a.sourceCommit ?? ''}</Mono></td>
                <td><Mono>{a.defaultProvider ?? '—'}</Mono></td>
                <td><Mono>{a.default_model ?? a.defaultModel ?? '—'}</Mono></td>
                <td><Mono copy>{a.image ?? '—'}</Mono></td>
                <td><button className="danger" onClick={() => { if (confirm(`Delete adapter?`)) api.del(`/api/projects/${id}/adapters/${a.id}`).then(() => qc.invalidateQueries({ queryKey: ['adapters', id] })) }}>Delete</button></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Panel>

      {q.data?.adapters.map((a) => (
        <AdapterVersions key={a.id} projectId={id} adapter={a} />
      ))}

      <Modal title="New adapter" open={creating} onClose={() => setCreating(false)}>
        <form className="form-grid" onSubmit={(e) => {
          e.preventDefault()
          const f = new FormData(e.currentTarget)
          create.mutate({
            agent_id: f.get('agent_id'),
            name: f.get('name'),
            generator: f.get('generator'),
            install_type: f.get('install_type'),
            source_repo: f.get('source_repo') || undefined,
            source_ref: f.get('source_ref') || undefined,
            default_provider: f.get('default_provider') || undefined,
            default_model: f.get('default_model') || undefined,
            build: true,
          })
        }}>
          <Field label="Agent id" hint="letters, numbers, dot, underscore, dash"><input name="agent_id" required autoFocus /></Field>
          <Field label="Name"><input name="name" required /></Field>
          <Field label="Generator" hint="bash/JS script that emits the adapter"><textarea name="generator" rows={4} required style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }} /></Field>
          <Field label="Install type"><select name="install_type"><option value="npm">npm</option><option value="pip">pip</option><option value="binary">binary</option><option value="docker">docker</option></select></Field>
          <Field label="Source repo"><input name="source_repo" placeholder="https://github.com/…" /></Field>
          <Field label="Source ref"><input name="source_ref" placeholder="main" /></Field>
          <Field label="Default provider" hint="We speak two wire formats"><select name="default_provider" defaultValue=""><option value="">from project settings</option><option value="openai">openai</option><option value="anthropic">anthropic</option></select></Field>
          <Field label="Default model"><input name="default_model" placeholder="model id the endpoint serves" /></Field>
          <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 'var(--s2)' }}>
            <button type="submit" className="primary" disabled={create.isPending}>{create.isPending ? 'Creating + building…' : 'Create & build'}</button>
            <button type="button" onClick={() => setCreating(false)}>Cancel</button>
          </div>
        </form>
      </Modal>

      <Modal title="How to write an adapter for your agent" open={docOpen} onClose={() => setDocOpen(false)}>
        <article style={{ fontSize: 13, color: 'var(--text-dim)', maxWidth: 760, display: 'grid', gap: 'var(--s4)' }}>
          {docs.isLoading && <Spinner label="Loading adapter docs…" />}
          {docs.isError && <Banner tone="danger">{errText(docs.error)}</Banner>}
          {docs.data && <>
            <p>{docs.data.summary}</p>

            {docs.data.sections.map((sec) => (
              <section key={sec.id}>
                <h2 style={{ color: 'var(--text)', fontSize: 14, margin: '0 0 var(--s2)' }}>{sec.title}</h2>
                {sec.body.map((para, i) => <p key={i} style={{ margin: '0 0 var(--s2)' }}>{para}</p>)}
                {sec.fields && (
                  <table><thead><tr><th>Field</th><th>Required</th><th>Meaning</th></tr></thead>
                    <tbody>{sec.fields.map((f) => (
                      <tr key={f.name}><td><Mono>{f.name}</Mono></td><td>{f.required ? 'yes' : ''}</td><td>{f.description}</td></tr>
                    ))}</tbody>
                  </table>
                )}
                {sec.code && <>
                  <div style={{ fontSize: 12, marginBottom: 4 }}>{sec.code.label}</div>
                  <pre className="code" style={{ maxHeight: 320 }}>{sec.code.source}</pre>
                </>}
              </section>
            ))}

            <section>
              <h2 style={{ color: 'var(--text)', fontSize: 14, margin: '0 0 var(--s2)' }}>Credential names you may map</h2>
              <p>Your adapter declares which environment variable <em>your CLI</em> reads. The platform supplies the value from one of these names, which the project config sets.</p>
              <table><thead><tr><th>Harness name</th><th>API type</th><th>Set by stage config</th><th>Meaning</th></tr></thead>
                <tbody>{docs.data.credential_contract.credentials.map((c) => (
                  <tr key={c.name}>
                    <td><Mono copy>{c.name}</Mono></td>
                    <td>{c.apiType ?? '—'}</td>
                    <td>{c.stageManaged ? 'yes' : 'no'}</td>
                    <td>{c.description}</td>
                  </tr>
                ))}</tbody>
              </table>
            </section>

            <section>
              <h2 style={{ color: 'var(--text)', fontSize: 14, margin: '0 0 var(--s2)' }}>Command placeholders</h2>
              <table><thead><tr><th>Placeholder</th><th>Expands to</th></tr></thead>
                <tbody>{docs.data.template_placeholders.map((t) => (
                  <tr key={t.name}><td><Mono>{t.name}</Mono></td><td>{t.description}</td></tr>
                ))}</tbody>
              </table>
            </section>

            <section>
              <h2 style={{ color: 'var(--text)', fontSize: 14, margin: '0 0 var(--s2)' }}>Evidence roles</h2>
              <table><thead><tr><th>Role</th><th>What goes in it</th></tr></thead>
                <tbody>{docs.data.evidence_roles.map((r) => (
                  <tr key={r.name}><td><Mono>{r.name}</Mono></td><td>{r.description}</td></tr>
                ))}</tbody>
              </table>
            </section>

            <section>
              <h2 style={{ color: 'var(--text)', fontSize: 14, margin: '0 0 var(--s2)' }}>Required order</h2>
              <p>Steps run in this order: {docs.data.readiness.order.join(' → ')}.</p>
              <table><thead><tr><th>Step</th><th>Rule</th><th>Blocks</th></tr></thead>
                <tbody>{docs.data.readiness.requirements.map((r) => (
                  <tr key={r.step}><td><Mono>{r.step}</Mono></td><td>{r.rule}</td><td>{r.blocks.join(', ') || '—'}</td></tr>
                ))}</tbody>
              </table>
            </section>
          </>}
        </article>
      </Modal>
    </>
  )
}

/**
 * Built agent versions for one adapter. A queue generation pins one of these
 * commits; "Use on next run" writes that SHA onto the project's queue.
 */
function AdapterVersions({ projectId, adapter }: { projectId: string; adapter: Adapter }) {
  const qc = useQueryClient()
  const [ref, setRef] = useState('')
  const [msg, setMsg] = useState<{ tone: 'danger' | 'ok'; text: string } | null>(null)
  const install = adapter.install_type ?? adapter.installType
  const versions = useQuery({
    queryKey: ['adapter-versions', projectId, adapter.id],
    queryFn: () => api.get<{ versions: AdapterVersion[] }>(`/api/projects/${projectId}/adapters/${adapter.id}/versions`),
  })
  const queue = useQuery({
    queryKey: ['queue', projectId],
    queryFn: () => api.get<{ queue: EvalQueue }>(`/api/projects/${projectId}/queue`),
  })
  const build = useMutation({
    mutationFn: (r: string) => api.post<{ version: AdapterVersion }>(`/api/projects/${projectId}/adapters/${adapter.id}/versions`, { ref: r }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['adapter-versions', projectId, adapter.id] })
      setRef('')
      setMsg({ tone: 'ok', text: 'Version built' })
    },
    onError: (e) => setMsg({ tone: 'danger', text: errText(e) }),
  })
  const pin = useMutation({
    mutationFn: (commit: string) => {
      const queueId = queue.data?.queue.id
      if (!queueId) throw new Error('open the queue page once so this project has a queue to pin')
      return api.patch(`/api/projects/${projectId}/queues/${queueId}`, { agent_commit: commit })
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['queue', projectId] })
      setMsg({ tone: 'ok', text: 'Pinned on the queue. The next start uses this commit.' })
    },
    onError: (e) => setMsg({ tone: 'danger', text: errText(e) }),
  })
  const pinned = queue.data?.queue.agentCommit ?? null
  const rows = versions.data?.versions ?? []

  return (
    <Panel
      title={`Versions · ${adapter.agent_id ?? adapter.agentId ?? adapter.name ?? adapter.id}`}
      actions={
        install === 'npm'
          ? undefined
          : (
            <form
              style={{ display: 'flex', gap: 'var(--s2)' }}
              onSubmit={(e) => { e.preventDefault(); if (ref.trim()) build.mutate(ref.trim()) }}
            >
              <input
                value={ref}
                onChange={(e) => setRef(e.target.value)}
                placeholder="branch, tag, or full commit"
                aria-label="Ref to build"
                style={{ minWidth: 220 }}
              />
              <button className="primary" type="submit" disabled={build.isPending || !ref.trim()}>
                {build.isPending ? 'Building…' : 'Build version'}
              </button>
            </form>
          )
      }
    >
      {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}
      {install === 'npm' && (
        <p style={{ color: 'var(--text-dim)', fontSize: 13, marginTop: 0 }}>
          npm adapters have no per-commit versions. Rebuild the adapter itself to change what runs.
        </p>
      )}
      {versions.isLoading && <Spinner label="Loading versions…" />}
      {versions.isError && <Banner tone="danger">{errText(versions.error)}</Banner>}
      {rows.length === 0 && !versions.isLoading && install !== 'npm' && (
        <Empty title="No versions built yet">
          Build a ref from the adapter source repo. The next start pins whichever commit you pick here.
        </Empty>
      )}
      {rows.length > 0 && (
        <table>
          <thead><tr><th>Version</th><th>Commit</th><th>Status</th><th>Image</th><th /></tr></thead>
          <tbody>
            {rows.map((v) => {
              const commit = v.commit ?? ''
              const isPinned = Boolean(commit && pinned && pinned === commit)
              return (
                <tr key={v.id}>
                  <td style={{ color: 'var(--text)', fontWeight: 600 }}>{v.version ?? '—'}</td>
                  <td><Mono copy>{commit || '—'}</Mono>{isPinned ? <span className="chip accent" style={{ marginLeft: 8 }}>on queue</span> : null}</td>
                  <td><StateBadge state={v.status} /></td>
                  <td><Mono copy>{v.image ?? '—'}</Mono></td>
                  <td>
                    {commit && (
                      <button onClick={() => pin.mutate(commit)} disabled={pin.isPending || isPinned}>
                        {isPinned ? 'Pinned' : 'Use on next run'}
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </Panel>
  )
}
