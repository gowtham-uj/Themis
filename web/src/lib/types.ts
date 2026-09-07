export interface Project {
  id: string
  name: string
  slug?: string
  description?: string | null
  default_agent_id?: string | null
  /** The agent the project's queue will actually launch; falls back to default_agent_id. */
  resolved_agent_id?: string | null
  default_model?: string | null
  default_provider?: string | null
  network_policy?: string
  /** Enabled evals required before runs, Phase 1, or Phase 2 may start. */
  min_evals?: number
  archived?: boolean
  created_at?: string
  /** Per-stage model provider overrides; null when the project inherits the global config. */
  model_config?: Record<string, Record<string, unknown>> | null
  /** Project copies of Phase 1 / Phase 2 prompts, keyed by filename. */
  prompt_config?: Record<string, string> | null
}

export interface Adapter {
  id: string
  agentId?: string
  agent_id?: string
  name?: string
  generator?: string
  sourceRepo?: string
  sourceRef?: string
  sourceCommit?: string
  installType?: string
  install_type?: string
  image?: string
  defaultProvider?: string
  default_model?: string
  defaultModel?: string
  status?: string
  built?: boolean
  projectId?: string
}

/** One selectable agent build returned by GET .../adapters/:id/versions. */
export interface AdapterVersion {
  id: string
  adapter_id?: string
  commit?: string | null
  version?: string
  status?: string
  image?: string | null
  image_id?: string | null
  error?: string | null
  created_at?: string
  completed_at?: string | null
  builtin?: boolean
}

export interface EvalTask {
  id: string
  name?: string
  categoryName?: string
  category_name?: string
  language?: string
  prompt?: string
  version?: string
  archived?: boolean
  createdAt?: string
  [k: string]: unknown
}

export interface EvalQueue {
  id: string
  projectId?: string
  name?: string
  agentId?: string
  model?: string
  provider?: string
  status?: string
  sharedAdapterId?: string
  builtinAdapterId?: string
  networkPolicy?: string
  revision?: number
  createdAt?: string
  description?: string | null
  agentCommit?: string | null
  ports?: unknown[]
  sandbox?: Record<string, unknown> | null
  adapterOverrides?: Record<string, unknown> | null
}

export interface PipelineQueue {
  id: string
  projectId?: string
  evalQueueId?: string
  name?: string
  status?: string
  revision: number
  autoEval?: boolean
  autoPhase1?: boolean
  autoPhase2?: boolean
}

export interface QueueItem {
  id: string
  taskId?: string
  position?: number
  repeats?: number
  enabled?: boolean
  claimedRepeats?: number
}

export interface Run {
  id: string
  projectId?: string
  queueId?: string
  taskId?: string
  status?: string
  error?: string | null
  agentId?: string
  model?: string
  officialReward?: number | null
  verdict?: unknown
  startedAt?: string
  completedAt?: string
  [k: string]: unknown
}

export interface JudgeJob {
  id: string
  runId?: string
  state?: string
  currentNode?: string
  currentRound?: number
  attemptCount?: number
  leaseOwner?: string | null
  priority?: number
  [k: string]: unknown
}

export interface Generation {
  id: string
  state?: string
  queueId?: string
  ordinal?: number
  name?: string | null
  createdAt?: string
  updatedAt?: string
  completedAt?: string | null
}

export interface PipelineRunSummary extends Generation {
  evals: number
  archives: number
  completedEvals: number
}

export interface ArchivePhaseState {
  sealed: 'base' | 'phase1' | 'phase2'
  phase1: { trackId: string; resultVersionId: string; sealedAt: string } | null
  phase2: { campaignId: string; state: string; memberCount: number; publishedAt: string | null } | null
}

export interface ArchiveRow {
  runId: string
  pipelineRunId: string | null
  runName: string | null
  runOrdinal: number | null
  projectId: string
  projectName: string | null
  taskId: string
  taskName: string | null
  agent: { id: string | null; name: string | null; commit: string | null; image: string | null }
  model: string
  provider: string
  status: string
  reward: number | null
  sealedAt: string | null
  archivedAt: string
  phase: ArchivePhaseState
}

export interface PipelineItem {
  id: string
  evalId?: string
  ordinal?: number
  state?: string
  runId?: string | null
  retryCount?: number
  errorKind?: string | null
  errorDetail?: string | null
  phase1ResultVersionId?: string | null
  finalArchiveViewId?: string | null
}

export interface Campaign {
  id: string
  state?: string
  projectId?: string
  sutFingerprint?: string
  publishedAt?: string | null
}

export interface PiSubagent {
  agent?: string
  exitCode?: number | null
  turns?: number | null
  file?: string
}

export interface PiStatus {
  campaignId: string
  workDir: string
  resumable: boolean
  running: boolean
  filed: string[]
  subagents: PiSubagent[]
  session: string | null
}
