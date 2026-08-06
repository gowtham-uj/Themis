/**
 * Public API surface for the REST layer (P3c).
 */

export {
  createServer,
  createFixtureAdapter,
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
