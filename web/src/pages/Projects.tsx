import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { api, errText } from '../lib/api'
import type { Project } from '../lib/types'
import { Banner, Empty, Field, Modal, Mono, PageHead } from '../components/ui'

export default function Projects() {
  const qc = useQueryClient()
  const nav = useNavigate()
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const q = useQuery({ queryKey: ['projects'], queryFn: () => api.get<{ projects: Project[] }>('/api/projects') })

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
        sub="One project is one agent under test. Open a project to see its runs, its evals, and its queue."
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
            <thead>
              <tr>
                <th>Name</th>
                <th>Agent</th>
                <th>Model</th>
                <th style={{ width: 120 }} />
                <th style={{ width: 90 }} />
              </tr>
            </thead>
            <tbody>
              {q.data.projects.map((p) => (
                <tr key={p.id} className="row-link" onClick={() => nav(`/projects/${p.id}`)}>
                  <td>
                    <Link to={`/projects/${p.id}`} style={{ color: 'var(--text)', fontWeight: 600, textDecoration: 'none' }}>
                      {p.name}
                    </Link>
                    {p.description && (
                      <div style={{ color: 'var(--text-faint)', fontSize: 12, marginTop: 2 }}>{p.description}</div>
                    )}
                  </td>
                  <td><Mono>{p.resolved_agent_id ?? p.default_agent_id ?? 'not set'}</Mono></td>
                  <td><Mono>{p.default_model ?? 'uses defaults'}</Mono></td>
                  <td>
                    <Link to={`/projects/${p.id}`} className="row-open">Open project →</Link>
                  </td>
                  <td>
                    <button className="danger" onClick={(e) => { e.stopPropagation(); if (confirm(`Delete project ${p.name}?`)) remove.mutate(p.id) }}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <Modal title="New project" open={creating} onClose={() => setCreating(false)}>
        <form onSubmit={(e) => {
          e.preventDefault()
          const f = new FormData(e.currentTarget)
          create.mutate(String(f.get('name') ?? '').trim())
        }}>
          <Field label="Name" hint="The agent you are testing. You will pick the adapter and evals next.">
            <input name="name" required autoFocus />
          </Field>
          <div style={{ display: 'flex', gap: 'var(--s2)', marginTop: 'var(--s3)' }}>
            <button type="submit" className="primary" disabled={create.isPending}>{create.isPending ? 'Creating…' : 'Create'}</button>
            <button type="button" onClick={() => setCreating(false)}>Cancel</button>
          </div>
        </form>
      </Modal>
    </>
  )
}
