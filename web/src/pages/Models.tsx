import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, errText } from '../lib/api'
import { Banner, Empty, Mono, PageHead, Panel, Spinner } from '../components/ui'

type ApiType = 'openai' | 'anthropic'
type Stage = 'eval' | 'phase1' | 'phase2'

interface StageView {
  stage: Stage
  apiType: ApiType
  baseUrl: string
  model: string
  reasoningEffort: string
  timeoutMs: number
  apiKeyEnv: string | null
  apiKeyPresent: boolean
  envVars: Record<'apiType' | 'baseUrl' | 'apiKey' | 'apiKeyEnv' | 'model' | 'reasoningEffort' | 'timeoutMs', string>
  error: string | null
}

interface HealthResult {
  stage: Stage
  ok: boolean
  apiType: ApiType
  baseUrl: string
  model: string
  latencyMs: number | null
  status: number | null
  reply: string | null
  errorKind: string | null
  error: string | null
}

// What each stage actually drives, so an operator picking endpoints knows
// which one costs money per eval and which one only runs after a seal.
const STAGE_COPY: Record<Stage, { title: string; sub: string }> = {
  eval: { title: 'Eval execution', sub: 'The model the agent under test runs against.' },
  phase1: { title: 'Phase 1', sub: 'Per-eval courtroom: nodes 0 to 4, kratos, logos, minos, remedy.' },
  phase2: { title: 'Phase 2', sub: 'Cross-eval campaign board: investigator, researcher, designer, reviewer.' },
}

type Draft = { apiType: ApiType; baseUrl: string; apiKeyEnv: string; model: string; reasoningEffort: string; timeoutMs: string }

function draftFrom(v: StageView): Draft {
  return {
    apiType: v.apiType,
    baseUrl: v.baseUrl,
    apiKeyEnv: v.apiKeyEnv ?? '',
    model: v.model,
    reasoningEffort: v.reasoningEffort,
    timeoutMs: String(v.timeoutMs),
  }
}

