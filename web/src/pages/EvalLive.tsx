import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, download, errText } from '../lib/api'
import type { ArchiveRow, Campaign, EvalTask, PipelineItem, PipelineQueue, QueueItem, Run } from '../lib/types'
import { Banner, Empty, Mono, PageHead, Panel, Spinner, StateBadge } from '../components/ui'

interface QueueView {
  queue: { id: string; agentId?: string; builtinAdapterId?: string; model?: string; status?: string; agentCommit?: string | null }
  items: QueueItem[]
  container: { state?: string } | null
  current_run_id?: string | null
  live?: boolean
  paused?: boolean
}

interface PipelineView {
  queue: PipelineQueue | null
  generation: { id: string; state?: string; ordinal?: number; name?: string | null } | null
}

interface GenerationView {
  generation: { id: string; state?: string; ordinal?: number; name?: string | null; createdAt?: string; completedAt?: string | null }
  items: PipelineItem[]
  campaign: Campaign | null
}

interface CampaignView {
  campaign: Campaign
  pi?: { running?: boolean; resumable?: boolean; subagents?: { agent?: string; turns?: number | null; exitCode?: number | null }[]; filed?: string[] }
}

interface FeedEvent {
  /** Server-assigned run-event ordinal. Used to resume a dropped stream and to
   *  drop events a reconnect replayed. */
  seq?: number
  type?: string
  ts?: string
  turn?: number
  name?: string
  text?: string
  status?: string
  durationMs?: number
  argv?: string[]
  exitCode?: number | null
  isError?: boolean
  actor?: string
  message?: string
  host?: string
  model?: string
  agent?: string
}

type PhaseKey = 'evals' | 'judge' | 'across'

type NodeKey = 'node0' | 'node1' | 'node2' | 'node3' | 'node4'

const PHASE1_NODES: NodeKey[] = ['node0', 'node1', 'node2', 'node3', 'node4']

/** Same wording the backend uses, so the panel and the API agree on the graph. */
const PHASE1_NODE_LABELS: Record<NodeKey, string> = {
  node0: 'Bind and summarize the archive',
  node1: 'Extract deterministic facts',
  node2: 'Run the metric catalog',
  node3: 'Clerk assembles the case',
  node4: 'Courtroom rounds',
}

interface Phase1CaseProgress {
  runId: string
  itemId: string
  evalId: string
  committedNode: NodeKey | null
  done: NodeKey[]
  active: NodeKey | null
  round: number | null
  judgeFiles: string[]
  published: boolean
}

interface StageProgress {
  stage: 'evals' | 'phase1' | 'phase2' | null
  generationState: string
  evals: { total: number; done: number; running: number; left: number; failed: number; currentOrdinal: number | null }
  phase1: { total: number; published: number; running: number; pending: number; cases: Phase1CaseProgress[] }
  phase2: {
    started: boolean
    running: boolean
    stalled?: boolean
    campaignState: string | null
    resealed: number
    members: number
    artifacts: string[]
    developerPack: boolean
  }
}

type ActivityStage = 'evals' | 'phase1' | 'phase2'

/** One thing that happened somewhere in the run. Mirrors the API row. */
interface ActivityEntry {
  ts: string
  stage: ActivityStage
  node: string | null
  kind: string
  text: string
  detail: string | null
  evalName: string | null
  evalId: string | null
  runId: string | null
  tone: 'info' | 'ok' | 'warn' | 'danger'
}

const STAGE_FILTERS: { key: ActivityStage | 'all'; label: string }[] = [
  { key: 'all', label: 'Everything' },
  { key: 'evals', label: 'Evals' },
  { key: 'phase1', label: 'Phase 1' },
  { key: 'phase2', label: 'Phase 2' },
]

const STAGE_SHORT: Record<ActivityStage, string> = { evals: 'eval', phase1: 'P1', phase2: 'P2' }

/** The agent's SSE feed carries a line for every token and internal state change.
 *  Only these types say something a person following the run wants to read. */
const FEED_WORTH_SHOWING = new Set(['run.start', 'run.end', 'tool.call', 'tool.result', 'exec', 'error'])

function clip(s: string, n = 180): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

