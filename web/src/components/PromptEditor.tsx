import { useState, type KeyboardEvent, type SyntheticEvent } from 'react'

/**
 * A small markdown editor for project prompts. Monospace, wrapped, tab
 * inserts two spaces, Ctrl/Cmd-S saves. Line numbers in a wrapping editor
 * lie, so they stay in the status bar instead of a gutter.
 */
export function PromptEditor({
  value,
  onChange,
  onSave,
  disabled,
}: {
  value: string
  onChange: (next: string) => void
  onSave?: () => void
  disabled?: boolean
}) {
  const [caret, setCaret] = useState(0)
  const lines = value.length === 0 ? 1 : value.split('\n').length
  const before = value.slice(0, caret)
  const line = before.split('\n').length
  const col = (before.split('\n').at(-1) ?? '').length + 1

  function markCaret(e: SyntheticEvent<HTMLTextAreaElement>) {
    setCaret(e.currentTarget.selectionStart ?? 0)
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault()
      onSave?.()
      return
    }
    if (e.key !== 'Tab') return
    e.preventDefault()
    const el = e.currentTarget
    const start = el.selectionStart
    const end = el.selectionEnd
    const next = `${value.slice(0, start)}  ${value.slice(end)}`
    onChange(next)
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = start + 2
      setCaret(start + 2)
    })
  }

  return (
    <div className="prompt-editor">
      <textarea
        className="prompt-editor-text"
        spellCheck={false}
        disabled={disabled}
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
          setCaret(e.target.selectionStart ?? 0)
        }}
        onKeyDown={onKeyDown}
        onKeyUp={markCaret}
        onClick={markCaret}
        onSelect={markCaret}
        aria-label="Prompt text"
      />
      <div className="prompt-editor-status">
        <span>Ln {line}, Col {col}</span>
        <span>{value.length} chars</span>
        <span>{lines} lines</span>
        <span>Tab indents · Ctrl/Cmd-S saves</span>
      </div>
    </div>
  )
}
