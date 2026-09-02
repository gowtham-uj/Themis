import { useState, type ReactNode } from 'react'
import { api, errText } from '../lib/api'
import { Banner, Mono } from './ui'

export type ApiType = 'openai' | 'anthropic'
export type Stage = 'eval' | 'phase1' | 'phase2'

export const STAGES: Stage[] = ['eval', 'phase1', 'phase2']

export interface StageView {
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

export interface HealthResult {
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

export interface StageDraft {
  apiType: ApiType
  baseUrl: string
  apiKeyEnv: string
  model: string
  reasoningEffort: string
  timeoutMs: string
}

export const EMPTY_DRAFT: StageDraft = { apiType: 'openai', baseUrl: '', apiKeyEnv: '', model: '', reasoningEffort: '', timeoutMs: '' }

/** What each stage drives, so the operator knows which endpoint costs what. */
export const STAGE_COPY: Record<Stage, { title: string; short: string; sub: string }> = {
  eval: {
    title: 'Eval execution',
    short: 'Eval',
    sub: 'The model the agent under test runs against. This one is billed on every eval.',
  },
  phase1: {
    title: 'Phase 1',
    short: 'Phase 1',
    sub: 'Per-eval courtroom: nodes 0 to 4, plus kratos, logos, minos, and remedy.',
  },
  phase2: {
    title: 'Phase 2',
    short: 'Phase 2',
    sub: 'Cross-eval campaign board: investigator, researcher, designer, reviewer.',
  },
}

export function draftFromView(v: StageView): StageDraft {
  return {
    apiType: v.apiType,
    baseUrl: v.baseUrl,
    apiKeyEnv: v.apiKeyEnv ?? '',
    model: v.model,
    reasoningEffort: v.reasoningEffort,
    timeoutMs: String(v.timeoutMs),
  }
}

/** Drop blank fields so an unfilled input inherits instead of storing "". */
export function draftToPatch(d: StageDraft, includeType: boolean): Record<string, unknown> | null {
  const out: Record<string, unknown> = {}
  if (includeType) out.apiType = d.apiType
  if (d.baseUrl.trim()) out.baseUrl = d.baseUrl.trim()
  if (d.apiKeyEnv.trim()) out.apiKeyEnv = d.apiKeyEnv.trim()
  if (d.model.trim()) out.model = d.model.trim()
  if (d.reasoningEffort.trim()) out.reasoningEffort = d.reasoningEffort.trim()
  if (d.timeoutMs.trim()) out.timeoutMs = d.timeoutMs.trim()
  return Object.keys(out).length > 0 ? out : null
}

/**
 * Six fields for one stage. `inherited` supplies placeholder text so a blank
 * input visibly shows the value it will fall through to rather than looking
 * unconfigured.
 */
export function StageFields({
  stage,
  draft,
  onChange,
  inherited,
  disabled,
}: {
  stage: Stage
  draft: StageDraft
  onChange: (next: StageDraft) => void
  inherited?: StageView
  disabled?: boolean
}) {
  const set = (k: keyof StageDraft, v: string) => onChange({ ...draft, [k]: v })
  const env = inherited?.envVars
  return (
    <div className="form-grid">
      <div className="field">
        <label htmlFor={`${stage}-type`}>API compatibility type</label>
        <select id={`${stage}-type`} value={draft.apiType} disabled={disabled} onChange={(e) => set('apiType', e.target.value)}>
          <option value="openai">OpenAI compatible</option>
          <option value="anthropic">Anthropic compatible</option>
        </select>
        <span className="hint">{env?.apiType ?? 'Which wire format the endpoint speaks'}</span>
      </div>
      <div className="field">
        <label htmlFor={`${stage}-url`}>Base URL</label>
        <input
          id={`${stage}-url`}
          value={draft.baseUrl}
          disabled={disabled}
          onChange={(e) => set('baseUrl', e.target.value)}
          placeholder={inherited?.baseUrl || 'https://api.example.com/v1'}
        />
        <span className="hint">{env?.baseUrl ?? ''}</span>
      </div>
      <div className="field">
        <label htmlFor={`${stage}-keyenv`}>API key variable</label>
        <input
          id={`${stage}-keyenv`}
          value={draft.apiKeyEnv}
          disabled={disabled}
          onChange={(e) => set('apiKeyEnv', e.target.value)}
          placeholder={inherited?.apiKeyEnv ?? env?.apiKey ?? ''}
        />
        <span className="hint">
          {inherited?.apiKeyPresent ? (
            <>key found in <Mono>{inherited.apiKeyEnv}</Mono></>
          ) : (
            <>name the environment variable holding the key. The value is never saved.</>
          )}
        </span>
      </div>
      <div className="field">
        <label htmlFor={`${stage}-model`}>Model</label>
        <input
          id={`${stage}-model`}
          value={draft.model}
          disabled={disabled}
          onChange={(e) => set('model', e.target.value)}
          placeholder={inherited?.model || 'deepseek-v4-flash'}
        />
        <span className="hint">{env?.model ?? ''}</span>
      </div>
      <div className="field">
        <label htmlFor={`${stage}-effort`}>Reasoning effort</label>
        <input
          id={`${stage}-effort`}
          value={draft.reasoningEffort}
          disabled={disabled}
          onChange={(e) => set('reasoningEffort', e.target.value)}
          placeholder={inherited?.reasoningEffort || 'max'}
        />
        <span className="hint">{env?.reasoningEffort ?? ''}</span>
      </div>
      <div className="field">
        <label htmlFor={`${stage}-timeout`}>Timeout (ms)</label>
        <input
          id={`${stage}-timeout`}
          value={draft.timeoutMs}
          disabled={disabled}
          inputMode="numeric"
          onChange={(e) => set('timeoutMs', e.target.value)}
          placeholder={inherited ? String(inherited.timeoutMs) : '300000'}
        />
        <span className="hint">{env?.timeoutMs ?? ''}</span>
      </div>
    </div>
  )
}

/** Render one health probe outcome. */
export function HealthBanner({ result }: { result: HealthResult }): ReactNode {
  if (result.ok) {
    return (
      <Banner tone="ok">
        Reached <Mono>{result.model}</Mono> at <Mono>{result.baseUrl}</Mono> in {result.latencyMs}ms. Replied {JSON.stringify(result.reply)}.
      </Banner>
    )
  }
  return (
    <Banner tone="danger">
      {result.errorKind} failure{result.status ? ` (HTTP ${result.status})` : ''}: {result.error}
    </Banner>
  )
}

/**
 * Health checks for the three stages. The optional patch lets a form probe
 * what the operator just typed, before anything is saved.
 */
export function useStageHealth() {
  const [health, setHealth] = useState<Partial<Record<Stage, HealthResult | 'running'>>>({})
  async function run(stage: Stage, patch?: Record<string, unknown> | null) {
    setHealth((h) => ({ ...h, [stage]: 'running' }))
    try {
      const result = await api.post<HealthResult>(`/api/settings/models/${stage}/health`, patch ?? {})
      setHealth((h) => ({ ...h, [stage]: result }))
    } catch (err) {
      setHealth((h) => ({
        ...h,
        [stage]: {
          stage, ok: false, apiType: 'openai', baseUrl: '', model: '',
          latencyMs: null, status: null, reply: null, errorKind: 'transport', error: errText(err),
        },
      }))
    }
  }
  return { health, run }
}
