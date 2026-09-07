import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api, download, errText } from '../lib/api'
import type { ArchiveRow } from '../lib/types'
import { Banner, Empty, Mono, PageHead, Panel, Spinner, StateBadge } from '../components/ui'

interface ArchiveFile {
  path: string
  kind: 'file' | 'symlink'
  bytes: number
  sha256: string
  target?: string
}

interface ArchiveContents {
  archive: ArchiveRow
  files: ArchiveFile[]
  layers: string[]
  sealedAt: string | null
  resealedAt: string | null
  totalBytes: number
}

const PREFERRED_FILES = [
  'judge/evalJudge.yaml',
  'phase2/executive-brief.yaml',
  'eval_lifecycle_logs/run.json',
  'session/conversation.md',
  'eval_lifecycle_logs/events.jsonl',
]

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function previewable(path: string): boolean {
  return !/\.(zip|gz|png|jpe?g|gif|webp|pdf|sqlite|db|woff2?)$/i.test(path)
}

function runLabel(archive: ArchiveRow): string {
  return archive.runName || (archive.runOrdinal != null ? `Run ${archive.runOrdinal}` : archive.runId)
}

interface DirNode {
  name: string
  path: string
  dirs: DirNode[]
  files: ArchiveFile[]
  /** Files at or below this folder, so a closed folder still shows its weight. */
  count: number
}

/** Group flat manifest paths into a real directory tree at every depth. */
function buildTree(files: ArchiveFile[]): DirNode {
  const root: DirNode = { name: '', path: '', dirs: [], files: [], count: 0 }
  for (const file of files) {
    const parts = file.path.split('/')
    let node = root
    node.count += 1
    for (let i = 0; i < parts.length - 1; i += 1) {
      const path = parts.slice(0, i + 1).join('/')
      let child = node.dirs.find((dir) => dir.name === parts[i])
      if (!child) {
        child = { name: parts[i], path, dirs: [], files: [], count: 0 }
        node.dirs.push(child)
      }
      child.count += 1
      node = child
    }
    node.files.push(file)
  }
  const sort = (node: DirNode): void => {
    node.dirs.sort((a, b) => a.name.localeCompare(b.name))
    node.files.sort((a, b) => a.path.localeCompare(b.path))
    node.dirs.forEach(sort)
  }
  sort(root)
  return root
}

function allDirPaths(node: DirNode, into: Set<string> = new Set()): Set<string> {
  for (const dir of node.dirs) {
    into.add(dir.path)
    allDirPaths(dir, into)
  }
  return into
}

function FileTree({ node, depth, open, toggle, selected, onSelect }: {
  node: DirNode
  depth: number
  open: Set<string>
  toggle: (path: string) => void
  selected: string | null
  onSelect: (path: string) => void
}) {
  return (
    <>
      {node.dirs.map((dir) => {
        const isOpen = open.has(dir.path)
        return (
          <div key={dir.path} className="tree-dir">
            <button
              type="button"
              className="tree-folder"
              style={{ paddingLeft: `${depth * 14 + 10}px` }}
              aria-expanded={isOpen}
              onClick={() => toggle(dir.path)}
            >
              <span className={`tree-caret${isOpen ? ' open' : ''}`} aria-hidden="true">›</span>
              <span className="tree-name">{dir.name}</span>
              <small>{dir.count}</small>
            </button>
            {isOpen && (
              <FileTree node={dir} depth={depth + 1} open={open} toggle={toggle} selected={selected} onSelect={onSelect} />
            )}
          </div>
        )
      })}
      {node.files.map((file) => (
        <button
          type="button"
          key={file.path}
          className={`tree-file${file.path === selected ? ' active' : ''}`}
          style={{ paddingLeft: `${depth * 14 + 24}px` }}
          onClick={() => onSelect(file.path)}
        >
          <span className="tree-name">{file.path.split('/').pop()}</span>
          <small>{formatBytes(file.bytes)}</small>
        </button>
      ))}
    </>
  )
}

