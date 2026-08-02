import { MiddlewareConsumer, Module, NestModule, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AppLogger } from './app-logger.service';
import { CorrelationIdMiddleware } from './correlation-id.middleware';
import { RequestLoggingInterceptor } from './request-logging.interceptor';
import { LOG_RETENTION_DEFAULT_DAYS, runLogRetention } from './log-retention';

/**
 * Unified Application Logging (Monitoring Architecture §2/§3/§7,
 * Engineering Standards §8) — Step 3.13. Cross-cutting by design: the
 * correlation-ID middleware wraps every route (and logs the requests the
 * pipeline never reaches — guard rejections and unmatched 404s), the
 * interceptor logs every handled request's duration, and the retention
 * sweep runs once at startup. This
 * module writes Application Logs ONLY (system #1 of Monitoring §1) — it
 * never touches the Audit Log or Order Status Events, and nothing it
 * emits duplicates a fact recorded in either.
 */
@Module({
  providers: [AppLogger, { provide: APP_INTERCEPTOR, useClass: RequestLoggingInterceptor }],
  exports: [AppLogger],
})
export class LoggingModule implements NestModule, OnModuleInit {
  constructor(
    private readonly config: ConfigService,
    private readonly appLogger: AppLogger,
  ) {}

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }

  /** B1(a) — the §3 retention sweep at startup (daily files are the
   * rotation; deletion is the disk-growth mitigation). */
  async onModuleInit(): Promise<void> {
    const deleted = await runLogRetention(
      this.config.get<string>('LOG_DIRECTORY')!,
      this.config.get<number>('LOG_RETENTION_DAYS') ?? LOG_RETENTION_DEFAULT_DAYS,
    );
    if (deleted.length > 0) {
      this.appLogger
        .child('logging')
        .info(`log retention sweep removed ${deleted.length} expired file(s)`, { deleted });
    }
  }
}
