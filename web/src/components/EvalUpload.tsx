import { useRef, useState } from 'react'
import { api, errText } from '../lib/api'
import { Banner, Field, Mono } from './ui'

type Format = 'zip' | 'tar' | 'tar.gz'

function formatOf(name: string): Format | null {
  const lower = name.toLowerCase()
  if (lower.endsWith('.zip')) return 'zip'
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tar.gz'
  if (lower.endsWith('.tar')) return 'tar'
  return null
}

/**
 * Two ways to add one eval package: pick an archive file, or paste the
 * canonical JSON. Both post to the same pair of routes, so the caller only
 * supplies the base path (`/api/eval-store` or `/api/projects/:id/evals`).
 */
export function EvalUpload({
  basePath,
  onDone,
  onCancel,
}: {
  basePath: string
  onDone: () => void
  onCancel: () => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [json, setJson] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const format = file ? formatOf(file.name) : null

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      if (file) {
        if (!format) throw new Error('Pick a .zip, .tar, or .tar.gz archive')
        await api.upload(`${basePath}:import-archive?format=${format}`, file)
      } else {
        let parsed: unknown
        try {
          parsed = JSON.parse(json)
        } catch {
          throw new Error('That is not valid JSON')
        }
        await api.post(basePath, parsed)
      }
      onDone()
    } catch (err) {
      setError(errText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit}>
      {error && <Banner tone="danger">{error}</Banner>}

      <Field label="Package archive" hint="A .zip, .tar, or .tar.gz holding one eval or a whole suite">
        <div style={{ display: 'flex', gap: 'var(--s2)', alignItems: 'center' }}>
          <input
            ref={fileRef}
            type="file"
            accept=".zip,.tar,.tar.gz,.tgz"
            onChange={(e) => { setFile(e.target.files?.[0] ?? null); setError(null) }}
          />
          {file && (
            <button type="button" onClick={() => { setFile(null); if (fileRef.current) fileRef.current.value = '' }}>
              Clear
            </button>
          )}
        </div>
      </Field>
      {file && !format && (
        <Banner tone="warn">Unknown extension. Rename to .zip, .tar, or .tar.gz.</Banner>
      )}

      {!file && (
        <Field label="Or paste the canonical package JSON" hint="An EvalPackageUpload object: a files map keyed by path">
          <textarea
            rows={12}
            value={json}
            onChange={(e) => setJson(e.target.value)}
            style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}
            placeholder='{ "files": { "task.toml": "…", "instruction.md": "…" } }'
          />
        </Field>
      )}

      <div style={{ display: 'flex', gap: 'var(--s2)', marginTop: 'var(--s3)' }}>
        <button type="submit" className="primary" disabled={busy || (!file && !json.trim())}>
          {busy ? 'Importing…' : 'Import package'}
        </button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>

      <p style={{ color: 'var(--text-faint)', fontSize: 12, marginTop: 'var(--s3)', lineHeight: 1.6 }}>
        A package must carry <Mono>task.toml</Mono>, <Mono>instruction.md</Mono>, <Mono>README.md</Mono>,
        an <Mono>environment/</Mono> (Dockerfile, setup.sh, cleanup.sh, healthcheck.sh),
        a <Mono>tests/</Mono> (Dockerfile, test.sh, verifier.py), a <Mono>solution/</Mono>,
        a <Mono>validation/</Mono>, and a seeded <Mono>seed_repo/</Mono>.
        Anything missing is rejected and named in the error. Full tree and task.toml keys: <Mono>docs/eval-authoring.md</Mono>.
      </p>
    </form>
  )
}
