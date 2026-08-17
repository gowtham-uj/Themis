/**
 * Watcher barrel.
 * The engine is the per-project agent-commit queue watcher: resolve commit,
 * dedupe, durable pending FIFO event, and launch the queue generation.
 */

export {
  applySemverFilter,
  computeDedupKey,
  globMatch,
  handleWatcherCommit,
  isSameRepo,
  matchRules,
  nextPendingForQueue,
  normalizeRepo,
  parseSemver,
  refMatches,
  repoMatches,
  shouldEnqueue,
  type RefResolver,
  type WatcherSeams,
} from "./engine.js";