function eventLine(ev: FeedEvent): { kind: string; text: string; cls: string } {
  switch (ev.type) {
    case 'run.start':
      return { kind: 'start', text: `${ev.agent ?? 'agent'} started${ev.model ? ` on ${ev.model}` : ''}`, cls: 'start' }
    case 'run.end':
      return { kind: 'end', text: `eval ${ev.status ?? 'ended'}${ev.durationMs != null ? ` in ${Math.round(ev.durationMs / 1000)}s` : ''}`, cls: 'end' }
    case 'turn.start':
      return { kind: 'turn', text: `turn ${ev.turn ?? '?'}`, cls: '' }
    case 'turn.end':
      return { kind: 'turn', text: `turn ${ev.turn ?? '?'} ended`, cls: '' }
    case 'tool.call':
      return { kind: 'tool', text: ev.name ?? 'tool', cls: 'tool' }
    case 'tool.result':
      return { kind: 'tool', text: `${ev.name ?? 'tool'} ${ev.isError ? 'failed' : 'ok'}`, cls: ev.isError ? 'error' : 'tool' }
    case 'message':
      return { kind: 'model', text: clip(ev.text ?? ''), cls: '' }
    case 'thinking':
      return { kind: 'think', text: clip(ev.text ?? 'thinking'), cls: '' }
    case 'exec': {
      const cmd = (ev.argv ?? []).slice(0, 8).join(' ')
      return { kind: ev.actor === 'operator' ? 'ops' : 'exec', text: `${cmd || 'command'}${ev.exitCode != null ? ` → ${ev.exitCode}` : ''}`, cls: ev.exitCode && ev.exitCode !== 0 ? 'error' : '' }
    }
    case 'net':
      return { kind: 'net', text: ev.host ?? 'network', cls: '' }
    case 'error':
      return { kind: 'error', text: clip(String(ev.message ?? ev.text ?? 'error')), cls: 'error' }
    case 'log':
      return { kind: 'log', text: clip(String(ev.message ?? ev.text ?? '')), cls: '' }
    case 'usage':
      return { kind: 'usage', text: 'token usage', cls: '' }
    default:
      return { kind: ev.type ?? 'event', text: clip(JSON.stringify(ev)), cls: '' }
  }
}

function clock(ts?: string): string {
  if (!ts) return ''
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ts.slice(11, 19)
  return d.toISOString().slice(11, 19)
}

function ago(ts?: string): string {
  if (!ts) return ''
  const d = new Date(ts).getTime()
  if (!Number.isFinite(d)) return ''
  const s = Math.max(0, Math.round((Date.now() - d) / 1000))
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}

function happening(it: PipelineItem): string {
  switch (it.state) {
    case 'eval_pending': return 'Waiting for the agent'
    case 'eval_running': return 'Agent is working'
    case 'archive_sealed': return 'Archive sealed. Waiting for the judge'
    case 'phase1_pending': return 'Queued for the judge'
    case 'phase1_running': return 'Courtroom in session'
    case 'phase1_published': return 'Verdict in. Archive has judge/'
    case 'phase2_attached': return 'Attached to the across pass'
    case 'final_view_published': return 'Final view sealed. Archive has phase2/'
    case 'failed': return 'Failed'
    case 'cancelled': return 'Cancelled'
    default: return it.state ?? ''
  }
}

/**
 * The backend derives the stage from item states and on-disk artifacts, which is
 * the only honest source: no generation row ever reads `phase1_running`. Fall
 * back to container liveness only before the progress endpoint answers.
 */
function stageOf(progress: StageProgress | undefined, live: boolean, paused: boolean, acrossRunning: boolean): PhaseKey | null {
  if (progress) {
    if (progress.stage === 'phase2') return 'across'
    if (progress.stage === 'phase1') return 'judge'
    if (progress.stage === 'evals') return 'evals'
    return null
  }
  if (acrossRunning) return 'across'
  if (live || paused) return 'evals'
  return null
}

/** Meter width. An empty stage reads as zero, not as a divide by zero. */
function pct(done: number, total: number): number {
  if (!total) return 0
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)))
}

/** Eval stage headline: counts first, because that is what the operator asked. */
function evalStageLine(p: StageProgress | undefined, total: number): string {
  if (!p || p.evals.total === 0) return total === 0 ? 'This run has no evals.' : `${total} queued.`
  const e = p.evals
  if (e.done === e.total) return `All ${e.total} completed.`
  // `left` counts everything not yet done, the running one included, so naming
  // both "left" and "running" beside each other has to exclude the overlap.
  const parts = [`${e.done} of ${e.total} completed`]
  if (e.running) parts.push(`${e.running} running`)
  const waiting = Math.max(0, e.left - e.running)
  if (waiting) parts.push(`${waiting} waiting`)
  if (e.failed) parts.push(`${e.failed} failed`)
  return parts.join(' · ')
}

function nowCopy(opts: {
  live: boolean
  paused: boolean
  pipelineHeld: boolean
  genState?: string
  evalName?: string
  index?: number
  total?: number
  acrossRunning: boolean
  progress?: StageProgress
}): string {
  const who = opts.evalName ? opts.evalName : 'the current eval'
  const p = opts.progress
  if (opts.pipelineHeld) return 'The pipeline is held. Nothing new will start until you release it.'
  if (opts.paused) return `Frozen on ${who}. Resume to continue.`
  if (opts.acrossRunning || opts.genState === 'phase2_running') return `Looking across ${p?.phase1.published ?? opts.total ?? 0} verdicts for patterns and a fix plan.`
  if (opts.genState === 'finalizing') return 'Sealing the across-evals view onto each archive.'
  if (p?.stage === 'phase1') {
    const c = p.phase1.cases.find((x) => x.active)
    if (c?.active) return `The judge is on ${PHASE1_NODE_LABELS[c.active].toLowerCase()} for ${who}.`
    return `${p.phase1.published} of ${p.phase1.total} verdicts are in. ${p.phase1.pending} waiting.`
  }
  if (opts.genState === 'completed') return 'This start finished. Each archive was resealed as it moved through evals, Phase 1, and Phase 2.'
  if (opts.genState === 'failed') return 'This start failed. Open the eval row for the error.'
  if (p?.stage === 'evals' || opts.live || opts.genState === 'eval_running') {
    if (p && p.evals.total > 0) {
      const n = p.evals.currentOrdinal != null ? ` · ${p.evals.currentOrdinal} of ${p.evals.total}` : ''
      return `The agent is working on ${who}${n}. ${p.evals.done} completed, ${Math.max(0, p.evals.left - p.evals.running)} waiting.`
    }
    const n = opts.index != null && opts.total ? ` · ${opts.index} of ${opts.total}` : ''
    return `The agent is working on ${who}${n}.`
  }
  if (opts.genState) return `Generation is ${opts.genState.replace(/_/g, ' ')}.`
  return 'Nothing is running. Start from the queue.'
}

