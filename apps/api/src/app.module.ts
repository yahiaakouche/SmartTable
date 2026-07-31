import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ResponseEnvelopeInterceptor } from './common/interceptors/response-envelope.interceptor';
import { IdempotencyInterceptor } from './common/idempotency/idempotency.interceptor';
import { IdempotencyModule } from './common/idempotency/idempotency.module';
import { EventsModule } from './common/events/events.module';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './modules/health/health.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { InvitationsModule } from './modules/invitations/invitations.module';
import { EmployeesModule } from './modules/employees/employees.module';
import { MenuModule } from './modules/menu/menu.module';
import { TablesModule } from './modules/tables/tables.module';
import { OrdersModule } from './modules/orders/orders.module';
import { BillingModule } from './modules/billing/billing.module';
import { RealtimeModule } from './common/realtime/realtime.module';
import { NotificationsModule } from './modules/notifications/notifications.module';

/**
 * Foundation composition for Phase 3. Domain modules attach here one at a
 * time in subsequent steps — this file is intentionally the only place that
 * changes as each new module comes online.
 *
 * Step 3.1 online: audit (append path), auth, invitations, employees — the
 * identity slice every later domain module depends on.
 * Step 3.2 online: menu, tables (+ the frozen internal event bus) — the
 * floor & catalog slice the orders domain builds on next.
 * Step 3.3 online: orders (+ idempotency infrastructure, ruling Q1) — the
 * order lifecycle up to Served.
 * Step 3.4 online: billing (payments + shifts + synchronous rollups) — the
 * lifecycle's financial end: Paid/Completed, bill-group close, table →
 * needs_cleaning.
 * Step 3.5 online: the real-time bridge — staff Socket.IO channel (Contract
 * §4), customer SSE stream (Contract §5, in the orders module), in-memory
 * presence events (B1), and the real-time health check (Monitoring §4).
 * Step 3.6 online: notifications (FR33) — event-driven creation as an
 * isolated bus side-effect (B5(a)), the two frozen REST routes, and
 * `notification.created` delivery through the existing bridge.
 */
@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    EventsModule,
    // Default throttling profile — Security Architecture §5 defines the
    // per-route-class overrides that individual controllers apply on top
    // of this global default as each of those controllers is built.
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 120 }]),
    AuditModule,
    AuthModule,
    InvitationsModule,
    EmployeesModule,
    MenuModule,
    TablesModule,
    OrdersModule,
    BillingModule,
    RealtimeModule,
    NotificationsModule,
    IdempotencyModule,
    HealthModule,
  ],
  providers: [
    // Global rate limiting (Security §5) — route classes override via
    // @Throttle; everything else gets the generous default above.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Idempotency (Contract §1, ruling Q1) must be the OUTERMOST interceptor:
    // it memoizes the exact enveloped body the client received, so replays
    // are byte-identical to the original response.
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    // Uniform success envelope { data, meta? } (API Contract Design §1).
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
  ],
})
export class AppModule {}
