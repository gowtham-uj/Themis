import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'
import { api, errText } from '../lib/api'
import type { EvalTask } from '../lib/types'
import { Banner, Empty, Field, Modal, Mono, PageHead, Panel, Spinner } from '../components/ui'

export default function Evals() {
  const { id } = useParams()
  const qc = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'danger' | 'ok'; text: string } | null>(null)

  const q = useQuery({ queryKey: ['evals', id], queryFn: () => api.get<{ evals: EvalTask[] }>(`/api/projects/${id}/evals`) })

  const create = useMutation({
    mutationFn: (upload: unknown) => api.post<EvalTask>(`/api/projects/${id}/evals`, upload),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['evals', id] }); setCreating(false); setMsg({ tone: 'ok', text: 'Eval created' }) },
    onError: (e) => setMsg({ tone: 'danger', text: errText(e) }),
  })

  return (
    <>
      <PageHead title="Evals" sub="Canonical eval packages" actions={<button className="primary" onClick={() => setCreating(true)}>New eval</button>} />
      {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}

      <Panel title={`Evals (${q.data?.evals.length ?? 0})`}>
        {q.isLoading && <Spinner label="Loading evals…" />}
        {q.isError && <Banner tone="danger">{errText(q.error)}</Banner>}
        {q.data?.evals.length === 0 && <Empty title="No evals yet" />}
        {q.data && q.data.evals.length > 0 && (
          <table>
            <thead><tr><th>Name</th><th>Category</th><th>Id</th><th>Version</th><th /></tr></thead>
            <tbody>{q.data.evals.map((t) => (
              <tr key={t.id}>
                <td style={{ color: 'var(--text)' }}>{t.name}</td>
                <td><span className="chip">{String(t.categoryName ?? '—')}</span></td>
                <td><Mono copy>{t.id}</Mono></td>
                <td><Mono>{String(t.version ?? '—')}</Mono></td>
                <td><button className="danger" onClick={() => { if (confirm(`Delete eval?`)) api.del(`/api/projects/${id}/evals/${t.id}`).then(() => qc.invalidateQueries({ queryKey: ['evals', id] })) }}>Delete</button></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Panel>

      <Modal title="New eval (canonical package JSON)" open={creating} onClose={() => setCreating(false)}>
        <form onSubmit={(e) => {
          e.preventDefault()
          const f = new FormData(e.currentTarget)
          try {
            create.mutate(JSON.parse(String(f.get('json'))))
          } catch {
            setMsg({ tone: 'danger', text: 'Invalid JSON' })
          }
        }}>
          <Field label="Canonical eval package (JSON)" hint="The EvalPackageUpload object: files, task.toml, seed_repo, tests, validation…">
            <textarea name="json" rows={16} required style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }} placeholder='{ "files": { "task.toml": "…", "seed_repo/…": "…" } }' />
          </Field>
          <div style={{ display: 'flex', gap: 'var(--s2)', marginTop: 'var(--s3)' }}>
            <button type="submit" className="primary" disabled={create.isPending}>{create.isPending ? 'Creating…' : 'Create'}</button>
            <button type="button" onClick={() => setCreating(false)}>Cancel</button>
          </div>
        </form>
        <p style={{ color: 'var(--text-faint)', fontSize: 12, marginTop: 'var(--s3)' }}>
          For archive import (zip/tar/tar.gz), use <Mono>POST /api/projects/:id/evals:import-archive?format=zip</Mono> — see the API reference.
        </p>
      </Modal>
    </>
  )
}
