import { useEffect, useState, type ReactNode } from 'react'

export function Status({ tone, label }: { tone: 'ok' | 'warn' | 'danger' | 'violet' | 'info' | 'muted'; label: string }) {
  return <span className={`status ${tone}`}><span className="dot" />{label}</span>
}

/**
 * Backend state names are snake_case enums. A badge is read at a glance, so it
 * shows the phrase a person would say instead of the wire value. States without
 * an entry already read as English once underscores become spaces.
 */
const STATE_LABELS: Record<string, string> = {
  eval_pending: 'waiting',
  eval_running: 'agent working',
  archive_sealed: 'sealed',
  phase1_pending: 'judge queued',
  phase1_running: 'judging',
  phase1_published: 'judged',
  phase2_attached: 'in across pass',
  final_view_published: 'final view sealed',
  dead_letter: 'gave up',
  waiting_retry: 'retrying',
}

export function toneFor(state: string | undefined): { tone: 'ok' | 'warn' | 'danger' | 'violet' | 'info' | 'muted'; label: string } {
  const s = (state ?? '').toLowerCase()
  const label = STATE_LABELS[s] ?? s.replace(/_/g, ' ')
  if (['completed', 'published', 'done', 'pass', 'passed', 'success', 'final_view_published'].includes(s)) return { tone: 'ok', label }
  if (['running', 'analyzing', 'reviewing', 'finalizing', 'phase1_running', 'phase2_running', 'eval_running', 'sealing', 'leased'].includes(s)) return { tone: 'info', label }
  if (['failed', 'error', 'cancelled', 'dead_letter', 'invalid', 'blocked'].includes(s)) return { tone: 'danger', label }
  if (['paused', 'waiting_retry', 'retry', 'partial', 'waiting'].includes(s) || s.includes('pending')) return { tone: 'warn', label }
  if (['phase1_published', 'phase2_attached', 'archive_sealed', 'judging'].includes(s)) return { tone: 'violet', label }
  return { tone: 'muted', label: state ? label : 'unknown' }
}

export function StateBadge({ state }: { state: string | undefined }) {
  const t = toneFor(state)
  return <Status tone={t.tone} label={t.label} />
}

/**
 * An eval package's category is a snake_case identifier. Tables read better
 * with the words spaced out, and nothing else keys off the displayed text.
 */
export function CategoryChip({ value }: { value: string | null | undefined }) {
  return <span className="chip">{value ? value.replace(/_/g, ' ') : '—'}</span>
}

export function Mono({ children, copy }: { children: ReactNode; copy?: boolean }) {
  const [copied, setCopied] = useState(false)
  const text = String(children ?? '')
  const onClick = copy
    ? () => {
        void navigator.clipboard?.writeText(text).catch(() => undefined)
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      }
    : undefined
  return (
    <code className={`mono${copy ? ' mono-copy' : ''}`} onClick={onClick} title={copy ? (copied ? 'copied' : 'click to copy') : undefined}>
      {text}
    </code>
  )
}

export function Panel({ title, children, actions }: { title?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="panel">
      {title && (
        <div className="page-head" style={{ marginBottom: 'var(--s3)' }}>
          <h2>{title}</h2>
          {actions}
        </div>
      )}
      {children}
    </section>
  )
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="title">{title}</div>
      {children}
    </div>
  )
}

export function Banner({ tone, children }: { tone: 'danger' | 'warn' | 'ok' | 'platform'; children: ReactNode }) {
  return <div className={`banner ${tone}`}>{children}</div>
}

export function PageHead({ title, actions, sub }: { title: ReactNode; actions?: ReactNode; sub?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>{sub}</div>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  )
}

export function Modal({ title, open, onClose, children }: { title: string; open: boolean; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}
      onClick={onClose}
    >
      <div
        className="panel"
        style={{ minWidth: 420, maxWidth: '90vw', maxHeight: '85vh', overflow: 'auto', background: 'var(--surface)' }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="page-head" style={{ marginBottom: 'var(--s3)' }}>
          <h2>{title}</h2>
          <button onClick={onClose} aria-label="Close">×</button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </div>
  )
}

export function Tabs({ tabs, active, onChange }: { tabs: string[]; active: string; onChange: (t: string) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t} role="tab" aria-selected={t === active} className={t === active ? 'active' : ''} onClick={() => onChange(t)}>
          {t}
        </button>
      ))}
    </div>
  )
}

export function Spinner({ label }: { label?: string }) {
  return <span className="status muted"><span className="dot" />{label ?? 'loading…'}</span>
}
