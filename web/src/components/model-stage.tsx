import { useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
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
  webSearchApiKeyEnv: string | null
  webSearchApiKeyPresent: boolean
  envVars: Record<'apiType' | 'baseUrl' | 'apiKey' | 'apiKeyEnv' | 'webSearchApiKeyEnv' | 'model' | 'reasoningEffort' | 'timeoutMs', string>
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
  webSearchApiKeyEnv: string
  model: string
  reasoningEffort: string
  timeoutMs: string
}

export const EMPTY_DRAFT: StageDraft = { apiType: 'openai', baseUrl: '', apiKeyEnv: '', webSearchApiKeyEnv: '', model: '', reasoningEffort: '', timeoutMs: '' }

/** What each stage drives, so the operator knows which endpoint costs what. */
export const STAGE_COPY: Record<Stage, { title: string; short: string; sub: string }> = {
  eval: {
    title: 'The agent',
    short: 'Agent',
    sub: 'The model your agent talks to while it works each eval.',
  },
  phase1: {
    title: 'Per-eval judge',
    short: 'Judge',
    sub: 'After each eval finishes, the courtroom reads that archive and writes a verdict.',
  },
  phase2: {
    title: 'Across evals',
    short: 'Across',
    sub: 'Once every selected eval has a verdict, look for patterns and a fix plan. Needs the judge.',
  },
}

export function draftFromView(v: StageView): StageDraft {
  return {
    apiType: v.apiType,
    baseUrl: v.baseUrl,
    apiKeyEnv: v.apiKeyEnv ?? '',
    webSearchApiKeyEnv: v.webSearchApiKeyEnv ?? '',
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
  if (d.webSearchApiKeyEnv.trim()) out.webSearchApiKeyEnv = d.webSearchApiKeyEnv.trim()
  if (d.model.trim()) out.model = d.model.trim()
  if (d.reasoningEffort.trim()) out.reasoningEffort = d.reasoningEffort.trim()
  if (d.timeoutMs.trim()) out.timeoutMs = d.timeoutMs.trim()
  return Object.keys(out).length > 0 ? out : null
}

export interface StoredSecret { name: string; updatedAt: string }

/** Names and write times of the keys the server holds. Never values. */
export function useStoredSecrets() {
  const qc = useQueryClient()
  const list = useQuery({
    queryKey: ['secrets'],
    queryFn: () => api.get<{ secrets: StoredSecret[] }>('/api/settings/secrets'),
  })
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['secrets'] })
    void qc.invalidateQueries({ queryKey: ['model-config'] })
    void qc.invalidateQueries({ queryKey: ['projects'] })
  }
  const put = useMutation({
    mutationFn: (v: { name: string; value: string }) =>
      api.put(`/api/settings/secrets/${encodeURIComponent(v.name)}`, { value: v.value }),
    onSuccess: invalidate,
  })
  const del = useMutation({
    mutationFn: (name: string) => api.del(`/api/settings/secrets/${encodeURIComponent(name)}`),
    onSuccess: invalidate,
  })
  const names = new Set((list.data?.secrets ?? []).map((s) => s.name))
  return { secrets: list.data?.secrets ?? [], has: (n: string) => names.has(n), put, del }
}

/**
 * Paste a key value for one environment variable name.
 *
 * The value goes to the server encrypted at rest and is decrypted back into the
 * server's environment, so every queue, adapter, and judge stage resolves it by
 * the same variable name it already reads. Masked by default; the eye reveals
 * what was typed before saving.
 */
