/**
 * Public API surface for the REST layer (P3c).
 */

export {
  createServer,
  createLiveRunsMap,
  isTerminalStatus,
  startRun,
  pauseRun,
  resumeRun,
  abortRun,
  setNetwork,
  type AppCtx,
  type ApiServer,
  type CreateServerOptions,
  type LiveRun,
  type LiveRunsMap,
  type StartRunOptions,
} from "./server.js";

export {
  Router,
  createRouter,
  parseQuery,
  readBody,
  readJsonBody,
  sendJson,
  type RequestContext,
  type RouteHandler,
} from "./router.js";

export {
  apiError,
  handleError,
  HttpError,
  notFound,
  badRequest,
  conflict,
  methodNotAllowed,
  type ProblemDetails,
  type ApiErrorInput,
} from "./errors.js";

export {
  registerJudgementRoutes,
  type JudgeRunner,
  type JudgeRunContext,
  type CreateJudgementBody,
  type JudgementAppCtx,
} from "./judgements-routes.js";

export {
  extractBearer,
  hashToken,
  generatePlaintextToken,
  verifyToken,
  authMiddleware,
  gateRequest,
  getRequestAuth,
  setRequestAuth,
  isPublicApiPath,
  isLoopbackAddress,
  type AuthInfo,
  type AuthMiddlewareOpts,
} from "./auth.js";

export {
  withIdempotency,
  dedupStore,
  IdempotencyStore,
  header as readHeader,
  idempotencyStoreKey,
  IDEMPOTENCY_MAX_SIZE,
  IDEMPOTENCY_TTL_MS,
  type IdempotencyEntry,
  type IdempotencyMapLike,
} from "./middleware.js";
