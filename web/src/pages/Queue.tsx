import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'
import { api, errText } from '../lib/api'
import type { EvalQueue, EvalTask, QueueItem } from '../lib/types'
import { Banner, Empty, Field, Modal, Mono, PageHead, Panel, Spinner, StateBadge } from '../components/ui'

interface QueueRow { queue: EvalQueue; items: QueueItem[] }

export default function Queue() {
  const { id } = useParams()
  const qc = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [adding, setAdding] = useState(false)
  const [targetQueue, setTargetQueue] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ tone: 'danger' | 'ok'; text: string } | null>(null)

  const q = useQuery({ queryKey: ['queues', id], queryFn: () => api.get<{ queues: QueueRow[] }>(`/api/projects/${id}/queues`) })
  const evals = useQuery({ queryKey: ['evals', id], queryFn: () => api.get<{ evals: EvalTask[] }>(`/api/projects/${id}/evals`) })

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post<{ queue: EvalQueue }>(`/api/projects/${id}/queues`, body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['queues', id] }); setCreating(false); setMsg({ tone: 'ok', text: 'Queue created' }) },
    onError: (e) => setMsg({ tone: 'danger', text: errText(e) }),
  })

  const addItem = useMutation({
    mutationFn: ({ queueId, taskId }: { queueId: string; taskId: string }) => api.post(`/api/projects/${id}/queues/${queueId}/items`, { eval_id: taskId }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['queues', id] }); setAdding(false); setMsg({ tone: 'ok', text: 'Eval added to queue' }) },
    onError: (e) => setMsg({ tone: 'danger', text: errText(e) }),
  })

  const control = useMutation({
    mutationFn: ({ queueId, action }: { queueId: string; action: string }) => api.patch(`/api/projects/${id}/queues/${queueId}/container`, { action }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['queues', id] }),
    onError: (e) => setMsg({ tone: 'danger', text: errText(e) }),
  })

  return (
    <>
      <PageHead title="Queue" sub="Eval queues, container control, provider/model config" actions={<button className="primary" onClick={() => setCreating(true)}>New queue</button>} />
      {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}

      {q.isLoading && <Spinner label="Loading queues…" />}
      {q.data?.queues.length === 0 && <Empty title="No queues yet" />}

      {q.data?.queues.map(({ queue, items }) => (
        <Panel key={queue.id} title={<span>{queue.name} <Mono>{queue.id}</Mono></span>} actions={
          <div className="badge-row">
            <StateBadge state={queue.status} />
            <button onClick={() => control.mutate({ queueId: queue.id, action: 'pause' })}>Pause</button>
            <button onClick={() => control.mutate({ queueId: queue.id, action: 'resume' })}>Resume</button>
            <button onClick={() => control.mutate({ queueId: queue.id, action: 'abort' })}>Abort run</button>
            <button onClick={() => { setTargetQueue(queue.id); setAdding(true) }}>Add eval</button>
          </div>
        }>
          <div className="badge-row" style={{ marginBottom: 'var(--s3)' }}>
            <span className="chip">agent: <Mono>{queue.agentId ?? queue.builtinAdapterId ?? '—'}</Mono></span>
            <span className="chip">provider: <Mono>{queue.provider ?? '—'}</Mono></span>
            <span className="chip">model: <Mono>{queue.model ?? '—'}</Mono></span>
            <span className="chip">network: <Mono>{queue.networkPolicy ?? 'allow'}</Mono></span>
          </div>
          {items.length === 0 ? <Empty title="No evals in this queue" /> : (
            <table>
              <thead><tr><th>#</th><th>Eval</th><th>Repeats</th><th>Claimed</th><th>Enabled</th></tr></thead>
              <tbody>{items.map((it) => {
                const t = evals.data?.evals.find((e) => e.id === it.taskId)
                return (
                  <tr key={it.id}>
                    <td className="num">{it.position}</td>
                    <td style={{ color: 'var(--text)' }}>{t?.name ?? '—'} <Mono copy>{it.taskId}</Mono></td>
                    <td className="num">{it.repeats}</td>
                    <td className="num">{it.claimedRepeats}</td>
                    <td>{it.enabled ? '✓' : '—'}</td>
                  </tr>
                )
              })}</tbody>
            </table>
          )}
        </Panel>
      ))}

      <Modal title="New queue" open={creating} onClose={() => setCreating(false)}>
        <form className="form-grid" onSubmit={(e) => {
          e.preventDefault()
          const f = new FormData(e.currentTarget)
          create.mutate({
            name: f.get('name'),
            builtin_adapter_id: f.get('builtin_adapter_id') || undefined,
            agent_id: f.get('agent_id') || undefined,
            model: f.get('model') || undefined,
            provider: f.get('provider') || undefined,
            network_policy: f.get('network_policy') || undefined,
          })
        }}>
          <Field label="Name"><input name="name" required autoFocus /></Field>
          <Field label="Builtin adapter" hint="reapercode | pi"><input name="builtin_adapter_id" /></Field>
          <Field label="Or agent id (adapter)"><input name="agent_id" /></Field>
          <Field label="Provider" hint="from the adapter / connection"><input name="provider" placeholder="openai-compatible" /></Field>
          <Field label="Model" hint="the model the agent runs on"><input name="model" placeholder="deepseek-v4-flash" /></Field>
          <Field label="Network policy"><select name="network_policy"><option value="allow">allow</option><option value="offline">offline</option><option value="allowlist">allowlist</option></select></Field>
          <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 'var(--s2)' }}>
            <button type="submit" className="primary" disabled={create.isPending}>{create.isPending ? 'Creating…' : 'Create'}</button>
            <button type="button" onClick={() => setCreating(false)}>Cancel</button>
          </div>
        </form>
      </Modal>

      <Modal title="Add eval to queue" open={adding} onClose={() => setAdding(false)}>
        {evals.data?.evals.length === 0 && <Empty title="No evals to add" />}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s2)', maxHeight: 360, overflow: 'auto' }}>
          {evals.data?.evals.map((t) => (
            <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border)', padding: '6px 0' }}>
              <span>{t.name} <Mono copy>{t.id}</Mono></span>
              <button className="primary" onClick={() => addItem.mutate({ queueId: targetQueue!, taskId: t.id })}>Add</button>
            </div>
          ))}
        </div>
      </Modal>
    </>
  )
}