export default function ArchiveDetail() {
  const { runId } = useParams()
  const [selected, setSelected] = useState<string | null>(null)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const contents = useQuery({
    queryKey: ['archive-contents', runId],
    queryFn: () => api.get<ArchiveContents>(`/api/archives/${runId}/contents`),
    enabled: Boolean(runId),
    refetchInterval: (query) => query.state.data?.archive.phase.sealed === 'phase2' ? false : 4000,
  })

  useEffect(() => {
    if (!contents.data || selected) return
    const preferred = PREFERRED_FILES.find((path) => contents.data!.files.some((file) => file.path === path))
    setSelected(preferred ?? contents.data.files.find((file) => file.kind === 'file')?.path ?? null)
  }, [contents.data, selected])

  const file = useQuery({
    queryKey: ['archive-file', runId, selected],
    queryFn: () => api.text(`/api/archives/${runId}/file?path=${encodeURIComponent(selected!)}`),
    enabled: Boolean(runId && selected && previewable(selected)),
    retry: false,
  })

  const tree = useMemo(() => buildTree(contents.data?.files ?? []), [contents.data?.files])

  // Every folder starts closed except the chain leading to the selected file,
  // so a 177-file archive opens as a short list instead of a wall of paths.
  useEffect(() => {
    if (!selected) return
    setOpen((prev) => {
      const next = new Set(prev)
      const parts = selected.split('/')
      for (let i = 1; i < parts.length; i += 1) next.add(parts.slice(0, i).join('/'))
      return next
    })
  }, [selected])

  if (contents.isLoading) return <Spinner label="Opening archive…" />
  if (contents.isError) return <Banner tone="danger">Cannot open archive: {errText(contents.error)}</Banner>
  if (!contents.data) return <Empty title="Archive not found" />

  const archive = contents.data.archive
  const selectedFile = contents.data.files.find((item) => item.path === selected)
  const layer = archive.phase.sealed === 'phase2' ? 'Phase 2' : archive.phase.sealed === 'phase1' ? 'Phase 1' : 'Base'

  return (
    <>
      <div className="breadcrumbs" aria-label="Breadcrumb">
        <Link to="/archives">Archives</Link>
        <span>/</span>
        {archive.pipelineRunId ? <Link to={`/projects/${archive.projectId}/runs/${archive.pipelineRunId}`}>{runLabel(archive)}</Link> : <span>{runLabel(archive)}</span>}
        <span>/</span>
        <span>{archive.taskName || archive.runId}</span>
      </div>
      <PageHead
        title={archive.taskName || 'Eval archive'}
        sub={<span>{runLabel(archive)} · {archive.projectName || archive.projectId} · <Mono>{archive.runId}</Mono></span>}
        actions={<>
          {archive.pipelineRunId && <Link to={`/projects/${archive.projectId}/runs/${archive.pipelineRunId}`}><button>Run panel</button></Link>}
          <button className="primary" onClick={() => download(`/api/archives/${archive.runId}/download`)}>Download .tar.gz</button>
        </>}
      />

      <div className="summary-strip" aria-label="Archive summary">
        <div><span>Verifier</span><strong className={archive.reward == null ? '' : archive.reward === 1 ? 'verdict-pass' : 'verdict-fail'}>
          {archive.reward == null ? 'Not recorded' : archive.reward === 1 ? 'Passed' : 'Failed'}
        </strong></div>
        <div><span>Sealed view</span><strong>{layer}</strong></div>
        <div><span>Files</span><strong>{contents.data.files.length}</strong></div>
        <div><span>Size</span><strong>{formatBytes(contents.data.totalBytes)}</strong></div>
        <div><span>Agent</span><strong>{archive.agent.name || archive.agent.id || 'Unknown'}</strong></div>
      </div>

      <Panel title="Archive identity">
        <div className="archive-identity-grid">
          <div><span>Project</span><strong>{archive.projectName || archive.projectId}</strong></div>
          <div><span>Run</span><strong>{runLabel(archive)}</strong><Mono>{archive.pipelineRunId || 'not linked'}</Mono></div>
          <div><span>Eval execution</span><Mono copy>{archive.runId}</Mono></div>
          <div><span>Agent</span><strong>{archive.agent.name || archive.agent.id || 'Unknown'}</strong><Mono>{archive.agent.commit || 'no commit'}</Mono></div>
          <div><span>Model</span><strong>{archive.model || 'Default'}</strong><small>{archive.provider || 'default provider'}</small></div>
          <div><span>Status</span><StateBadge state={archive.status} /></div>
          <div><span>First sealed</span><time dateTime={contents.data.sealedAt ?? undefined}>{contents.data.sealedAt ? new Date(contents.data.sealedAt).toLocaleString() : '—'}</time></div>
          <div><span>Last resealed</span><time dateTime={contents.data.resealedAt ?? undefined}>{contents.data.resealedAt ? new Date(contents.data.resealedAt).toLocaleString() : 'Not resealed yet'}</time></div>
        </div>
        <div className="layer-history" aria-label="Archive layer history">
          <span className="layer done">Base evidence</span>
          <span className={`layer ${contents.data.layers.includes('judge') ? 'done' : ''}`}>Phase 1 · judge/ + phase1/</span>
          <span className={`layer ${contents.data.layers.includes('phase2') ? 'done' : ''}`}>Phase 2 · phase2/</span>
        </div>
      </Panel>

      <div className="archive-browser">
        <Panel
          title="Files"
          actions={
            <button
              onClick={() => setOpen((prev) => (prev.size === 0 ? allDirPaths(tree) : new Set()))}
            >
              {open.size === 0 ? 'Expand all' : 'Collapse all'}
            </button>
          }
        >
          <div className="file-tree">
            <FileTree
              node={tree}
              depth={0}
              open={open}
              toggle={(path) => setOpen((prev) => {
                const next = new Set(prev)
                if (!next.delete(path)) next.add(path)
                return next
              })}
              selected={selected}
              onSelect={setSelected}
            />
          </div>
        </Panel>

        <Panel
          title={selectedFile ? <Mono>{selectedFile.path}</Mono> : 'Preview'}
          actions={selectedFile ? <button onClick={() => download(`/api/archives/${archive.runId}/file?path=${encodeURIComponent(selectedFile.path)}`)}>Download file</button> : undefined}
        >
          {!selectedFile && <Empty title="Select a file" />}
          {selectedFile && !previewable(selectedFile.path) && (
            <Empty title="Preview unavailable">This file is binary. Download it to inspect the original bytes.</Empty>
          )}
          {selectedFile && previewable(selectedFile.path) && file.isLoading && <Spinner label="Reading file…" />}
          {selectedFile && previewable(selectedFile.path) && file.isError && <Banner tone="danger">Cannot preview this file: {errText(file.error)}</Banner>}
          {selectedFile && previewable(selectedFile.path) && file.data !== undefined && <pre className="code archive-preview">{file.data}</pre>}
        </Panel>
      </div>
    </>
  )
}
