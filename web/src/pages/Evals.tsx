import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { api, errText } from '../lib/api'
import type { EvalTask } from '../lib/types'
import { EvalUpload } from '../components/EvalUpload'
import { Banner, CategoryChip, Empty, Modal, Mono, PageHead, Panel, Spinner } from '../components/ui'

export default function Evals() {
  const { id } = useParams()
  const qc = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'danger' | 'ok'; text: string } | null>(null)

  const q = useQuery({ queryKey: ['evals', id], queryFn: () => api.get<{ evals: EvalTask[] }>(`/api/projects/${id}/evals`) })

  const publish = useMutation({
    mutationFn: (evalId: string) => api.post(`/api/projects/${id}/evals/${evalId}/publish`),
    onSuccess: () => setMsg({ tone: 'ok', text: 'Published to the global eval store' }),
    onError: (e) => setMsg({ tone: 'danger', text: errText(e) }),
  })

  return (
    <>
      <PageHead
        title="Evals"
        sub="This project's evals. Import a package here, then add it to the queue. Setup and cleanup live in the package."
        actions={<>
          <Link to="/eval-store"><button>Browse eval store</button></Link>
          <button className="primary" onClick={() => setCreating(true)}>Import evals</button>
        </>}
      />
      {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}

      <Panel title={`Evals (${q.data?.evals.length ?? 0})`}>
        {q.isLoading && <Spinner label="Loading evals…" />}
        {q.isError && <Banner tone="danger">{errText(q.error)}</Banner>}
        {q.data?.evals.length === 0 && (
          <Empty title="No evals yet">
            Upload a package archive, or copy one from the <Link to="/eval-store">eval store</Link>.
          </Empty>
        )}
        {q.data && q.data.evals.length > 0 && (
          <table>
            <thead><tr><th>Name</th><th>Category</th><th>Id</th><th>Version</th><th /></tr></thead>
            <tbody>{q.data.evals.map((t) => (
              <tr key={t.id}>
                <td style={{ color: 'var(--text)' }}>{t.name}</td>
                <td><CategoryChip value={(t.category_name ?? t.categoryName) as string | null} /></td>
                <td><Mono copy>{t.id}</Mono></td>
                <td><Mono>{String(t.version ?? '—')}</Mono></td>
                <td style={{ display: 'flex', gap: 'var(--s2)' }}>
                  <button disabled={publish.isPending} onClick={() => publish.mutate(t.id)}>Publish to store</button>
                  <button className="danger" onClick={() => { if (confirm('Retire this eval? It leaves this project but stays readable in every run that already used it.')) api.del(`/api/projects/${id}/evals/${t.id}`).then(() => qc.invalidateQueries({ queryKey: ['evals', id] })) }}>Retire</button>
                </td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Panel>

      <Modal title="Import eval packages" open={creating} onClose={() => setCreating(false)}>
        <EvalUpload
          basePath={`/api/projects/${id}/evals`}
          onCancel={() => setCreating(false)}
          onDone={() => {
            setCreating(false)
            setMsg({ tone: 'ok', text: 'Package import complete. The new evals are ready to add to the queue.' })
            void qc.invalidateQueries({ queryKey: ['evals', id] })
          }}
        />
      </Modal>
    </>
  )
}
