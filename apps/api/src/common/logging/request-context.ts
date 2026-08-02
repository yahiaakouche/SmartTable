import { AsyncLocalStorage } from 'async_hooks';
import { v7 as uuidv7 } from 'uuid';

/**
 * Request-scoped correlation context — Engineering Standards §8: every log
 * line tied to a request carries a correlation ID "generated per HTTP
 * request", so one customer action can be traced across REST calls and
 * everything they trigger inside the process.
 *
 * AsyncLocalStorage is the mechanism: the ID rides the async execution
 * context instead of being threaded through every service signature
 * (which would touch every module in the system). Step 3.13 ruling B2(a):
 * HTTP requests only — WebSocket-event correlation is a compatible future
 * refinement, deliberately not built now.
 */
interface RequestContext {
  correlationId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Fallback for lines emitted OUTSIDE any request scope (bootstrap, the
 * startup retention sweep): one stable process-level ID, so all such
 * lines still group together instead of each inventing its own. */
const PROCESS_SCOPE_ID = uuidv7();

export function runWithCorrelationId<T>(correlationId: string, callback: () => T): T {
  return storage.run({ correlationId }, callback);
}

export function currentCorrelationId(): string {
  return storage.getStore()?.correlationId ?? PROCESS_SCOPE_ID;
}

/** Marker set by the request-logging interceptor once it has emitted a
 * request's §7 line. The correlation middleware's 'finish' fallback checks
 * it so requests rejected BEFORE the interceptor (guard 401/403/429) and
 * unmatched routes (Express 404) are logged exactly once too — never twice
 * (Monitoring §7: every request's duration in its log line). */
const REQUEST_LOGGED = Symbol('smarttable.requestLogged');

export function markRequestLogged(request: unknown): void {
  (request as Record<symbol, boolean>)[REQUEST_LOGGED] = true;
}

export function wasRequestLogged(request: unknown): boolean {
  return (request as Record<symbol, boolean>)[REQUEST_LOGGED] === true;
}
