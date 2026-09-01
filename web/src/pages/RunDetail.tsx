import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'
import { api, errText } from '../lib/api'
import { Banner, Mono, PageHead, Panel, Spinner, StateBadge, Tabs } from '../components/ui'

interface Run {
  id: string
  project_id?: string
  task_id?: string
  agent_id?: string
  model?: string
  provider?: string
  status?: string
  control_state?: string
  started_at?: string
  ended_at?: string
  duration_ms?: number
  input_tokens?: number
  output_tokens?: number
  total_cost?: number
  error?: string | null
  [k: string]: unknown
}

interface Metrics {
  run_id?: string
  execution?: { eventCount?: number; toolCallCount?: number; mutationCount?: number; verificationCount?: number; [k: string]: unknown }
  [k: string]: unknown
}

export default function RunDetail() {
  const { id } = useParams()
  const [tab, setTab] = useState('overview')
  const [events, setEvents] = useState<string[]>([])
  const [eventsOpen, setEventsOpen] = useState(false)
  const [eventsError, setEventsError] = useState<string | null>(null)

  const run = useQuery({ queryKey: ['run', id], queryFn: () => api.get<Run>(`/api/runs/${id}`) })
  const metrics = useQuery({ queryKey: ['metrics', id], queryFn: () => api.get<Metrics>(`/api/evals/${id}/metrics`), enabled: !!id })

  // Live event stream. Sealed runs replay their canonical trace from the
  // archived events.jsonl; live runs tail as the run progresses.
  useEffect(() => {
    if (!id || !eventsOpen) return
    setEvents([])
    setEventsError(null)
    const src = new EventSource(`/api/runs/${id}/events`)
    src.onmessage = (e) => {
      try {
        const obj = JSON.parse(e.data)
        setEvents((prev) => [...prev.slice(-500), obj])
      } catch { /* keep raw */ }
    }
    src.onerror = () => setEventsError('event stream ended or unavailable')
    return () => src.close()
  }, [id, eventsOpen])

  const r = run.data

  return (
    <>
      <PageHead
        title={<span>Run <Mono copy>{id}</Mono></span>}
        sub={r ? `${r.agent_id ?? 'agent'} · ${r.model ?? '—'} · ${r.task_id ?? ''}` : undefined}
      />
      {run.isError && <Banner tone="danger">{errText(run.error)}</Banner>}

      {run.isLoading && <Spinner label="Loading run…" />}

      {r && (
        <>
          <div className="badge-row">
            <StateBadge state={r.status} />
            <span className="chip">control: {r.control_state ?? '—'}</span>
            <span className="chip">tokens in <Mono>{r.input_tokens ?? '—'}</Mono></span>
            <span className="chip">tokens out <Mono>{r.output_tokens ?? '—'}</Mono></span>
            <span className="chip">cost <Mono>{r.total_cost ?? '—'}</Mono></span>
            <span className="chip">duration <Mono>{r.duration_ms ? `${r.duration_ms}ms` : '—'}</Mono></span>
          </div>

          <Tabs tabs={['overview', 'events', 'metrics']} active={tab} onChange={setTab} />

          {tab === 'overview' && (
            <Panel title="Run record">
              <pre className="code" style={{ maxHeight: 400 }}>{JSON.stringify(r, null, 2)}</pre>
            </Panel>
          )}

          {tab === 'events' && (
            <Panel title="Canonical events" actions={<button onClick={() => setEventsOpen((v) => !v)}>{eventsOpen ? 'Stop' : 'Start stream'}</button>}>
              {!eventsOpen && <div className="empty"><div className="title">Stream stopped</div>Start the stream to see run.start, tool calls, turn ends, and run.end live.</div>}
              {eventsOpen && eventsError && <Banner tone="warn">{eventsError}</Banner>}
              {eventsOpen && events.length === 0 && !eventsError && <Spinner label="Waiting for events…" />}
              {events.length > 0 && (
                <div style={{ maxHeight: 480, overflow: 'auto' }}>
                  {events.map((e, i) => <div key={i} style={{ borderBottom: '1px solid var(--border)', padding: '4px 0', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)' }}>{e}</div>)}
                </div>
              )}
            </Panel>
          )}

          {tab === 'metrics' && (
            <Panel title="Deterministic metrics">
              {metrics.isLoading && <Spinner label="Loading metrics…" />}
              {metrics.isError && <Banner tone="danger">{errText(metrics.error)}</Banner>}
              {metrics.data && (
                <>
                  <div className="badge-row" style={{ marginBottom: 'var(--s3)' }}>
                    <span className="chip">events <Mono>{metrics.data.execution?.eventCount ?? '—'}</Mono></span>
                    <span className="chip">tool calls <Mono>{metrics.data.execution?.toolCallCount ?? '—'}</Mono></span>
                    <span className="chip">mutations <Mono>{metrics.data.execution?.mutationCount ?? '—'}</Mono></span>
                    <span className="chip">verifications <Mono>{metrics.data.execution?.verificationCount ?? '—'}</Mono></span>
                  </div>
                  <pre className="code" style={{ maxHeight: 420 }}>{JSON.stringify(metrics.data, null, 2)}</pre>
                </>
              )}
            </Panel>
          )}

        </>
      )}
    </>
  )
}
