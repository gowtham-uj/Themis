import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'
import { api, errText } from '../lib/api'
import type { Adapter } from '../lib/types'
import { Banner, Empty, Field, Modal, Mono, PageHead, Panel, Spinner } from '../components/ui'

export default function Adapters() {
  const { id } = useParams()
  const qc = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'danger' | 'ok'; text: string } | null>(null)
  const [docOpen, setDocOpen] = useState(false)

  const q = useQuery({ queryKey: ['adapters', id], queryFn: () => api.get<{ adapters: Adapter[] }>(`/api/projects/${id}/adapters`) })
  const contract = useQuery({ queryKey: ['generator-contract'], queryFn: () => api.get<unknown>('/api/adapters/generator-contract') })

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post<Adapter>(`/api/projects/${id}/adapters`, body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['adapters', id] }); setCreating(false); setMsg({ tone: 'ok', text: 'Adapter created' }) },
    onError: (e) => setMsg({ tone: 'danger', text: errText(e) }),
  })

  return (
    <>
      <PageHead
        title="Adapters"
        sub="Agent adapters linked to this project"
        actions={<>
          <button onClick={() => setDocOpen(true)}>Adapter docs</button>
          <button className="primary" onClick={() => setCreating(true)}>New adapter</button>
        </>}
      />

      {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}

      <Panel title={`Adapters (${q.data?.adapters.length ?? 0})`}>
        {q.isLoading && <Spinner label="Loading adapters…" />}
        {q.isError && <Banner tone="danger">{errText(q.error)}</Banner>}
        {q.data?.adapters.length === 0 && <Empty title="No adapters yet"><button className="primary" onClick={() => setCreating(true)}>Create one</button></Empty>}
        {q.data && q.data.adapters.length > 0 && (
          <table>
            <thead><tr><th>Agent</th><th>Install type</th><th>Source repo / commit</th><th>Provider</th><th>Model</th><th>Image</th><th /></tr></thead>
            <tbody>{q.data.adapters.map((a, i) => (
              <tr key={a.id ?? i}>
                <td style={{ color: 'var(--text)', fontWeight: 600 }}>{a.agent_id ?? a.agentId ?? a.name}</td>
                <td><span className="chip">{a.install_type ?? a.installType ?? '—'}</span></td>
                <td><Mono>{a.sourceRepo ?? '—'}</Mono> <Mono copy>{a.sourceCommit ?? ''}</Mono></td>
                <td><Mono>{a.defaultProvider ?? '—'}</Mono></td>
                <td><Mono>{a.default_model ?? a.defaultModel ?? '—'}</Mono></td>
                <td><Mono copy>{a.image ?? '—'}</Mono></td>
                <td><button className="danger" onClick={() => { if (confirm(`Delete adapter?`)) api.del(`/api/projects/${id}/adapters/${a.id}`).then(() => qc.invalidateQueries({ queryKey: ['adapters', id] })) }}>Delete</button></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Panel>

      <Modal title="New adapter" open={creating} onClose={() => setCreating(false)}>
        <form className="form-grid" onSubmit={(e) => {
          e.preventDefault()
          const f = new FormData(e.currentTarget)
          create.mutate({
            agent_id: f.get('agent_id'),
            name: f.get('name'),
            generator: f.get('generator'),
            install_type: f.get('install_type'),
            source_repo: f.get('source_repo') || undefined,
            source_ref: f.get('source_ref') || undefined,
            default_provider: f.get('default_provider') || undefined,
            default_model: f.get('default_model') || undefined,
            build: true,
          })
        }}>
          <Field label="Agent id" hint="letters, numbers, dot, underscore, dash"><input name="agent_id" required autoFocus /></Field>
          <Field label="Name"><input name="name" required /></Field>
          <Field label="Generator" hint="bash/JS script that emits the adapter"><textarea name="generator" rows={4} required style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }} /></Field>
          <Field label="Install type"><select name="install_type"><option value="npm">npm</option><option value="pip">pip</option><option value="binary">binary</option><option value="docker">docker</option></select></Field>
          <Field label="Source repo"><input name="source_repo" placeholder="https://github.com/…" /></Field>
          <Field label="Source ref"><input name="source_ref" placeholder="main" /></Field>
          <Field label="Default provider"><input name="default_provider" placeholder="openai-compatible" /></Field>
          <Field label="Default model"><input name="default_model" placeholder="deepseek-v4-flash" /></Field>
          <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 'var(--s2)' }}>
            <button type="submit" className="primary" disabled={create.isPending}>{create.isPending ? 'Creating + building…' : 'Create & build'}</button>
            <button type="button" onClick={() => setCreating(false)}>Cancel</button>
          </div>
        </form>
      </Modal>

      <Modal title="How to write an adapter for your agent" open={docOpen} onClose={() => setDocOpen(false)}>
        <article style={{ fontSize: 13, color: 'var(--text-dim)', maxWidth: 720 }}>
          <h2 style={{ color: 'var(--text)' }}>Adapter contract</h2>
          <p>An adapter wraps your agent CLI so the platform can run it and capture evidence. Two ways to provide one:</p>
          <ol>
            <li><strong>Declarative</strong> — POST <Mono>/api/projects/:id/adapters</Mono> with <Mono>agent_id</Mono>, <Mono>name</Mono>, <Mono>generator</Mono>, <Mono>install_type</Mono>, and optional <Mono>source_repo</Mono>/<Mono>source_ref</Mono>.</li>
            <li><strong>Built-in</strong> — set <Mono>builtin_adapter_id</Mono> to <Mono>reapercode</Mono> or <Mono>pi</Mono> on a queue.</li>
          </ol>
          <p><strong>Generator</strong> is a bash/JS script that returns a JSON object describing your agent:</p>
          <pre className="code">{`{
  "agentId": "my-agent",
  "name": "My Agent",
  "installType": "npm",
  "containerfile": "FROM node:22-bookworm\\nRUN npm install -g my-agent",
  "command": { "argv": ["my-agent", "run", "--prompt", "$PROMPT"] },
  "env": { "MY_AGENT_API_KEY": "$MY_AGENT_API_KEY" },
  "evidence": { "paths": ["task"] }
}`}</pre>
          <ul>
            <li><Mono>containerfile</Mono> — how to build the agent image (npm/pip/docker install).</li>
            <li><Mono>command.argv</Mono> — how the platform launches your agent; <Mono>$PROMPT</Mono> is replaced with the eval task.</li>
            <li><Mono>env</Mono> — adapter-declared environment variables, injected only into the agent process (never baked into images).</li>
            <li><Mono>evidence.paths</Mono> — which workspace paths to retain after the run.</li>
          </ul>
          <p>Provider and model are configured per <em>queue</em> (not per adapter), so one adapter can run on many models.</p>

          <h2 style={{ color: 'var(--text)' }}>Generator contract (from the API)</h2>
          {contract.isLoading && <Spinner label="Loading contract…" />}
          {contract.isError && <Banner tone="danger">{errText(contract.error)}</Banner>}
          {contract.data !== undefined && <pre className="code" style={{ maxHeight: 360 }}>{JSON.stringify(contract.data, null, 2)}</pre>}
        </article>
      </Modal>
    </>
  )
}
