import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api, errText } from '../lib/api'
import { Banner, Field, Mono, PageHead, Panel, Spinner, StateBadge } from '../components/ui'

interface ResultVersion {
  id: string
  runId?: string
  trackId?: string
  reportSha256?: string
  reportPath?: string
  publication_state?: string
  created_at?: string
}

export default function Phase1() {
  const [runId, setRunId] = useState('')
  const [queueId, setQueueId] = useState('')
  const [msg, setMsg] = useState<{ tone: 'danger' | 'ok'; text: string } | null>(null)

  const phase1 = useQuery({
    queryKey: ['phase1-status', runId],
    enabled: runId.trim().length > 0,
    queryFn: () => api.get<{ result_version?: ResultVersion; accepted?: boolean; status?: string }>(`/api/judge/runs/${runId}/phase1`),
    refetchInterval: 5000,
  })

  const results = useQuery({
    queryKey: ['run-results', runId],
    enabled: runId.trim().length > 0,
    queryFn: () => api.get<{ run_id: string; results: ResultVersion[] }>(`/api/judge/runs/${runId}/results`),
  })

  const queueStatus = useQuery({
    queryKey: ['judge-queue-status', queueId],
    enabled: queueId.trim().length > 0,
    queryFn: () => api.get<Record<string, unknown>>(`/api/judge/queues/${queueId}/status`),
    refetchInterval: 5000,
  })

  const start = useMutation({
    mutationFn: (runId: string) => api.post<{ accepted: boolean; run_id: string }>(`/api/judge/runs/${runId}/phase1`, {}),
    onSuccess: (d) => setMsg({ tone: 'ok', text: `Phase 1 accepted for ${d.run_id}` }),
    onError: (e) => setMsg({ tone: 'danger', text: errText(e) }),
  })
  const pauseRun = useMutation({
    mutationFn: (runId: string) => api.post(`/api/judge/runs/${runId}/phase1/pause`, {}),
    onSuccess: () => setMsg({ tone: 'ok', text: 'Phase 1 paused' }),
    onError: (e) => setMsg({ tone: 'danger', text: errText(e) }),
  })
  const pauseQueue = useMutation({
    mutationFn: (queueId: string) => api.post(`/api/judge/queues/${queueId}/pause`, { kind: 'manual' }),
    onSuccess: () => setMsg({ tone: 'ok', text: 'Judge queue paused' }),
    onError: (e) => setMsg({ tone: 'danger', text: errText(e) }),
  })
  const resumeQueue = useMutation({
    mutationFn: (queueId: string) => api.post(`/api/judge/queues/${queueId}/resume`, {}),
    onSuccess: () => setMsg({ tone: 'ok', text: 'Judge queue resumed' }),
    onError: (e) => setMsg({ tone: 'danger', text: errText(e) }),
  })

  const rv = phase1.data?.result_version
  const running = (phase1.data as { status?: string } | undefined)?.status === 'running' || (phase1.data as { accepted?: boolean } | undefined)?.accepted === true && !rv

  return (
    <>
      <PageHead title="Phase 1" sub="Per-eval judgement — kratos / logos / minos PI courtroom" />
      {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}

      <Panel title="Courtroom (per run)">
        <form className="badge-row" onSubmit={(e) => { e.preventDefault(); if (runId.trim()) start.mutate(runId.trim()) }}>
          <Field label="Run id"><input value={runId} onChange={(e) => setRunId(e.target.value)} placeholder="paste run id" style={{ minWidth: 340 }} /></Field>
          <button type="submit" className="primary" disabled={start.isPending}>{start.isPending ? 'Starting…' : 'Start / resume Phase 1'}</button>
          <button type="button" disabled={!runId.trim()} onClick={() => pauseRun.mutate(runId.trim())}>Pause</button>
        </form>
        <p className="hint" style={{ color: 'var(--text-faint)', marginTop: 'var(--s2)' }}>
          Re-posting resumes the same PI session. Status below auto-refreshes.
        </p>

        {runId && phase1.isLoading && <Spinner label="Loading status…" />}
        {phase1.isError && <Banner tone="danger">{errText(phase1.error)}</Banner>}
        {rv && (
          <div className="badge-row" style={{ marginTop: 'var(--s3)' }}>
            <span className="chip accent">published</span>
            <span>result <Mono copy>{rv.id}</Mono></span>
            <span>track <Mono>{rv.trackId}</Mono></span>
            <span>sha <Mono copy>{rv.reportSha256}</Mono></span>
          </div>
        )}
        {runId && !rv && !phase1.isLoading && <span className="status info"><span className="dot" />{running ? 'running' : 'not started'}</span>}
      </Panel>

      <Panel title="Result versions (per run)">
        {results.isLoading && <Spinner label="Loading results…" />}
        {results.data && results.data.results.length === 0 && <span style={{ color: 'var(--text-faint)' }}>No published result versions for this run.</span>}
        {results.data && results.data.results.length > 0 && (
          <table>
            <thead><tr><th>Result</th><th>Track</th><th>Report sha</th><th>State</th></tr></thead>
            <tbody>{results.data.results.map((r) => (
              <tr key={r.id}>
                <td><Mono copy>{r.id}</Mono></td>
                <td><Mono>{r.trackId}</Mono></td>
                <td><Mono copy>{r.reportSha256}</Mono></td>
                <td><StateBadge state={r.publication_state} /></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Panel>

      <Panel title="Judge queue (per queue)">
        <form className="badge-row" onSubmit={(e) => { e.preventDefault() }}>
          <Field label="Judge queue id"><input value={queueId} onChange={(e) => setQueueId(e.target.value)} placeholder="paste judge queue id" style={{ minWidth: 340 }} /></Field>
          <button type="button" disabled={!queueId.trim()} onClick={() => pauseQueue.mutate(queueId.trim())}>Pause</button>
          <button type="button" disabled={!queueId.trim()} onClick={() => resumeQueue.mutate(queueId.trim())}>Resume</button>
        </form>
        {queueId && queueStatus.isLoading && <Spinner label="Loading queue…" />}
        {queueStatus.isError && <Banner tone="danger">{errText(queueStatus.error)}</Banner>}
        {queueStatus.data && <pre className="code" style={{ maxHeight: 300 }}>{JSON.stringify(queueStatus.data, null, 2)}</pre>}
      </Panel>
    </>
  )
}
