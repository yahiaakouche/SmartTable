import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { openDatabase } from './connection';
import { LoggingModule } from '../common/logging/logging.module';
import { AppLogger } from '../common/logging/app-logger.service';

export const DRIZZLE_CLIENT = Symbol('DRIZZLE_CLIENT');

/**
 * Global module — every domain module (orders, employees, billing, ...)
 * injects DRIZZLE_CLIENT rather than opening its own connection. Repositories
 * (Engineering Standards §5) are the only place this token is ever injected;
 * services never receive it directly, preserving the Repository-behind-an-
 * interface boundary frozen since the Tech Stack decisions.
 */
@Global()
@Module({
  // LoggingModule joined in Step 3.13: the connection is opened with the
  // Monitoring §7 slow-query hook wired to the application logger.
  imports: [LoggingModule],
  providers: [
    {
      provide: DRIZZLE_CLIENT,
      inject: [ConfigService, AppLogger],
      useFactory: (config: ConfigService, appLogger: AppLogger) => {
        const filePath = config.getOrThrow<string>('DATABASE_FILE_PATH');
        const databaseLogger = appLogger.child('database');
        return openDatabase(filePath, {
          // §7/B4(a): SQL text only — parameter values never logged.
          onSlowQuery: (sqlText, durationMs) =>
            databaseLogger.warn('slow query', { sql: sqlText, durationMs }),
          slowQueryThresholdMs: config.get<number>('SLOW_QUERY_THRESHOLD_MS'),
        });
      },
    },
  ],
  exports: [DRIZZLE_CLIENT],
})
export class DatabaseModule {}