export default function Models() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['model-config'], queryFn: () => api.get<{ stages: StageView[] }>('/api/settings/models') })
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [health, setHealth] = useState<Record<string, HealthResult | 'running'>>({})

  useEffect(() => {
    if (q.data) setDrafts(Object.fromEntries(q.data.stages.map((s) => [s.stage, draftFrom(s)])))
  }, [q.data])

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.put<{ stages: StageView[] }>('/api/settings/models', body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['model-config'] }),
  })

  async function runHealth(stage: Stage) {
    setHealth((h) => ({ ...h, [stage]: 'running' }))
    try {
      const result = await api.post<HealthResult>(`/api/settings/models/${stage}/health`, {})
      setHealth((h) => ({ ...h, [stage]: result }))
    } catch (err) {
      setHealth((h) => ({
        ...h,
        [stage]: { stage, ok: false, apiType: 'openai', baseUrl: '', model: '', latencyMs: null, status: null, reply: null, errorKind: 'transport', error: errText(err) },
      }))
    }
  }

  function saveAll() {
    save.mutate(
      Object.fromEntries(
        Object.entries(drafts).map(([stage, d]) => [
          stage,
          { apiType: d.apiType, baseUrl: d.baseUrl, apiKeyEnv: d.apiKeyEnv, model: d.model, reasoningEffort: d.reasoningEffort, timeoutMs: d.timeoutMs || undefined },
        ]),
      ),
    )
  }

  const stages = q.data?.stages ?? []

  return (
    <>
      <PageHead
        title="Models"
        sub="One provider config per stage. Keys stay in the environment; only the variable name is saved."
        actions={<button className="primary" onClick={saveAll} disabled={save.isPending || stages.length === 0}>{save.isPending ? 'Saving…' : 'Save all'}</button>}
      />
      {q.isError && <Banner tone="danger">{errText(q.error)}</Banner>}
      {save.isError && <Banner tone="danger">{errText(save.error)}</Banner>}
      {q.isLoading && <Spinner label="Loading model config…" />}
      {!q.isLoading && stages.length === 0 && <Empty title="No stages returned" />}

      {stages.map((s) => {
        const d = drafts[s.stage]
        if (!d) return null
        const set = (k: keyof Draft, v: string) => setDrafts((prev) => ({ ...prev, [s.stage]: { ...prev[s.stage]!, [k]: v } }))
        const h = health[s.stage]
        return (
          <Panel
            key={s.stage}
            title={STAGE_COPY[s.stage].title}
            actions={
              <button onClick={() => void runHealth(s.stage)} disabled={h === 'running'}>
                {h === 'running' ? 'Checking…' : 'Health check'}
              </button>
            }
          >
            <div style={{ color: 'var(--text-dim)', fontSize: 12, marginBottom: 'var(--s3)' }}>{STAGE_COPY[s.stage].sub}</div>
            {s.error && <Banner tone="warn">{s.error}</Banner>}

            <div className="form-grid">
              <div className="field">
                <label htmlFor={`${s.stage}-type`}>API compatibility type</label>
                <select id={`${s.stage}-type`} value={d.apiType} onChange={(e) => set('apiType', e.target.value)}>
                  <option value="openai">OpenAI compatible</option>
                  <option value="anthropic">Anthropic compatible</option>
                </select>
                <span className="hint">{s.envVars.apiType}</span>
              </div>
              <div className="field">
                <label htmlFor={`${s.stage}-url`}>Base URL</label>
                <input id={`${s.stage}-url`} value={d.baseUrl} onChange={(e) => set('baseUrl', e.target.value)} placeholder="https://api.example.com/v1" />
                <span className="hint">{s.envVars.baseUrl}</span>
              </div>
              <div className="field">
                <label htmlFor={`${s.stage}-keyenv`}>API key variable</label>
                <input id={`${s.stage}-keyenv`} value={d.apiKeyEnv} onChange={(e) => set('apiKeyEnv', e.target.value)} placeholder={s.envVars.apiKey} />
                <span className="hint">
                  {s.apiKeyPresent
                    ? <>key found in <Mono>{s.apiKeyEnv}</Mono></>
                    : <>set {s.envVars.apiKey} in the environment, or name another variable here</>}
                </span>
              </div>
              <div className="field">
                <label htmlFor={`${s.stage}-model`}>Model</label>
                <input id={`${s.stage}-model`} value={d.model} onChange={(e) => set('model', e.target.value)} />
                <span className="hint">{s.envVars.model}</span>
              </div>
              <div className="field">
                <label htmlFor={`${s.stage}-effort`}>Reasoning effort</label>
                <input id={`${s.stage}-effort`} value={d.reasoningEffort} onChange={(e) => set('reasoningEffort', e.target.value)} />
                <span className="hint">{s.envVars.reasoningEffort}</span>
              </div>
              <div className="field">
                <label htmlFor={`${s.stage}-timeout`}>Timeout (ms)</label>
                <input id={`${s.stage}-timeout`} value={d.timeoutMs} onChange={(e) => set('timeoutMs', e.target.value)} inputMode="numeric" />
                <span className="hint">{s.envVars.timeoutMs}</span>
              </div>
            </div>

            {h && h !== 'running' && (
              <div style={{ marginTop: 'var(--s3)' }}>
                <Banner tone={h.ok ? 'ok' : 'danger'}>
                  {h.ok ? (
                    <>Reached <Mono>{h.model}</Mono> at <Mono>{h.baseUrl}</Mono> in {h.latencyMs}ms. Replied {JSON.stringify(h.reply)}.</>
                  ) : (
                    <>{h.errorKind} failure{h.status ? ` (HTTP ${h.status})` : ''}: {h.error}</>
                  )}
                </Banner>
              </div>
            )}
          </Panel>
        )
      })}
    </>
  )
}
