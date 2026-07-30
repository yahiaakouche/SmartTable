import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './modules/health/health.module';

/**
 * Foundation composition for Phase 3, Step 3.0. Domain modules (auth,
 * employees, tables, orders, billing, menu, analytics, ...) attach here
 * one at a time in subsequent steps — this file is intentionally the only
 * place that changes as each new module comes online.
 */
@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    // Default throttling profile — Security Architecture §5 defines the
    // per-route-class overrides that individual controllers apply on top
    // of this global default as each of those controllers is built.
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 120 }]),
    HealthModule,
  ],
})
export class AppModule {}
