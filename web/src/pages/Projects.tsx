import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { api, errText } from '../lib/api'
import type { Project } from '../lib/types'
import { Banner, Empty, Field, Modal, Mono, PageHead } from '../components/ui'
import { STAGES, STAGE_COPY } from '../components/model-stage'

export default function Projects() {
  const qc = useQueryClient()
  const nav = useNavigate()
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const q = useQuery({ queryKey: ['projects'], queryFn: () => api.get<{ projects: Project[] }>('/api/projects') })

  // Creating a project only needs a name. Providers, models, and every other
  // setting live on the project's own settings page, where they can also be
  // changed later.
  const create = useMutation({
    mutationFn: (name: string) => api.post<Project>('/api/projects', { name }),
    onSuccess: (p) => {
      qc.invalidateQueries({ queryKey: ['projects'] })
      setCreating(false)
      nav(`/projects/${p.id}/settings`)
    },
    onError: (e) => setError(errText(e)),
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/projects/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['projects'] }),
    onError: (e) => setError(errText(e)),
  })

  return (
    <>
      <PageHead
        title="Projects"
        actions={<button className="primary" onClick={() => { setError(null); setCreating(true) }}>New project</button>}
        sub={`${q.data?.projects.length ?? 0} projects`}
      />
      {error && <Banner tone="danger">{error}</Banner>}

      <section className="panel">
        {q.isLoading && <Empty title="Loading projects…" />}
        {q.isError && <Banner tone="danger">Failed to load projects: {errText(q.error)}</Banner>}
        {q.data && q.data.projects.length === 0 && (
          <Empty title="No projects yet"><button className="primary" onClick={() => setCreating(true)}>Create your first project</button></Empty>
        )}
        {q.data && q.data.projects.length > 0 && (
          <table>
            <thead><tr><th>Name</th><th>Id</th><th>Model</th><th>Providers</th><th>Network</th><th style={{ width: 300 }}>Open</th><th /></tr></thead>
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
                      <Link to={`/projects/${p.id}/settings`}><button>Settings</button></Link>
                      <Link to={`/projects/${p.id}/adapters`}><button>Adapters</button></Link>
                      <Link to={`/projects/${p.id}/evals`}><button>Evals</button></Link>
                      <Link to={`/projects/${p.id}/queue`}><button>Queue</button></Link>
                    </td>
                    <td><button className="danger" onClick={() => { if (confirm(`Delete project ${p.name}?`)) remove.mutate(p.id) }}>Delete</button></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </section>

      <Modal title="New project" open={creating} onClose={() => setCreating(false)}>
        <form
          style={{ width: 'min(440px, 86vw)', display: 'flex', flexDirection: 'column', gap: 'var(--s4)' }}
          onSubmit={(e) => {
            e.preventDefault()
            const name = String(new FormData(e.currentTarget).get('name') ?? '').trim()
            if (name) create.mutate(name)
          }}
        >
          <Field label="Name" hint="Providers and models come next, on the project settings page.">
            <input name="name" required autoFocus placeholder="Payments agent" />
          </Field>
          <div style={{ display: 'flex', gap: 'var(--s2)' }}>
            <button type="submit" className="primary" disabled={create.isPending}>{create.isPending ? 'Creating…' : 'Create'}</button>
            <button type="button" onClick={() => setCreating(false)}>Cancel</button>
          </div>
        </form>
      </Modal>
    </>
  )
}
