import { useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api, download, errText } from '../lib/api'
import type { Campaign, EvalQueue, Generation, PiStatus, PipelineItem, Project } from '../lib/types'
import { Banner, Empty, Field, Mono, PageHead, Panel, Spinner, StateBadge } from '../components/ui'

export default function Phase2() {
  const [projectId, setProjectId] = useState('')
  const [genId, setGenId] = useState('')
  const [msg, setMsg] = useState<{ tone: 'danger' | 'ok'; text: string } | null>(null)

  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api.get<{ projects: Project[] }>('/api/projects') })

  const queues = useQuery({
    queryKey: ['phase2-queues', projectId],
    enabled: !!projectId,
    queryFn: () => api.get<{ queues: { queue: EvalQueue }[] }>(`/api/projects/${projectId}/queues`),
  })

  const gen = useQuery({
    queryKey: ['generation', genId],
    enabled: !!genId,
    queryFn: () => api.get<{ generation: Generation; items: PipelineItem[]; campaign: Campaign | null }>(`/api/projects/${projectId}/pipeline/generation/${genId}`),
    refetchInterval: 5000,
  })

  const campaignId = gen.data?.campaign?.id
  const pi = useQuery({
    queryKey: ['pi-status', campaignId],
    enabled: !!campaignId,
    queryFn: () => api.get<PiStatus>(`/api/projects/${projectId}/pipeline/campaign/${campaignId}/status`),
    refetchInterval: 5000,
  })

  const advance = useMutation({
    mutationFn: (trigger: string) => api.post(`/api/projects/${projectId}/pipeline/generation/${genId}/advance`, { trigger }),
    onError: (e) => setMsg({ tone: 'danger', text: errText(e) }),
  })
  const resume = useMutation({
    mutationFn: () => api.post(`/api/projects/${projectId}/pipeline/campaign/${campaignId}/resume`, {}),
    onError: (e) => setMsg({ tone: 'danger', text: errText(e) }),
  })
  const pause = useMutation({
    mutationFn: () => api.post(`/api/projects/${projectId}/pipeline/campaign/${campaignId}/pause`, {}),
    onError: (e) => setMsg({ tone: 'danger', text: errText(e) }),
  })

  const packUrl = useMemo(
    () => (projectId && campaignId ? `/api/projects/${projectId}/pipeline/campaign/${campaignId}/pack` : null),
    [projectId, campaignId],
  )

  return (
    <>
      <PageHead title="Phase 2" sub="Unified pipeline + cross-eval developer pack" />
      {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}

      <Panel title="Select project / generation">
        <form className="form-grid" onSubmit={(e) => { e.preventDefault() }}>
          <Field label="Project">
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">— select —</option>
              {projects.data?.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <Field label="Generation id">
            <input value={genId} onChange={(e) => setGenId(e.target.value)} placeholder="pgen_…" style={{ minWidth: 280 }} />
          </Field>
        </form>
        {projectId && queues.data && <p style={{ color: 'var(--text-dim)' }}>Queues: {queues.data.queues.map((q) => q.queue.name).join(', ')}</p>}
      </Panel>

      {gen.isLoading && <Spinner label="Loading generation…" />}
      {gen.isError && <Banner tone="danger">{errText(gen.error)}</Banner>}

      {gen.data && (
        <Panel title={<span>Generation <Mono copy>{gen.data.generation.id}</Mono></span>} actions={
          <div className="badge-row">
            <StateBadge state={gen.data.generation.state} />
            <button onClick={() => advance.mutate('auto')} disabled={advance.isPending}>Advance (auto)</button>
            {campaignId && <button onClick={() => resume.mutate()} disabled={resume.isPending}>Resume PI</button>}
            {campaignId && <button onClick={() => pause.mutate()} disabled={pause.isPending}>Pause PI</button>}
            {packUrl && <button className="primary" onClick={() => download(packUrl)}>Download developer pack</button>}
          </div>
        }>
          {gen.data.items.length === 0 && <Empty title="No pipeline items" />}
          <table>
            <thead><tr><th>Eval</th><th>Item state</th><th>Run</th><th>Retries</th><th>Result</th><th>Final view</th></tr></thead>
            <tbody>{gen.data.items.map((it) => (
              <tr key={it.id}>
                <td><Mono copy>{it.evalId}</Mono></td>
                <td><StateBadge state={it.state} /></td>
                <td><Mono copy>{it.runId ?? '—'}</Mono></td>
                <td className="num">{it.retryCount}</td>
                <td><Mono copy>{it.phase1ResultVersionId ?? '—'}</Mono></td>
                <td><Mono copy>{it.finalArchiveViewId ?? '—'}</Mono></td>
              </tr>
            ))}</tbody>
          </table>
        </Panel>
      )}

      {pi.data && (
        <Panel title="PI subagents">
          <div className="badge-row" style={{ marginBottom: 'var(--s3)' }}>
            <span className="chip">resumable: {pi.data.resumable ? 'yes' : 'no'}</span>
            <span className="chip">running: {pi.data.running ? 'yes' : 'no'}</span>
            <span className="chip">filed: {pi.data.filed.length}</span>
          </div>
          <table>
            <thead><tr><th>Agent</th><th>Exit</th><th>Turns</th></tr></thead>
            <tbody>{pi.data.subagents.map((s, i) => (
              <tr key={i}>
                <td style={{ color: 'var(--text)' }}>{s.agent}</td>
                <td className="num">{s.exitCode}</td>
                <td className="num">{s.turns}</td>
              </tr>
            ))}</tbody>
          </table>
        </Panel>
      )}
    </>
  )
}