function phaseLabel(active: PhaseKey | null): string {
  if (active === 'evals') return 'Evals'
  if (active === 'judge') return 'Phase 1'
  if (active === 'across') return 'Phase 2'
  return 'Idle'
}

function archiveLayer(state?: string): string {
  if (!state) return '—'
  if (['final_view_published', 'phase2_attached'].includes(state)) return 'phase2/'
  if (['phase1_published', 'phase1_running'].includes(state)) return state === 'phase1_published' ? 'judge/' : 'base → judge/'
  if (state === 'archive_sealed' || state === 'phase1_pending') return 'base'
  if (state === 'eval_running') return 'writing'
  return '—'
}

/**
 * Live run panel. First read is what is happening now. Then which phase,
 * then the current eval, then the event tail, then every eval in the run.
 */
export default function EvalLive() {
  const { id, generationId: routeGenerationId } = useParams()
  const qc = useQueryClient()
  const [pinnedRun, setPinnedRun] = useState<string | null>(null)
  const [nameDraft, setNameDraft] = useState('')
  const [feed, setFeed] = useState<FeedEvent[]>([])
  const [feedError, setFeedError] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ tone: 'danger' | 'ok'; text: string } | null>(null)
  const [activityFilter, setActivityFilter] = useState<ActivityStage | 'all'>('all')
  const [tick, setTick] = useState(0)
  const feedEnd = useRef<HTMLDivElement | null>(null)

  const q = useQuery({
    queryKey: ['queue', id],
    queryFn: () => api.get<QueueView>(`/api/projects/${id}/queue`),
    refetchInterval: 2000,
  })
  const pipeline = useQuery({
    queryKey: ['pipeline', id],
    queryFn: () => api.get<PipelineView>(`/api/projects/${id}/pipeline`),
    refetchInterval: 2000,
  })
  const evals = useQuery({
    queryKey: ['evals', id],
    queryFn: () => api.get<{ evals: EvalTask[] }>(`/api/projects/${id}/evals`),
  })
  const runs = useQuery({
    queryKey: ['runs', id],
    queryFn: () => api.get<{ runs: Run[] }>(`/api/projects/${id}/runs`),
    refetchInterval: 3000,
  })
  const generationId = routeGenerationId ?? pipeline.data?.generation?.id
  const gen = useQuery({
    queryKey: ['generation', id, generationId],
    queryFn: () => api.get<GenerationView>(`/api/projects/${id}/pipeline/generation/${generationId}`),
    enabled: Boolean(generationId),
    refetchInterval: 2000,
  })
  const progress = useQuery({
    queryKey: ['progress', id, generationId],
    queryFn: () => api.get<StageProgress>(`/api/projects/${id}/pipeline/generation/${generationId}/progress`),
    enabled: Boolean(generationId),
    refetchInterval: 2000,
    retry: false,
  })
  const archives = useQuery({
    queryKey: ['generation-archives', id, generationId],
    queryFn: () => api.get<{ archives: ArchiveRow[] }>(`/api/projects/${id}/archives?pipeline_run_id=${generationId}`),
    enabled: Boolean(generationId),
    refetchInterval: 3000,
  })
  const campaignId = gen.data?.campaign?.id
  const campaign = useQuery({
    queryKey: ['campaign', id, campaignId],
    queryFn: () => api.get<CampaignView>(`/api/projects/${id}/pipeline/campaign/${campaignId}`),
    enabled: Boolean(campaignId),
    refetchInterval: 3000,
  })

  const activity = useQuery({
    queryKey: ['activity', id, generationId],
    queryFn: () => api.get<{ entries: ActivityEntry[] }>(`/api/projects/${id}/pipeline/generation/${generationId}/activity?limit=300`),
    enabled: Boolean(generationId),
    refetchInterval: 2500,
    retry: false,
  })

  const live = Boolean(q.data?.live)
  const paused = Boolean(q.data?.paused)
  const ownsLiveQueue = !routeGenerationId || pipeline.data?.generation?.id === generationId
  const runLive = ownsLiveQueue && live
  const runPaused = ownsLiveQueue && paused
  const pipelineHeld = ownsLiveQueue && pipeline.data?.queue?.status === 'paused'
  const items = useMemo(() => gen.data?.items ?? [], [gen.data?.items])
  const store = useMemo(() => evals.data?.evals ?? [], [evals.data?.evals])
  const nameOf = useCallback((evalId?: string | null) => store.find((t) => t.id === evalId)?.name ?? evalId ?? '—', [store])
  const currentRunId = pinnedRun
    ?? (routeGenerationId ? null : q.data?.current_run_id)
    ?? items.find((it) => it.state?.endsWith('_running') && it.runId)?.runId
    ?? items.find((it) => it.runId)?.runId
    ?? null
  const currentItem = items.find((it) => it.runId === currentRunId) ?? items.find((it) => it.state?.endsWith('_running'))
  const prog = progress.data
  const acrossRunning = Boolean(prog?.phase2.running) || Boolean(campaign.data?.pi?.running) || gen.data?.campaign?.state === 'analyzing' || pipeline.data?.generation?.state === 'phase2_running'
  const active = stageOf(prog, runLive, runPaused, acrossRunning)
  const currentIndex = currentItem ? items.findIndex((it) => it.id === currentItem.id) + 1 : undefined
  const currentRun = (runs.data?.runs ?? []).find((r) => r.id === currentRunId)

  useEffect(() => {
    setNameDraft(gen.data?.generation.name ?? '')
  }, [gen.data?.generation.name])

  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])
  void tick

  const phase1 = useQuery({
    queryKey: ['phase1', currentRunId],
    queryFn: () => api.get<{ status?: string; result_version?: unknown; accepted?: boolean }>(`/api/judge/runs/${currentRunId}/phase1`),
    enabled: Boolean(currentRunId && (currentItem?.state === 'phase1_running' || active === 'judge')),
    refetchInterval: 3000,
    retry: false,
  })

  useEffect(() => {
    if (!currentRunId) {
      setFeed([])
      setFeedError(null)
      return
    }
    setFeed([])
    setFeedError(null)
    const src = new EventSource(`/api/runs/${currentRunId}/events`)
    // A finished run's stream ends after replay, and EventSource then reconnects
    // on its own and replays the whole history again — every line in the feed
    // appeared twice. Events carry a run-scoped seq, so drop anything we already
    // hold rather than trusting the connection to happen only once.
    let highestSeq = -1
    src.onmessage = (e) => {
      try {
        const obj = JSON.parse(e.data) as FeedEvent
        if (typeof obj.seq === 'number') {
          if (obj.seq <= highestSeq) return
          highestSeq = obj.seq
        }
        setFeed((prev) => [...prev.slice(-400), obj])
      } catch {
        setFeed((prev) => [...prev.slice(-400), { type: 'log', text: e.data }])
      }
    }
    // The server sends this when the run is terminal and no more events exist.
    // Close deliberately so EventSource does not reconnect and replay.
    src.addEventListener('end', () => src.close())
    src.onerror = () => {
      if (src.readyState === EventSource.CLOSED) return
      setFeedError('event stream ended or unavailable')
    }
    return () => src.close()
  }, [currentRunId])

  // Follow the newest line by scrolling the list itself. scrollIntoView would drag
  // the whole page down and yank the reader away from the stage cards above.
  useEffect(() => {
    const box = feedEnd.current?.parentElement
    if (!box) return
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120
    if (atBottom || box.scrollTop === 0) box.scrollTop = box.scrollHeight
  }, [feed.length, activity.dataUpdatedAt, activityFilter])

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['queue', id] })
    void qc.invalidateQueries({ queryKey: ['pipeline', id] })
    void qc.invalidateQueries({ queryKey: ['generation', id] })
    void qc.invalidateQueries({ queryKey: ['campaign', id] })
    void qc.invalidateQueries({ queryKey: ['runs', id] })
    void qc.invalidateQueries({ queryKey: ['generation-archives', id, generationId] })
  }

  const renameRun = useMutation({
    mutationFn: (name: string | null) =>
      api.patch(`/api/projects/${id}/pipeline/generation/${generationId}`, { name }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['generation', id, generationId] })
      void qc.invalidateQueries({ queryKey: ['pipeline-runs', id] })
      void qc.invalidateQueries({ queryKey: ['generation-archives', id, generationId] })
      setMsg({ tone: 'ok', text: 'Run name saved' })
    },
    onError: (e) => setMsg({ tone: 'danger', text: errText(e) }),
  })
  const retryEval = useMutation({
    mutationFn: (itemId: string) =>
      api.post(`/api/projects/${id}/pipeline/generation/${generationId}/retry-eval`, { item_id: itemId }),
    onSuccess: () => { invalidate(); setMsg({ tone: 'ok', text: 'Eval retry started in this run' }) },
    onError: (e) => setMsg({ tone: 'danger', text: errText(e) }),
  })
  const control = useMutation({
    mutationFn: (action: 'pause' | 'resume' | 'abort') =>
      api.patch(`/api/projects/${id}/queues/${q.data!.queue.id}/container`, { action }),
    onSuccess: () => { invalidate(); setMsg({ tone: 'ok', text: 'Agent container updated' }) },
    onError: (e) => setMsg({ tone: 'danger', text: errText(e) }),
  })
  const pauseJudge = useMutation({
    mutationFn: async () => {
      const judging = items.filter((it) => it.state === 'phase1_running' && it.runId)
      await Promise.all(judging.map((it) => api.post(`/api/projects/${id}/runs/${it.runId}/phase1/pause`)))
      if (judging.length === 0) throw new Error('nothing is judging yet')
    },
    onSuccess: () => { invalidate(); setMsg({ tone: 'ok', text: 'Judge paused. Resume continues the PI session.' }) },
    onError: (e) => setMsg({ tone: 'danger', text: errText(e) }),
  })
  const resumeJudge = useMutation({
    mutationFn: async () => {
      const targets = items.filter((it) => it.runId && (it.state === 'phase1_running' || it.state === 'phase1_pending'))
      await Promise.all(targets.map((it) => api.post(`/api/judge/runs/${it.runId}/phase1`)))
      if (targets.length === 0) throw new Error('nothing to resume')
    },
    onSuccess: () => { invalidate(); setMsg({ tone: 'ok', text: 'Judge resumed from its last checkpoint' }) },
    onError: (e) => setMsg({ tone: 'danger', text: errText(e) }),
  })
  const pauseAcross = useMutation({
    mutationFn: () => {
      if (!campaignId) throw new Error('no across-evals campaign is running')
      return api.post(`/api/projects/${id}/pipeline/campaign/${campaignId}/pause`)
    },
    onSuccess: () => { invalidate(); setMsg({ tone: 'ok', text: 'Across-evals pass paused' }) },
    onError: (e) => setMsg({ tone: 'danger', text: errText(e) }),
  })
  const resumeAcross = useMutation({
    mutationFn: () => {
      if (!campaignId) throw new Error('no across-evals campaign to resume')
      return api.post(`/api/projects/${id}/pipeline/campaign/${campaignId}/resume`)
    },
    onSuccess: () => { invalidate(); setMsg({ tone: 'ok', text: 'Across-evals pass resumed' }) },
    onError: (e) => setMsg({ tone: 'danger', text: errText(e) }),
  })

  // The API reports every stage from durable artifacts, but the live agent's own
  // turns only exist in its SSE stream, so fold those in as eval-stage lines.
  const merged = useMemo(() => {
    const api = activity.data?.entries ?? []
    const evalName = nameOf(currentItem?.evalId)
    const fromFeed: ActivityEntry[] = feed
      .filter((ev) => FEED_WORTH_SHOWING.has(ev.type ?? ''))
      .map((ev) => {
        const line = eventLine(ev)
        return {
          ts: ev.ts ?? new Date().toISOString(),
          stage: 'evals' as const,
          node: null,
          kind: line.kind,
          text: line.text,
          detail: null,
          evalName,
          evalId: currentItem?.evalId ?? null,
          runId: currentRunId,
          tone: line.cls === 'error' ? ('warn' as const) : ('info' as const),
        }
      })
    return [...api, ...fromFeed].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0)).slice(-400)
  }, [activity.data, feed, currentItem?.evalId, currentRunId, nameOf])

  const stageCounts = useMemo(() => {
    const c: Record<ActivityStage, number> = { evals: 0, phase1: 0, phase2: 0 }
    for (const e of merged) c[e.stage] += 1
    return c
  }, [merged])

  const shown = activityFilter === 'all' ? merged : merged.filter((e) => e.stage === activityFilter)

  const evalCounts = useMemo(() => {
    const total = items.length
    const running = items.filter((it) => it.state === 'eval_running').length
    const sealed = items.filter((it) => ['archive_sealed', 'phase1_pending', 'phase1_running', 'phase1_published', 'phase2_attached', 'final_view_published'].includes(it.state ?? '')).length
    const judged = items.filter((it) => ['phase1_published', 'phase2_attached', 'final_view_published'].includes(it.state ?? '')).length
    const judging = items.filter((it) => it.state === 'phase1_running').length
    const failed = items.filter((it) => it.state === 'failed').length
    return { total, running, sealed, judged, judging, failed }
  }, [items])

  const evalsDone = prog ? prog.evals.total > 0 && prog.evals.done === prog.evals.total : evalCounts.total > 0 && evalCounts.sealed === evalCounts.total
  const phase1Done = prog ? prog.phase1.total > 0 && prog.phase1.published === prog.phase1.total : evalCounts.total > 0 && evalCounts.judged === evalCounts.total

  const sentence = nowCopy({
    live: runLive,
    paused: runPaused,
    pipelineHeld,
    genState: gen.data?.generation.state ?? pipeline.data?.generation?.state,
    evalName: nameOf(currentItem?.evalId),
    index: currentIndex,
    total: items.length || undefined,
    acrossRunning,
    ...(prog ? { progress: prog } : {}),
  })

  const lastEvent = feed.at(-1)
  const lastLine = lastEvent ? eventLine(lastEvent) : null
  const busy = retryEval.isPending || control.isPending || pauseJudge.isPending || resumeJudge.isPending || pauseAcross.isPending || resumeAcross.isPending
  const runRows = runs.data?.runs ?? []
  const generationLabel = gen.data?.generation.name || `Run ${gen.data?.generation.ordinal ?? pipeline.data?.generation?.ordinal ?? ''}`
  // The badge says whether the run is moving. The chip beside it names the stage,
  // so repeating a raw state like eval_running here says the same thing twice and
  // contradicts the chip whenever the generation row trails the items.
  const genState = gen.data?.generation.state ?? pipeline.data?.generation?.state ?? null
  const TERMINAL = ['completed', 'failed', 'cancelled', 'paused']
  const statusWord = runPaused
    ? 'paused'
    : genState && TERMINAL.includes(genState)
      ? genState
      : genState
        ? 'running'
        : runLive ? 'running' : 'idle'

  return (
    <>
      <PageHead
        title={generationLabel.trim() || 'Run panel'}
        sub={<span>Run panel · <Mono>{generationId ?? 'not started'}</Mono></span>}
        actions={<>
          <Link to={`/projects/${id}`}><button>Project</button></Link>
          <Link to={`/projects/${id}/queue`}><button>{generationId ? 'Queue blueprint' : 'Set up run'}</button></Link>
        </>}
      />
      {generationId && (
        <form
          className="run-name-bar"
          onSubmit={(event) => {
            event.preventDefault()
            renameRun.mutate(nameDraft.trim() || null)
          }}
        >
          <label htmlFor="run-panel-name">Run name</label>
          <input id="run-panel-name" maxLength={120} value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} placeholder={`Run ${gen.data?.generation.ordinal ?? ''}`} />
          <button type="submit" disabled={renameRun.isPending || nameDraft.trim() === (gen.data?.generation.name ?? '')}>{renameRun.isPending ? 'Saving…' : 'Save name'}</button>
        </form>
      )}
      {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}
      {q.isError && <Banner tone="danger">{errText(q.error)}</Banner>}

      <section className="now-hero">
        <div className="now-hero-top">
          <StateBadge state={statusWord} />
          <span className="chip accent">{phaseLabel(active)}</span>
          {currentItem && <span className="chip">{nameOf(currentItem.evalId)}</span>}
          {lastEvent?.ts && <span className="hint">feed {ago(lastEvent.ts)}</span>}
        </div>
        <p className="now-line">{sentence}</p>
        {lastLine && (
          <p className="now-last">
            Last: <span className="mono">{lastLine.kind}</span> {lastLine.text}
          </p>
        )}
        <div className="badge-row">
          <span className="chip">agent <Mono>{q.data?.queue.agentId ?? q.data?.queue.builtinAdapterId ?? '—'}</Mono></span>
          <span className="chip">model <Mono>{q.data?.queue.model ?? '—'}</Mono></span>
          {currentRunId && <Link to={`/runs/${currentRunId}`}><span className="chip">run <Mono>{currentRunId}</Mono></span></Link>}
          {currentItem && <span className="chip">archive {archiveLayer(currentItem.state)}</span>}
          {currentRun?.officialReward != null && <span className="chip">reward {currentRun.officialReward}</span>}
        </div>
        <div className="now-actions">
          {active === 'evals' && runLive && (
            <>
              <button onClick={() => control.mutate('pause')} disabled={runPaused || busy}>Pause agent</button>
              <button onClick={() => control.mutate('resume')} disabled={!runPaused || busy}>Resume agent</button>
              <button onClick={() => control.mutate('abort')} disabled={busy}>Abort this eval</button>
            </>
          )}
          {active === 'judge' && currentRunId && (
            <>
              <button onClick={() => pauseJudge.mutate()} disabled={busy}>Pause judge</button>
              <button onClick={() => resumeJudge.mutate()} disabled={busy}>Resume judge</button>
            </>
          )}
          {active === 'across' && campaignId && (
            <>
              <button onClick={() => pauseAcross.mutate()} disabled={busy}>Pause across</button>
              <button onClick={() => resumeAcross.mutate()} disabled={busy}>Resume across</button>
            </>
          )}
        </div>
      </section>

      <div className="phase-rail">
        <div className={`phase-step${active === 'evals' ? ' active' : ''}${evalsDone ? ' done' : ''}${runPaused ? ' paused' : ''}`}>
          <div className="n">1 · Evals</div>
          <h3>Run the agent</h3>
          <div className="meter"><i style={{ width: `${pct(prog?.evals.done ?? evalCounts.sealed, prog?.evals.total ?? evalCounts.total)}%` }} /></div>
          <p>{evalStageLine(prog, evalCounts.total)}</p>
          {prog?.evals.currentOrdinal != null && (
            <p className="hint">On eval {prog.evals.currentOrdinal} of {prog.evals.total}</p>
          )}
        </div>

        <div className={`phase-step${active === 'judge' ? ' active' : ''}${phase1Done ? ' done' : ''}`}>
          <div className="n">2 · Phase 1</div>
          <h3>Judge each eval</h3>
          <div className="meter"><i style={{ width: `${pct(prog?.phase1.published ?? evalCounts.judged, prog?.phase1.total ?? evalCounts.total)}%` }} /></div>
          <p>
            {(prog?.phase1.total ?? evalCounts.total) === 0
              ? 'Waits for a sealed archive.'
              : `${prog?.phase1.published ?? evalCounts.judged} of ${prog?.phase1.total ?? evalCounts.total} verdicts${(prog?.phase1.running ?? evalCounts.judging) ? ` · ${prog?.phase1.running ?? evalCounts.judging} in session` : ''}`}
          </p>
          {prog && prog.phase1.cases.length > 0 && (
            <ul className="lines">
              {prog.phase1.cases.slice(0, 3).map((c) => (
                <li key={c.itemId} className={c.published ? 'ok' : c.active ? 'on' : ''}>
                  <span className="dot" />
                  {nameOf(c.evalId)}
                  <span className="tail">
                    {c.published ? 'published'
                      : c.active ? `${c.active} · ${c.done.length}/5`
                        : c.done.length ? `paused at ${c.done.length}/5` : 'waiting'}
                  </span>
                </li>
              ))}
              {prog.phase1.cases.length > 3 && (
                <li className="more">+{prog.phase1.cases.length - 3} more below</li>
              )}
            </ul>
          )}
        </div>

        <div className={`phase-step${active === 'across' ? ' active' : ''}${gen.data?.generation.state === 'completed' ? ' done' : ''}`}>
          <div className="n">3 · Phase 2</div>
          <h3>Look across evals</h3>
          <div className="meter"><i style={{ width: `${pct(prog?.phase2.resealed ?? 0, prog?.phase2.members || prog?.evals.total || 0)}%` }} /></div>
          <p>
            {prog?.phase2.running
              ? `Board running${campaign.data?.pi?.subagents?.length ? ` · ${campaign.data.pi.subagents.length} seats` : ''}`
              : prog?.phase2.stalled
                ? 'Board stopped mid-pass'
                : prog?.phase2.campaignState ?? gen.data?.campaign?.state ?? (pipeline.data?.queue?.autoPhase2 ? 'Armed for this run' : 'Not part of this run')}
          </p>
          {prog?.phase2.stalled && (
            <p className="hint warn">
              The board process is gone. Its session is saved, so Resume across picks up where it stopped.
            </p>
          )}
          {prog?.phase2.started && (
            <p className="hint">{prog.phase2.resealed} of {prog.phase2.members || prog.evals.total} archives resealed with phase2/</p>
          )}
        </div>
      </div>

      <div className="run-split">
        <Panel
          title="What's happening"
          actions={
            <div className="tabs slim">
              {STAGE_FILTERS.map((f) => (
                <button
                  key={f.key}
                  role="tab"
                  aria-selected={activityFilter === f.key}
                  className={activityFilter === f.key ? 'active' : ''}
                  onClick={() => setActivityFilter(f.key)}
                >
                  {f.label}
                  {f.key !== 'all' && <span className="tab-count">{stageCounts[f.key as ActivityStage]}</span>}
                </button>
              ))}
            </div>
          }
        >
          {activity.isError && merged.length === 0 && <Banner tone="warn">Cannot read run activity: {errText(activity.error)}</Banner>}
          {feedError && runLive && <Banner tone="warn">The live agent stream dropped: {feedError}. Stage activity below still updates.</Banner>}
          {!generationId && <Empty title="No run to follow">Start a run from the queue and every stage reports here.</Empty>}
          {generationId && merged.length === 0 && !activity.isError && (
            <Spinner label="Waiting for the first thing to happen…" />
          )}
          {shown.length === 0 && merged.length > 0 && (
            <Empty title="Nothing in this stage yet">
              {activityFilter === 'phase1'
                ? 'The courtroom starts once an eval seals its archive.'
                : activityFilter === 'phase2'
                  ? 'The across-evals board starts once every verdict is in.'
                  : 'No agent activity recorded for this stage.'}
            </Empty>
          )}
          {shown.length > 0 && (
            <div className="activity">
              {shown.map((e, i) => (
                <div className={`act ${e.tone}`} key={`${e.ts}-${i}`}>
                  <span className="ts">{clock(e.ts)}</span>
                  <span className={`lane ${e.stage}`}>{STAGE_SHORT[e.stage]}</span>
                  <span className={`kind ${e.kind}`}>{e.node ?? e.kind}</span>
                  <span className="what">
                    {e.evalName && <span className="who">{e.evalName}</span>}
                    {e.text}
                    {e.detail && <em className="detail">{e.detail}</em>}
                  </span>
                </div>
              ))}
              <div ref={feedEnd} />
            </div>
          )}
          {phase1.data?.status && <p className="hint" style={{ marginTop: 'var(--s3)' }}>Judge status: {phase1.data.status}</p>}
        </Panel>

        <Panel title="Evals in this run">
          {items.length === 0 && (
            <Empty title={generationId ? 'Waiting for the first claim' : 'This run has not started'}>
              {generationId
                ? 'The generation exists. The agent has not claimed an eval yet.'
                : <Link to={`/projects/${id}/queue`}><button className="primary">Open queue</button></Link>}
            </Empty>
          )}
          {items.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Eval</th>
                  <th>Phase</th>
                  <th>Archive</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {items.map((it) => {
                  const selected = it.runId && it.runId === currentRunId
                  return (
                    <tr
                      key={it.id}
                      onClick={() => { if (it.runId) setPinnedRun(it.runId) }}
                      style={{ cursor: it.runId ? 'pointer' : undefined, background: selected ? 'var(--surface-2)' : undefined }}
                    >
                      <td className="num">{it.ordinal ?? ''}</td>
                      <td style={{ color: 'var(--text)' }}>
                        {nameOf(it.evalId)}
                        <div className="hint">{happening(it)}</div>
                      </td>
                      <td><StateBadge state={it.state} /></td>
                      <td><span className="chip">{archiveLayer(it.state)}</span></td>
                      <td>
                        {it.state === 'failed' && it.errorKind === 'eval' && (
                          <button
                            type="button"
                            disabled={busy}
                            title={it.errorDetail ?? 'Retry this eval'}
                            onClick={(event) => { event.stopPropagation(); retryEval.mutate(it.id) }}
                          >
                            {retryEval.isPending ? 'Starting…' : 'Retry eval'}
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </Panel>
      </div>

      {active === 'judge' && prog && prog.phase1.cases.length > 0 && (
        <Panel title="Phase 1 · live node progress">
          <div className="node-ladder">
            {prog.phase1.cases.map((c) => (
              <div className="node-case" key={c.itemId}>
                <header>
                  <span className="name">{nameOf(c.evalId)}</span>
                  <StateBadge state={c.published ? 'published' : c.active ? 'running' : 'pending'} />
                  {c.round != null && <span className="chip">round {c.round}</span>}
                  {c.judgeFiles.length > 0 && <span className="chip">{c.judgeFiles.length} judge files</span>}
                </header>
                <div className="node-steps">
                  {PHASE1_NODES.map((n) => (
                    <div key={n} className={`node${c.done.includes(n) ? ' done' : ''}${c.active === n ? ' on' : ''}`}>
                      <span className="k">{n}</span>
                      {PHASE1_NODE_LABELS[n]}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Panel>
      )}

      {prog?.phase2.started && (
        <Panel title="Phase 2 · campaign artifact">
          <p className="hint">
            {prog.phase2.running
              ? 'The board is running.'
              : prog.phase2.stalled
                ? 'The board stopped mid-pass. Resume across continues its saved session.'
                : `Campaign is ${prog.phase2.campaignState ?? 'idle'}.`}
            {' '}Each member archive is resealed with a phase2/ layer when the campaign attaches its findings.
          </p>
          <div className="badge-row">
            <span className="chip">{prog.phase2.resealed} of {prog.phase2.members || prog.evals.total} resealed</span>
            {prog.phase2.developerPack && <span className="chip accent">developer-improvement-pack.zip</span>}
            {prog.phase2.developerPack && campaignId && (
              <button onClick={() => download(`/api/projects/${id}/pipeline/campaign/${campaignId}/pack`)}>
                Download developer pack
              </button>
            )}
          </div>
          {prog.phase2.artifacts.length > 0 && (
            <table style={{ marginTop: 'var(--s3)' }}>
              <thead><tr><th>Artifact</th></tr></thead>
              <tbody>
                {prog.phase2.artifacts.map((f) => (
                  <tr key={f}><td><Mono>{f}</Mono></td></tr>
                ))}
              </tbody>
            </table>
          )}
          {prog.phase2.artifacts.length === 0 && <p className="hint">No artifact written yet.</p>}
        </Panel>
      )}

      <Panel
        title={`Archives in this run (${archives.data?.archives.length ?? 0})`}
        actions={<Link to={`/archives?pipeline_run_id=${generationId ?? ''}`}><button>Open archive catalog</button></Link>}
      >
        {archives.isLoading && <Spinner label="Loading archives…" />}
        {archives.isError && <Banner tone="danger">Cannot load run archives: {errText(archives.error)}</Banner>}
        {!archives.isLoading && (archives.data?.archives.length ?? 0) === 0 && (
          <Empty title="No sealed archives yet">Each eval appears here after its base evidence seals. The same archive gains judge/ after Phase 1 and phase2/ after Phase 2.</Empty>
        )}
        {(archives.data?.archives.length ?? 0) > 0 && (
          <div className="archive-cards">
            {archives.data!.archives.map((archive) => (
              <Link className="archive-card" to={`/archives/${archive.runId}`} key={archive.runId}>
                <div>
                  <strong>{archive.taskName || archive.runId}</strong>
                  <span className="hint"><Mono>{archive.runId}</Mono></span>
                </div>
                <span className={`chip ${archive.phase.sealed === 'phase2' ? 'phase2' : archive.phase.sealed === 'phase1' ? 'phase1' : ''}`}>
                  {archive.phase.sealed === 'base' ? 'base' : `${archive.phase.sealed}/`}
                </span>
                <StateBadge state={archive.status} />
                <span className="archive-card-open">View files</span>
              </Link>
            ))}
          </div>
        )}
      </Panel>


      {runRows.length > 0 && items.length === 0 && (
        <Panel title={`Earlier runs (${runRows.length})`}>
          <table>
            <thead><tr><th>Run</th><th>Eval</th><th>Status</th><th>Reward</th></tr></thead>
            <tbody>
              {runRows.slice().reverse().slice(0, 20).map((r) => (
                <tr key={r.id} onClick={() => setPinnedRun(r.id)} style={{ cursor: 'pointer' }}>
                  <td><Link to={`/runs/${r.id}`}><Mono copy>{r.id}</Mono></Link></td>
                  <td>{nameOf(r.taskId)}</td>
                  <td><StateBadge state={r.status} /></td>
                  <td className="num">{r.officialReward ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
    </>
  )
}
