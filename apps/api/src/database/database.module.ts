import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { openDatabase } from './connection';

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
  providers: [
    {
      provide: DRIZZLE_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const filePath = config.getOrThrow<string>('DATABASE_FILE_PATH');
        return openDatabase(filePath);
      },
    },
  ],
  exports: [DRIZZLE_CLIENT],
})
export class DatabaseModule {}
