import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, errText } from '../lib/api'
import type { Campaign, EvalQueue, EvalTask, PipelineItem, PipelineQueue, QueueItem } from '../lib/types'
import { Banner, CategoryChip, Empty, Mono, PageHead, Panel, Spinner, StateBadge } from '../components/ui'

interface QueueView {
  queue: EvalQueue
  items: QueueItem[]
  container: { id?: string; state?: string } | null
  current_run_id?: string | null
  live?: boolean
  paused?: boolean
}

interface PipelineView {
  queue: PipelineQueue | null
  generation: { id: string; state?: string; ordinal?: number; name?: string | null } | null
}

interface GenerationView {
  generation: { id: string; state?: string; ordinal?: number; name?: string | null }
  items: PipelineItem[]
  campaign: Campaign | null
}

interface JudgeQueueView {
  queue: { id: string; status?: string; name?: string } | null
  status: { status?: string | null; byState?: Record<string, number> } | null
}

interface CampaignView {
  campaign: Campaign
  pi?: { running?: boolean; resumable?: boolean }
}

/**
 * One project, one queue. Evals live in the store. You tick the ones to run,
 * tick which parts of the flow to run, then start. That start is a run:
 * one container, its own archives, a live view.
 */
export default function Queue() {
  const { id } = useParams()
  const nav = useNavigate()
  const qc = useQueryClient()
  const [msg, setMsg] = useState<{ tone: 'danger' | 'ok'; text: string } | null>(null)
  const [runName, setRunName] = useState('')
  const [stages, setStages] = useState({ evals: true, judge: true, across: false })

  const q = useQuery({
    queryKey: ['queue', id],
    queryFn: () => api.get<QueueView>(`/api/projects/${id}/queue`),
    refetchInterval: (query) => (query.state.data?.live || query.state.data?.paused ? 3000 : false),
  })
  const evals = useQuery({
    queryKey: ['evals', id],
    queryFn: () => api.get<{ evals: EvalTask[] }>(`/api/projects/${id}/evals`),
  })
  const pipeline = useQuery({
    queryKey: ['pipeline', id],
    queryFn: () => api.get<PipelineView>(`/api/projects/${id}/pipeline`),
    enabled: Boolean(q.data?.queue.id),
    refetchInterval: 4000,
  })
  const generationId = pipeline.data?.generation?.id
  const gen = useQuery({
    queryKey: ['generation', id, generationId],
    queryFn: () => api.get<GenerationView>(`/api/projects/${id}/pipeline/generation/${generationId}`),
    enabled: Boolean(generationId),
    refetchInterval: 4000,
  })
  // Per-case pause state. A single paused case never changes the judge queue's
  // status, so without this the row keeps reading "judging" and still offers a
  // Pause button after the graph has already halted.
  const progress = useQuery({
    queryKey: ['progress', id, generationId],
    queryFn: () => api.get<{ phase1: { cases: { runId: string; paused: boolean }[] } }>(
      `/api/projects/${id}/pipeline/generation/${generationId}/progress`,
    ),
    enabled: Boolean(generationId),
    refetchInterval: 4000,
    retry: false,
  })
  const builtins = useQuery({
    queryKey: ['builtin-adapters'],
    queryFn: () => api.get<{ adapters: string[] }>('/api/adapters/builtin'),
  })
  const judgeQ = useQuery({
    queryKey: ['judge-queue', id],
    queryFn: () => api.get<JudgeQueueView>(`/api/projects/${id}/judge-queue`),
    enabled: Boolean(q.data?.queue.id),
    refetchInterval: 4000,
  })
  const campaignId = gen.data?.campaign?.id
  const campaign = useQuery({
    queryKey: ['campaign', id, campaignId],
    queryFn: () => api.get<CampaignView>(`/api/projects/${id}/pipeline/campaign/${campaignId}`),
    enabled: Boolean(campaignId),
    refetchInterval: 4000,
  })

  useEffect(() => {
    const p = pipeline.data?.queue
    if (!p) return
    setStages({
      evals: p.autoEval !== false,
      judge: p.autoPhase1 !== false,
      across: Boolean(p.autoPhase2) && p.autoPhase1 !== false,
    })
  }, [pipeline.data?.queue])

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['queue', id] })
    void qc.invalidateQueries({ queryKey: ['pipeline', id] })
    void qc.invalidateQueries({ queryKey: ['evals', id] })
    void qc.invalidateQueries({ queryKey: ['generation', id] })
    void qc.invalidateQueries({ queryKey: ['judge-queue', id] })
    void qc.invalidateQueries({ queryKey: ['campaign', id] })
  }

  const addItem = useMutation({
    mutationFn: (taskId: string) => api.post(`/api/projects/${id}/queues/${q.data!.queue.id}/items`, { eval_id: taskId }),
    onSuccess: () => { invalidate(); setMsg({ tone: 'ok', text: 'Eval added to the queue' }) },
    onError: (e) => setMsg({ tone: 'danger', text: errText(e) }),
  })
  const addAll = useMutation({
    mutationFn: async (taskIds: string[]) => {
      // Sequential, because position is assigned server-side from the current
      // item count. Parallel posts race and collapse onto the same position.
      for (const taskId of taskIds) {
        await api.post(`/api/projects/${id}/queues/${q.data!.queue.id}/items`, { eval_id: taskId })
      }
      return taskIds.length
    },
    onSuccess: (n) => { invalidate(); setMsg({ tone: 'ok', text: `${n} eval${n === 1 ? '' : 's'} added to the queue` }) },
    onError: (e) => setMsg({ tone: 'danger', text: errText(e) }),
  })
  const toggleItem = useMutation({
    mutationFn: ({ itemId, enabled }: { itemId: string; enabled: boolean }) =>
      api.patch(`/api/projects/${id}/queues/${q.data!.queue.id}/items/${itemId}`, { enabled }),
    onSuccess: invalidate,
    onError: (e) => setMsg({ tone: 'danger', text: errText(e) }),
  })
  const removeItem = useMutation({
    mutationFn: (itemId: string) => api.del(`/api/projects/${id}/queues/${q.data!.queue.id}/items/${itemId}`),
    onSuccess: invalidate,
    onError: (e) => setMsg({ tone: 'danger', text: errText(e) }),
  })
  const setBuiltin = useMutation({
    mutationFn: (builtin: string) =>
      api.patch(`/api/projects/${id}/queues/${q.data!.queue.id}`, { builtin_adapter_id: builtin }),
    onSuccess: () => { invalidate(); setMsg({ tone: 'ok', text: 'Built-in agent changed for this queue' }) },
    onError: (e) => setMsg({ tone: 'danger', text: errText(e) }),
  })
  const saveStages = useMutation({
    mutationFn: (next: typeof stages) =>
      api.patch(`/api/projects/${id}/pipeline`, {
        auto_eval: next.evals,
        auto_phase1: next.judge,
        auto_phase2: next.across,
      }),
    onSuccess: invalidate,
    onError: (e) => setMsg({ tone: 'danger', text: errText(e) }),
  })
  const start = useMutation({
    mutationFn: async () => {
      await api.patch(`/api/projects/${id}/pipeline`, {
        auto_eval: stages.evals,
        auto_phase1: stages.judge,
        auto_phase2: stages.across,
      })
      // Generation first: it bumps repeats so the eval queue will claim again,
      // and pollEvalItem ignores runs that finished before this createdAt.
      // Container second: otherwise evals can finish (or find nothing to claim)
      // before the generation exists, and the live panel has no run to show.
      const generation = await api.post<{ id: string }>(`/api/projects/${id}/pipeline/generation`, {
        name: runName.trim() || undefined,
      })
      try {
        await api.put(`/api/projects/${id}/queues/${q.data!.queue.id}/container`, {})
      } catch (e) {
        // Ticker may have started the container between the two calls.
        const status = (e as { status?: number }).status
        if (status !== 409) throw e
      }
      return generation
    },
    onSuccess: (generation) => { invalidate(); nav(`/projects/${id}/runs/${generation.id}`) },
    onError: (e) => setMsg({ tone: 'danger', text: errText(e) }),
  })
  const control = useMutation({
    mutationFn: (action: 'pause' | 'resume' | 'abort') =>
      api.patch(`/api/projects/${id}/queues/${q.data!.queue.id}/container`, { action }),
    onSuccess: () => { invalidate(); setMsg({ tone: 'ok', text: 'Agent container updated' }) },
    onError: (e) => setMsg({ tone: 'danger', text: errText(e) }),
  })
  const holdPipeline = useMutation({
    mutationFn: (status: 'paused' | 'running') => api.patch(`/api/projects/${id}/pipeline`, { status }),
    onSuccess: () => { invalidate(); setMsg({ tone: 'ok', text: 'Pipeline hold updated' }) },
    onError: (e) => setMsg({ tone: 'danger', text: errText(e) }),
  })
  const pauseJudge = useMutation({
    mutationFn: async () => {
      const judging = (gen.data?.items ?? []).filter((it) => it.state === 'phase1_running' && it.runId)
      await Promise.all(judging.map((it) => api.post(`/api/projects/${id}/runs/${it.runId}/phase1/pause`)))
      const jqid = judgeQ.data?.queue?.id
      if (jqid) await api.post(`/api/judge/queues/${jqid}/pause`, { kind: 'manual' })
      if (judging.length === 0 && !jqid) throw new Error('nothing is judging yet')
    },
    onSuccess: () => { invalidate(); setMsg({ tone: 'ok', text: 'Judge paused. Resume continues the PI session.' }) },
    onError: (e) => setMsg({ tone: 'danger', text: errText(e) }),
  })
  const resumeJudge = useMutation({
    mutationFn: async () => {
      const jqid = judgeQ.data?.queue?.id
      if (jqid) await api.post(`/api/judge/queues/${jqid}/resume`, {})
      const items = gen.data?.items ?? []
      const targets = items.filter((it) => it.runId && (it.state === 'phase1_running' || it.state === 'phase1_pending' || it.state === 'paused'))
      await Promise.all(targets.map((it) => api.post(`/api/judge/runs/${it.runId}/phase1`)))
      if (!jqid && targets.length === 0) throw new Error('nothing to resume')
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

  function setStage(key: 'evals' | 'judge' | 'across', on: boolean) {
    const next = { ...stages, [key]: on }
    if (key === 'judge' && !on) next.across = false
    if (key === 'across' && on) next.judge = true
    setStages(next)
    saveStages.mutate(next)
  }

  const queue = q.data?.queue
  const items = q.data?.items ?? []
  const live = Boolean(q.data?.live)
  const paused = Boolean(q.data?.paused)
  const staleContainer = Boolean(q.data?.container) && !live
  const store = evals.data?.evals ?? []
  const queuedIds = new Set(items.map((it) => it.taskId))
  const available = store.filter((t) => !queuedIds.has(t.id))
  const enabledCount = items.filter((it) => it.enabled !== false).length
  const pipelineHeld = pipeline.data?.queue?.status === 'paused'
  const genItems = gen.data?.items ?? []
  const judgingNow = genItems.some((it) => it.state === 'phase1_running')
  const judgePaused = judgeQ.data?.status?.status === 'paused' || judgeQ.data?.queue?.status === 'paused'
  const pausedRuns = new Set((progress.data?.phase1.cases ?? []).filter((c) => c.paused).map((c) => c.runId))
  const casePaused = (runId: string | null | undefined) => Boolean(runId && pausedRuns.has(runId))
  // A paused board keeps its campaign in `analyzing` on purpose: that is what
  // makes resume continue the same session instead of publishing a half-filed
  // pass. So `analyzing` alone does not mean running — the generation parking in
  // `paused` (operator pause) or `waiting_retry` (attempt budget spent, often on
  // a provider 402/429) is what says the board stopped.
  const genState = gen.data?.generation.state ?? pipeline.data?.generation?.state
  const acrossStopped = genState === 'paused' || genState === 'waiting_retry'
  const acrossRunning =
    Boolean(campaign.data?.pi?.running) ||
    (gen.data?.campaign?.state === 'analyzing' && !acrossStopped)
  // A published, cancelled, or failed campaign is finished; the API answers 409
  // to a resume on one. The button offered it anyway, and clicking it used to
  // relaunch the whole board over already-sealed artifacts.
  const acrossFinished = ['published', 'cancelled', 'failed'].includes(campaign.data?.campaign?.state ?? gen.data?.campaign?.state ?? '')
  const acrossResumable =
    (Boolean(campaign.data?.pi?.resumable) || acrossStopped) &&
    !campaign.data?.pi?.running &&
    !acrossFinished
  const busy = control.isPending || pauseJudge.isPending || resumeJudge.isPending || pauseAcross.isPending || resumeAcross.isPending || holdPipeline.isPending

  // A run is the generation, not the container. Starting the container is only
  // the first half of a start, so a live container with no generation is a
  // half-started queue that still needs Start to be reachable.
  const started = Boolean(generationId)
  // Before a run exists this panel describes the next one, so the previous
  // generation's terminal status must not be shown as if it were its state.
  // A run is the generation, so once one exists its state is the run's state.
  // `queue.status` only describes the eval container, and it reads `completed`
  // the moment the last eval seals. Observed live: "Current run · completed"
  // sitting beside "generation 1 · judging" while the courtroom was mid-session.
  const runState = live
    ? (paused ? 'paused' : 'running')
    : started
      ? (genState ?? queue?.status ?? 'idle')
      : 'not started'

  return (
    <>
      <PageHead
        title="Queue"
        sub="This project's one queue. Tick evals from the store, pick which parts to run, then start. A start is a run: one container, its own archives."
        actions={
          queue ? (
            <div className="badge-row">
              {generationId && (
                <button
                  onClick={() => holdPipeline.mutate(pipelineHeld ? 'running' : 'paused')}
                  disabled={holdPipeline.isPending}
                  title="Stops the pipeline from advancing into the next stage. Does not freeze a live container or PI session."
                >
                  {pipelineHeld ? 'Release pipeline' : 'Hold pipeline'}
                </button>
              )}
              {live && (
                <>
                  <button onClick={() => control.mutate('pause')} disabled={paused || control.isPending}>Pause agent</button>
                  <button title="Resume rereads this project's current settings" onClick={() => control.mutate('resume')} disabled={!paused || control.isPending}>Resume agent</button>
                  <button onClick={() => control.mutate('abort')} disabled={control.isPending}>Abort eval</button>
                </>
              )}
              {!started && (
                <button className="primary" onClick={() => start.mutate()} disabled={start.isPending || enabledCount === 0}>
                  {start.isPending ? 'Starting…' : live ? 'Finish starting run' : 'Start run'}
                </button>
              )}
              <Link to={`/projects/${id}/live`}><button>Run panel</button></Link>
            </div>
          ) : undefined
        }
      />
      {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}
      {q.isError && <Banner tone="danger">{errText(q.error)}</Banner>}
      {staleContainer && (
        <Banner tone="warn">
          The queue still has a container row, but this API process does not own it. Start again after the previous generation is recovered, or wait for boot recovery to clear it.
        </Banner>
      )}
      {q.isLoading && <Spinner label="Loading queue…" />}

      {queue && (
        <Panel
          title={generationId ? 'Current run' : 'Next run'}
          actions={<StateBadge state={runState} />}
        >
          {!generationId && (
            <div className="run-name-row">
              <label htmlFor="run-name">
                <strong>Run name</strong>
                <span className="hint">Optional. A clear name makes archives and history easier to scan.</span>
              </label>
              <input
                id="run-name"
                value={runName}
                maxLength={120}
                onChange={(event) => setRunName(event.target.value)}
                placeholder={`Run ${(pipeline.data?.generation?.ordinal ?? 0) + 1}`}
              />
            </div>
          )}
          {queue.builtinAdapterId && (
            <div className="stage-row" style={{ marginBottom: 'var(--s4)' }}>
              <label style={{ display: 'block' }}>
                <strong>Built-in agent</strong>
                <span className="hint">
                  This project has no adapter of its own, so the queue runs a built-in one.
                  Switching rebuilds the image on the next start.
                </span>
              </label>
              <div className="stage-actions">
                <select
                  value={queue.builtinAdapterId}
                  disabled={live || paused || setBuiltin.isPending}
                  aria-label="Built-in agent"
                  onChange={(e) => setBuiltin.mutate(e.target.value)}
                >
                  {(builtins.data?.adapters ?? [queue.builtinAdapterId]).map((b) => (
                    <option key={b} value={b}>{b}</option>
                  ))}
                </select>
              </div>
            </div>
          )}
          <div className="badge-row" style={{ marginBottom: 'var(--s4)' }}>
            <span className="chip">agent <Mono>{queue.agentId ?? queue.builtinAdapterId ?? '—'}</Mono></span>
            <span className="chip">model <Mono>{queue.model ?? '—'}</Mono></span>
            {queue.agentCommit && <span className="chip">commit <Mono>{queue.agentCommit.slice(0, 12)}</Mono></span>}
            <span className="chip">{enabledCount} eval{enabledCount === 1 ? '' : 's'} selected</span>
            {q.data?.current_run_id && (
              <Link to={`/runs/${q.data.current_run_id}`}><span className="chip">open current run</span></Link>
            )}
            {pipeline.data?.generation && (
              <span className="chip">generation {pipeline.data.generation.ordinal ?? ''} <StateBadge state={pipeline.data.generation.state} /></span>
            )}
          </div>
          <p style={{ color: 'var(--text-dim)', fontSize: 13, marginTop: 0 }}>
            What should this start do? Pause and resume freeze the stage that is actually running, not the checkbox.
          </p>
          <div className="stage-checks">
            <div className="stage-row">
              <label>
                <input type="checkbox" checked={stages.evals} onChange={(e) => setStage('evals', e.target.checked)} />
                <span>
                  <strong>Run the agent</strong>
                  <span className="hint">Work each selected eval in the queue container. Setup and cleanup come from the eval package.</span>
                </span>
              </label>
              <div className="stage-actions">
                {live && (
                  <>
                    <button onClick={() => control.mutate('pause')} disabled={paused || busy}>Pause</button>
                    <button onClick={() => control.mutate('resume')} disabled={!paused || busy}>Resume</button>
                  </>
                )}
              </div>
            </div>
            <div className="stage-row">
              <label>
                <input type="checkbox" checked={stages.judge} onChange={(e) => setStage('judge', e.target.checked)} />
                <span>
                  <strong>Judge each eval</strong>
                  <span className="hint">After an eval seals, the courtroom reads that archive and writes a verdict. Pause stops the PI session; resume continues it.</span>
                </span>
              </label>
              <div className="stage-actions">
                {(judgingNow || judgePaused || judgeQ.data?.queue) && (
                  <>
                    <button onClick={() => pauseJudge.mutate()} disabled={judgePaused || busy}>Pause</button>
                    <button onClick={() => resumeJudge.mutate()} disabled={busy}>Resume</button>
                  </>
                )}
              </div>
            </div>
            <div className={`stage-row${!stages.judge ? ' dim' : ''}`}>
              <label>
                <input
                  type="checkbox"
                  checked={stages.across}
                  disabled={!stages.judge}
                  onChange={(e) => setStage('across', e.target.checked)}
                />
                <span>
                  <strong>Look across evals</strong>
                  <span className="hint">After every selected eval has a verdict, find patterns and a fix plan. Needs the judge.</span>
                </span>
              </label>
              <div className="stage-actions">
                {(acrossRunning || acrossResumable || campaignId) && (
                  <>
                    <button onClick={() => pauseAcross.mutate()} disabled={!acrossRunning || busy}>Pause</button>
                    <button
                      title={acrossFinished ? 'This pass is finished; there is nothing to resume' : undefined}
                      onClick={() => resumeAcross.mutate()}
                      disabled={acrossRunning || acrossFinished || busy}
                    >Resume</button>
                  </>
                )}
              </div>
            </div>
          </div>
        </Panel>
      )}

      {generationId && (
        <Panel
          title="Generation"
          actions={
            <div className="badge-row">
              <StateBadge state={genState} />
              {gen.data?.campaign && <span className="chip phase2">campaign <Mono>{gen.data.campaign.id}</Mono></span>}
            </div>
          }
        >
          {gen.isLoading && <Spinner label="Loading generation…" />}
          {genItems.length === 0 && !gen.isLoading && (
            <p style={{ color: 'var(--text-dim)', fontSize: 13, margin: 0 }}>No items in this generation yet.</p>
          )}
          {genItems.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Eval</th>
                  <th>State</th>
                  <th>Run</th>
                  <th>Judge</th>
                </tr>
              </thead>
              <tbody>
                {genItems.map((it) => {
                  const t = store.find((e) => e.id === it.evalId)
                  return (
                    <tr key={it.id}>
                      <td className="num">{it.ordinal ?? ''}</td>
                      <td style={{ color: 'var(--text)' }}>{t?.name ?? '—'} <Mono copy>{it.evalId}</Mono></td>
                      {/* A judge pause freezes the PI session but leaves the item
                          in `phase1_running`, so the row kept reading "judging"
                          with a live Pause button after the courtroom stopped. */}
                      <td><StateBadge state={it.state === 'phase1_running' && (judgePaused || casePaused(it.runId)) ? 'paused' : it.state} /></td>
                      <td>
                        {it.runId
                          ? <Link to={`/runs/${it.runId}`}><Mono copy>{it.runId}</Mono></Link>
                          : '—'}
                      </td>
                      <td>
                        {it.phase1ResultVersionId
                          ? <Mono>{it.phase1ResultVersionId}</Mono>
                          : (it.state === 'phase1_running' && it.runId
                            ? (judgePaused || casePaused(it.runId)
                              ? <span className="hint">Paused. Resume continues this case.</span>
                              : (
                                <button
                                  onClick={() => api.post(`/api/projects/${id}/runs/${it.runId}/phase1/pause`).then(invalidate, (e) => setMsg({ tone: 'danger', text: errText(e) }))}
                                >
                                  Pause this case
                                </button>
                              ))
                            : '—')}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </Panel>
      )}

      {queue && (
        <Panel title="Evals in this queue">
          {items.length === 0 && (
            <Empty title="None selected yet">
              Tick evals from the store below. Those are the ones a start will run.
            </Empty>
          )}
          {items.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Include</th>
                  <th>Eval</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((it) => {
                  const t = store.find((e) => e.id === it.taskId)
                  return (
                    <tr key={it.id}>
                      <td>
                        <input
                          type="checkbox"
                          checked={it.enabled !== false}
                          onChange={(e) => toggleItem.mutate({ itemId: it.id, enabled: e.target.checked })}
                          aria-label={`Include ${t?.name ?? it.taskId}`}
                        />
                      </td>
                      <td style={{ color: 'var(--text)' }}>
                        {t?.name ?? '—'} <Mono copy>{it.taskId}</Mono>
                      </td>
                      <td>
                        <button className="danger" onClick={() => removeItem.mutate(it.id)}>Remove</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </Panel>
      )}

      {queue && (
        <Panel
          title="Eval store"
          actions={available.length > 0 ? (
            <button
              className="primary"
              disabled={addAll.isPending || addItem.isPending}
              onClick={() => addAll.mutate(available.map((t) => t.id))}
            >
              {addAll.isPending ? 'Adding…' : `Add all ${available.length} to queue`}
            </button>
          ) : undefined}
        >
          <p style={{ color: 'var(--text-dim)', fontSize: 13, marginTop: 0 }}>
            Packages imported into this project. Add one to the queue to include it in the next start.
            Setup and cleanup scripts live in the package, not here.
          </p>
          {evals.isLoading && <Spinner label="Loading evals…" />}
          {store.length === 0 && (
            <Empty title="No evals in the store">
              <Link to={`/projects/${id}/evals`}><button className="primary">Open evals</button></Link>
            </Empty>
          )}
          {available.length === 0 && store.length > 0 && (
            <p style={{ color: 'var(--text-faint)', fontSize: 13 }}>Every eval in the store is already on the queue.</p>
          )}
          {available.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Category</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {available.map((t) => (
                  <tr key={t.id}>
                    <td style={{ color: 'var(--text)' }}>{t.name}</td>
                    <td><CategoryChip value={(t.category_name ?? t.categoryName) as string | null} /></td>
                    <td>
                      <button className="primary" onClick={() => addItem.mutate(t.id)} disabled={addItem.isPending || addAll.isPending}>
                        Add to queue
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      )}
    </>
  )
}
