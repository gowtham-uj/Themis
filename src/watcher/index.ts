/**
 * Watcher package barrel (P8a foundation).
 * Engine is pure-ish: QueryStore + RefResolver seams; no HTTP/UI.
 */

export {
  applySemverFilter,
  computeDedupKey,
  globMatch,
  handleWatcherEvent,
  matchRules,
  normalizeRepo,
  parseSemver,
  refMatches,
  repoMatches,
  shouldEnqueue,
  type HandleWatcherEventResult,
  type RefResolver,
  type WatcherInboundEvent,
} from "./engine.js";
