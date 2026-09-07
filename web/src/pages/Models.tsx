import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, errText } from '../lib/api'
import { Banner, Empty, PageHead, Panel, Spinner } from '../components/ui'
import {
  StageFields, HealthBanner, useStageHealth, useStoredSecrets, draftFromView, draftToPatch,
  STAGE_COPY, type StageDraft, type StageView,
} from '../components/model-stage'

export default function Models() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['model-config'], queryFn: () => api.get<{ stages: StageView[] }>('/api/settings/models') })
  const [drafts, setDrafts] = useState<Record<string, StageDraft>>({})
  const { health, run } = useStageHealth()
  const secrets = useStoredSecrets()

  useEffect(() => {
    if (q.data) setDrafts(Object.fromEntries(q.data.stages.map((s) => [s.stage, draftFromView(s)])))
  }, [q.data])

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.put<{ stages: StageView[] }>('/api/settings/models', body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['model-config'] }),
  })

  function saveAll() {
    save.mutate(Object.fromEntries(Object.entries(drafts).map(([stage, d]) => [stage, draftToPatch(d, true) ?? {}])))
  }

  const stages = q.data?.stages ?? []

  return (
    <>
      <PageHead
        title="Models"
        sub="Defaults every project starts from. A project can set its own on its Models tab, and a filled project field wins over the same field here. Each stage names the variable holding its key. Paste a value to have the server hold it encrypted and load it into that variable on every start."
        actions={<button className="primary" onClick={saveAll} disabled={save.isPending || stages.length === 0}>{save.isPending ? 'Saving…' : 'Save all'}</button>}
      />
      {q.isError && <Banner tone="danger">{errText(q.error)}</Banner>}
      {save.isError && <Banner tone="danger">{errText(save.error)}</Banner>}
      {secrets.put.isError && <Banner tone="danger">{errText(secrets.put.error)}</Banner>}
      {secrets.del.isError && <Banner tone="danger">{errText(secrets.del.error)}</Banner>}
      {q.isLoading && <Spinner label="Loading model config…" />}
      {!q.isLoading && stages.length === 0 && <Empty title="No stages returned" />}

      {stages.map((s) => {
        const d = drafts[s.stage]
        if (!d) return null
        const h = health[s.stage]
        return (
          <Panel
            key={s.stage}
            title={STAGE_COPY[s.stage].title}
            actions={
              <button onClick={() => void run(s.stage)} disabled={h === 'running'}>
                {h === 'running' ? 'Checking…' : 'Health check'}
              </button>
            }
          >
            <div style={{ color: 'var(--text-dim)', fontSize: 12, marginBottom: 'var(--s3)' }}>{STAGE_COPY[s.stage].sub}</div>
            {s.error && <Banner tone="warn">{s.error}</Banner>}
            <StageFields stage={s.stage} draft={d} inherited={s} secrets={secrets} onChange={(next) => setDrafts((prev) => ({ ...prev, [s.stage]: next }))} />
            {h && h !== 'running' && <div style={{ marginTop: 'var(--s3)' }}><HealthBanner result={h} /></div>}
          </Panel>
        )
      })}
    </>
  )
}
