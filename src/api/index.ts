/**
 * Public API surface for the REST layer (P3c).
 */

export {
  createServer,
  type AppCtx,
  type ApiServer,
  type CreateServerOptions,
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