export function SecretValueField({
  envName,
  stored,
  onSave,
  onClear,
  busy,
  disabled,
}: {
  envName: string
  stored: boolean
  onSave: (value: string) => void
  onClear: () => void
  busy?: boolean
  disabled?: boolean
}) {
  const [value, setValue] = useState('')
  const [shown, setShown] = useState(false)
  const ready = Boolean(envName.trim()) && !disabled
  return (
    <div className="field">
      <label htmlFor={`${envName || 'key'}-value`}>Key value</label>
      <div className="input-row">
        <input
          id={`${envName || 'key'}-value`}
          type={shown ? 'text' : 'password'}
          value={value}
          autoComplete="off"
          spellCheck={false}
          disabled={!ready || busy}
          onChange={(e) => setValue(e.target.value)}
          placeholder={stored ? 'a key is saved for this variable' : 'paste the key to save it'}
        />
        <button
          type="button"
          className="icon-button"
          aria-label={shown ? 'Hide key value' : 'Show key value'}
          aria-pressed={shown}
          title={shown ? 'Hide' : 'Show'}
          disabled={!value}
          onClick={() => setShown((s) => !s)}
        >
          {shown ? '🙈' : '👁'}
        </button>
        <button
          type="button"
          disabled={!ready || !value.trim() || busy}
          onClick={() => { onSave(value.trim()); setValue(''); setShown(false) }}
        >
          {busy ? 'Saving…' : 'Save key'}
        </button>
        {stored && (
          <button type="button" className="danger" disabled={busy} onClick={onClear}>Clear</button>
        )}
      </div>
      <span className="hint">
        {!envName.trim()
          ? 'Name the variable above first.'
          : stored
            ? <>saved and loaded into <Mono>{envName}</Mono> on every start. Saving again replaces it.</>
            : <>stored encrypted, then loaded into <Mono>{envName}</Mono> on every start. Leave blank if the server already exports it.</>}
      </span>
    </div>
  )
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
  secrets,
}: {
  stage: Stage
  draft: StageDraft
  onChange: (next: StageDraft) => void
  inherited?: StageView
  disabled?: boolean
  secrets?: ReturnType<typeof useStoredSecrets>
}) {
  const set = (k: keyof StageDraft, v: string) => onChange({ ...draft, [k]: v })
  const env = inherited?.envVars
  // Fall back to the stage's own variable name so a stage that has never been
  // configured can still take a pasted key: the field shows that name as its
  // placeholder, so an empty target here would read as a dead control.
  const keyName = draft.apiKeyEnv.trim() || inherited?.apiKeyEnv || env?.apiKey || ''
  const webKeyName = draft.webSearchApiKeyEnv.trim() || inherited?.webSearchApiKeyEnv || 'SERPER_SEARCH_API_KEY'
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
            <>name the environment variable holding the key.</>
          )}
        </span>
      </div>
      {secrets && (
        <SecretValueField
          envName={keyName}
          stored={secrets.has(keyName)}
          busy={secrets.put.isPending || secrets.del.isPending}
          disabled={disabled}
          onSave={(value) => secrets.put.mutate({ name: keyName, value })}
          onClear={() => secrets.del.mutate(keyName)}
        />
      )}
      {stage !== 'eval' && (
        <div className="field">
          <label htmlFor={`${stage}-web-keyenv`}>Serper key variable</label>
          <input
            id={`${stage}-web-keyenv`}
            value={draft.webSearchApiKeyEnv}
            disabled={disabled}
            onChange={(e) => set('webSearchApiKeyEnv', e.target.value)}
            placeholder={inherited?.webSearchApiKeyEnv ?? 'SERPER_SEARCH_API_KEY'}
          />
          <span className="hint">
            {inherited?.webSearchApiKeyPresent ? (
              <>key found in <Mono>{inherited.webSearchApiKeyEnv}</Mono></>
            ) : (
              <>Serper covers the general web; arXiv runs alongside it.</>
            )}
          </span>
        </div>
      )}
      {secrets && stage !== 'eval' && (
        <SecretValueField
          envName={webKeyName}
          stored={secrets.has(webKeyName)}
          busy={secrets.put.isPending || secrets.del.isPending}
          disabled={disabled}
          onSave={(value) => secrets.put.mutate({ name: webKeyName, value })}
          onClear={() => secrets.del.mutate(webKeyName)}
        />
      )}
      <div className="field">
        <label htmlFor={`${stage}-model`}>Model</label>
        <input
          id={`${stage}-model`}
          value={draft.model}
          disabled={disabled}
          onChange={(e) => set('model', e.target.value)}
          placeholder={inherited?.model || 'model id the endpoint serves'}
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
