import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { appendFile, mkdir } from 'fs/promises';
import * as path from 'path';
import { currentCorrelationId } from './request-context';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * The Unified Application Logging writer (Monitoring Architecture §2,
 * Engineering Standards §8) — structured JSON lines, one event per line,
 * machine-parseable by the Host's future Diagnostics page without any
 * parsing library. Every line carries the frozen mandatory fields:
 * timestamp (epoch ms), level, module, correlationId, message — plus an
 * optional context object (stack traces ride inside it, keeping the top
 * level exactly the frozen shape).
 *
 * Daily-file naming (`app-YYYY-MM-DD.log`) IS the §3 rotation; the 14-day
 * retention sweep lives in log-retention.ts (B1(a): compression deferred —
 * deletion is the real disk-growth mitigation).
 *
 * Two hard rules baked in here:
 *  - Logging must NEVER break the product (R1): any write failure
 *    degrades to the console and is otherwise swallowed — a full disk is
 *    precisely when the disk-space health check already speaks.
 *  - The never-logged list (ES §8) is enforced by the callers, not here:
 *    no body logging, no parameter values, identifiers only.
 */
@Injectable()
export class AppLogger {
  private directoryReady: Promise<unknown> | null = null;

  /** NOT a constructor parameter: Nest must resolve exactly one dependency
   * (ConfigService); the module stamp is carried as an internal field that
   * only child() sets (the root instance is stamped 'app'). */
  private moduleName = 'app';

  constructor(private readonly config: ConfigService) {}

  /** A logger sharing this one's configuration but stamped with a
   * different `module` field (§2: "which NestJS module emitted it"). */
  child(moduleName: string): AppLogger {
    const childLogger = new AppLogger(this.config);
    childLogger.moduleName = moduleName;
    return childLogger;
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.write('debug', message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.write('info', message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.write('warn', message, context);
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.write('error', message, context);
  }

  private write(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    const minimum = (this.config.get<string>('LOG_LEVEL') ?? 'info') as LogLevel;
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[minimum]) return;

    const line =
      JSON.stringify({
        timestamp: Date.now(),
        level,
        module: this.moduleName,
        correlationId: currentCorrelationId(),
        message,
        ...(context !== undefined ? { context } : {}),
      }) + '\n';

    const filePath = path.join(this.logDirectory(), this.currentFileName());
    this.ensureDirectory()
      .then(() => appendFile(filePath, line))
      .catch((error: unknown) => {
        // R1 — degrade to the console, never to a thrown error. The
        // original line is preserved there so nothing is silently lost
        // (ES §7 — no silent catches).
        // eslint-disable-next-line no-console
        console.error(`[AppLogger] file write failed (${error instanceof Error ? error.message : error}):`, line);
      });
  }

  private logDirectory(): string {
    return this.config.get<string>('LOG_DIRECTORY')!;
  }

  /** Local restaurant date — the installation's own clock is the honest
   * frame for a daily file (R4: a request spanning midnight lands in the
   * file of its emission date). */
  private currentFileName(): string {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    return `app-${yyyy}-${mm}-${dd}.log`;
  }

  private ensureDirectory(): Promise<unknown> {
    this.directoryReady ??= mkdir(this.logDirectory(), { recursive: true });
    return this.directoryReady;
  }
}
