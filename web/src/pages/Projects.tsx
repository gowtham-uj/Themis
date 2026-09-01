import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api, errText } from '../lib/api'
import type { Project } from '../lib/types'
import { Banner, Empty, Field, Modal, Mono, PageHead } from '../components/ui'

export default function Projects() {
  const qc = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const q = useQuery({ queryKey: ['projects'], queryFn: () => api.get<{ projects: Project[] }>('/api/projects') })

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post<Project>('/api/projects', body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['projects'] }); setCreating(false) },
    onError: (e) => setError(errText(e)),
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/projects/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['projects'] }),
    onError: (e) => setError(errText(e)),
  })

  return (
    <>
      <PageHead title="Projects" actions={<button className="primary" onClick={() => setCreating(true)}>New project</button>} sub={`${q.data?.projects.length ?? 0} projects`} />
      {error && <Banner tone="danger">{error}</Banner>}

      <section className="panel">
        {q.isLoading && <Empty title="Loading projects…" />}
        {q.isError && <Banner tone="danger">Failed to load projects: {errText(q.error)}</Banner>}
        {q.data && q.data.projects.length === 0 && <Empty title="No projects yet"><button className="primary" onClick={() => setCreating(true)}>Create your first project</button></Empty>}
        {q.data && q.data.projects.length > 0 && (
          <table>
            <thead><tr><th>Name</th><th>Id</th><th>Model</th><th>Provider</th><th>Network</th><th style={{ width: 260 }}>Open</th><th /></tr></thead>
            <tbody>
              {q.data.projects.map((p) => (
                <tr key={p.id}>
                  <td style={{ color: 'var(--text)', fontWeight: 600 }}>{p.name}</td>
                  <td><Mono copy>{p.id}</Mono></td>
                  <td><Mono>{p.default_model ?? '—'}</Mono></td>
                  <td><Mono>{p.default_provider ?? '—'}</Mono></td>
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
              ))}
            </tbody>
          </table>
        )}
      </section>

      <Modal title="New project" open={creating} onClose={() => setCreating(false)}>
        <form className="form-grid" onSubmit={(e) => {
          e.preventDefault()
          const f = new FormData(e.currentTarget)
          create.mutate({
            name: f.get('name'),
            slug: f.get('slug'),
            default_model: f.get('default_model') || undefined,
            default_provider: f.get('default_provider') || undefined,
          })
        }}>
          <Field label="Name"><input name="name" required autoFocus /></Field>
          <Field label="Slug"><input name="slug" /></Field>
          <Field label="Default model"><input name="default_model" placeholder="deepseek-v4-flash" /></Field>
          <Field label="Default provider"><input name="default_provider" placeholder="openai-compatible" /></Field>
          <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 'var(--s2)' }}>
            <button type="submit" className="primary" disabled={create.isPending}>{create.isPending ? 'Creating…' : 'Create'}</button>
            <button type="button" onClick={() => setCreating(false)}>Cancel</button>
          </div>
        </form>
      </Modal>
    </>
  )
}
