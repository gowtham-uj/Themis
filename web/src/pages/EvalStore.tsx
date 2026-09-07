import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, errText } from '../lib/api'
import type { Project } from '../lib/types'
import { EvalUpload } from '../components/EvalUpload'
import { Banner, CategoryChip, Empty, Field, Modal, Mono, PageHead, Panel, Spinner } from '../components/ui'

interface StoreEvalRow {
  id: string
  name: string
  category_name?: string | null
  version?: number
  package_digest?: string | null
  created_at?: string
}

/**
 * The global eval store. Packages here belong to no project. Copying one into a
 * project gives that project its own package; the store keeps the original, so
 * every other project can still take it.
 */
export default function EvalStore() {
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [copying, setCopying] = useState<StoreEvalRow | null>(null)
  const [projectId, setProjectId] = useState('')
  const [msg, setMsg] = useState<{ tone: 'danger' | 'ok'; text: string } | null>(null)

  const q = useQuery({ queryKey: ['eval-store'], queryFn: () => api.get<{ evals: StoreEvalRow[] }>('/api/eval-store') })
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api.get<{ projects: Project[] }>('/api/projects') })

  const copy = useMutation({
    mutationFn: (v: { id: string; project_id: string }) =>
      api.post<{ project_id: string; name: string }>(`/api/eval-store/${v.id}/copy`, { project_id: v.project_id }),
    onSuccess: (r) => {
      setCopying(null)
      setMsg({ tone: 'ok', text: `Copied "${r.name}" into the project. The store copy is still here.` })
      void qc.invalidateQueries({ queryKey: ['evals'] })
    },
    onError: (e) => setMsg({ tone: 'danger', text: errText(e) }),
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/eval-store/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['eval-store'] }),
    onError: (e) => setMsg({ tone: 'danger', text: errText(e) }),
  })

  const rows = q.data?.evals ?? []

  return (
    <>
      <PageHead
        title="Eval store"
        sub="Packages shared across every project. Copy one into a project to run it; the store keeps its own copy."
        actions={<button className="primary" onClick={() => setAdding(true)}>Add eval</button>}
      />
      {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}

      <Panel title={`Store evals (${rows.length})`}>
        {q.isLoading && <Spinner label="Loading store…" />}
        {q.isError && <Banner tone="danger">{errText(q.error)}</Banner>}
        {q.data && rows.length === 0 && (
          <Empty title="The store is empty">
            Add a package archive or canonical JSON, then copy it into any project.
          </Empty>
        )}
        {rows.length > 0 && (
          <table>
            <thead><tr><th>Name</th><th>Category</th><th>Id</th><th>Digest</th><th /></tr></thead>
            <tbody>{rows.map((e) => (
              <tr key={e.id}>
                <td style={{ color: 'var(--text)' }}>{e.name}</td>
                <td><CategoryChip value={e.category_name} /></td>
                <td><Mono copy>{e.id}</Mono></td>
                <td><Mono>{e.package_digest ? e.package_digest.slice(0, 12) : '—'}</Mono></td>
                <td style={{ display: 'flex', gap: 'var(--s2)' }}>
                  <button onClick={() => { setProjectId(projects.data?.projects[0]?.id ?? ''); setCopying(e) }}>
                    Copy to project
                  </button>
                  <button
                    className="danger"
                    onClick={() => { if (confirm(`Remove "${e.name}" from the store?`)) remove.mutate(e.id) }}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Panel>

      <Modal title="Add eval to the store" open={adding} onClose={() => setAdding(false)}>
        <EvalUpload
          basePath="/api/eval-store"
          onCancel={() => setAdding(false)}
          onDone={() => {
            setAdding(false)
            setMsg({ tone: 'ok', text: 'Added to the store' })
            void qc.invalidateQueries({ queryKey: ['eval-store'] })
          }}
        />
      </Modal>

      <Modal title={`Copy "${copying?.name ?? ''}" to a project`} open={copying != null} onClose={() => setCopying(null)}>
        <Field label="Project" hint="The project gets its own package. This store entry stays available to everyone.">
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">Pick a project</option>
            {projects.data?.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <div style={{ display: 'flex', gap: 'var(--s2)', marginTop: 'var(--s3)' }}>
          <button
            className="primary"
            disabled={!projectId || copy.isPending}
            onClick={() => copying && copy.mutate({ id: copying.id, project_id: projectId })}
          >
            {copy.isPending ? 'Copying…' : 'Copy'}
          </button>
          <button onClick={() => setCopying(null)}>Cancel</button>
        </div>
      </Modal>
    </>
  )
}
