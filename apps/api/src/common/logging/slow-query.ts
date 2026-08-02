import type Database from 'better-sqlite3';

/** Monitoring Architecture §7's example default ("generous for SQLite at
 * this data volume"); overridable per installation via
 * SLOW_QUERY_THRESHOLD_MS — D7-style placement so the Host phase's
 * Diagnostics UI can tune it without refactoring. */
export const SLOW_QUERY_DEFAULT_THRESHOLD_MS = 200;

const TIMED_METHODS = new Set(['run', 'get', 'all']);
const SQL_CONTEXT_MAX_LENGTH = 1000;

/**
 * Monitoring Architecture §7 — slow-query flagging. better-sqlite3 is
 * synchronous, so wrapping the three statement execution methods measures
 * true wall-clock duration with zero concurrency concerns. Any statement
 * slower than the threshold is reported with its SQL TEXT only — ruling
 * B4(a): parameter VALUES are never logged (the never-logged list is a
 * security requirement, ES §8).
 *
 * The wrapper is a transparent Proxy: every other property and method
 * (raw(), iterate(), bind(), columns(), ...) passes through untouched,
 * and timed methods preserve return values and exception behavior
 * exactly (R6 — the full existing suite runs through this wrapper as
 * the fidelity proof).
 */
export function instrumentSlowQueries(
  sqlite: Database.Database,
  onSlowQuery: (sqlText: string, durationMs: number) => void,
  thresholdMs: number = SLOW_QUERY_DEFAULT_THRESHOLD_MS,
): void {
  const originalPrepare = sqlite.prepare.bind(sqlite);

  (sqlite as { prepare: unknown }).prepare = (source: string) => {
    const statement = originalPrepare(source);
    return new Proxy(statement, {
      get(target, property, receiver) {
        if (typeof property === 'string' && TIMED_METHODS.has(property)) {
          return (...args: unknown[]) => {
            const start = performance.now();
            try {
              return (target as unknown as Record<string, (...a: unknown[]) => unknown>)[property]!(
                ...args,
              );
            } finally {
              const durationMs = performance.now() - start;
              if (durationMs > thresholdMs) {
                onSlowQuery(source.slice(0, SQL_CONTEXT_MAX_LENGTH), Math.round(durationMs));
              }
            }
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? (value as Function).bind(target) : value;
      },
    });
  };
}
