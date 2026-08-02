import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ResponseEnvelopeInterceptor } from './common/interceptors/response-envelope.interceptor';
import { IdempotencyInterceptor } from './common/idempotency/idempotency.interceptor';
import { IdempotencyModule } from './common/idempotency/idempotency.module';
import { EventsModule } from './common/events/events.module';
import { LoggingModule } from './common/logging/logging.module';
import { ClientVersionGuard } from './common/client-version/client-version.guard';
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
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { BackupModule } from './modules/backup/backup.module';
import { RestaurantConfigModule } from './modules/config/restaurant-config.module';
import { SetupWizardModule } from './modules/setup-wizard/setup-wizard.module';

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
 * Step 3.7 online: analytics (FR41–FR43) — the read-only BI query layer
 * with the frozen live/rollup branching hidden in the service.
 * Step 3.8 online: the audit query surface (FR38 review capability) —
 * GET /audit-log with the four frozen filters and cursor pagination,
 * Owner/Manager only (B1).
 * Step 3.9 online: backup (FR13) — the verified-snapshot engine (VACUUM
 * INTO → integrity_check → history, trigger-agnostic per B6(a)), manual
 * create with optional passphrase encryption (B4(a)), history, and the
 * Owner's backup-failed notification (B5(a)). Restore, scheduling and
 * retention are the Host/Electron phase (B1(a)).
 * Step 3.10 online: config (branding/settings, FR31) — the restaurant
 * profile's management path: GET for all staff (D6), PATCH for the Owner
 * only (B1(a)) with the Security §6 logo pipeline, the post-commit
 * `restaurant_profile.changed` broadcast through the pre-wired bridge
 * (D7), and branding on the customer menu entry (B2(a)). Profile creation
 * stays with the future Setup Wizard (B3(a)).
 * Step 3.11 online: setup-wizard (FR15/FR16, PRD §1.2) — the one-time
 * public bootstrap: GET /setup/status and the atomic POST /setup/complete
 * (profile + "Main Hall" + Table 1..N with QR tokens + first Owner, one
 * transaction per B5(a)), guarded one-shot by SETUP_ALREADY_COMPLETED
 * (B1(a)). No tokens in the response — password-login issues device
 * trust. Only the Host-facing diagnostics module remains unserved (R1).
 * Step 3.12 online: the diagnostics API slice (Contract §3) — the
 * Monitoring §4 registry gains its disk-space (module-internal) and
 * backup-status (self-registering, the 3.5 D10 idiom) checks with frozen
 * B3(a) thresholds, and GET /diagnostics/resources serves live
 * CPU/memory/disk (B1(a) — the module's existing @Public exposure class).
 * /diagnostics/connected-devices and the printer/update checks stay with
 * their owning phases (B2(a)/B4(a)).
 * Step 3.13 online: unified application logging (Monitoring §2/§3/§7,
 * ES §8) — structured JSON-lines to LOG_DIRECTORY with the frozen
 * mandatory fields, per-request correlation IDs (B2(a): HTTP only) echoed
 * in X-Correlation-ID (B3(a)), duration lines for every request,
 * slow-query flagging at the connection (B4(a): SQL text only), daily
 * rotation with the 14-day retention sweep (B1(a)), and unexpected-error
 * lines with stack traces through the exception filter. Application Logs
 * stay strictly separate from the Audit Log (Monitoring §1).
 * Step 3.14 online: client/server version guard (API Contract §1) — a
 * global APP_GUARD, first in the chain, rejects any request whose
 * X-Client-Version differs from the running APP_VERSION with
 * 409 CLIENT_VERSION_STALE ("prompting a refresh" for cached customer QR
 * pages). Headerless requests pass unchecked (B3(a)); WebSocket is out of
 * scope by ruling. Its 409 lines ride the Step 3.13 middleware finish
 * fallback — no new logging, no audit duplication (Monitoring §1).
 */
@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    EventsModule,
    // Unified Application Logging (Monitoring §2/§3/§7) — correlation-ID
    // middleware on every route, per-request duration lines, and the
    // startup retention sweep. Step 3.13.
    LoggingModule,
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
    AnalyticsModule,
    BackupModule,
    RestaurantConfigModule,
    SetupWizardModule,
    IdempotencyModule,
    HealthModule,
  ],
  providers: [
    // Client/server version check (API Contract §1) — FIRST in the guard
    // chain (Step 3.14 ruling B5(a)): the cheapest possible rejection, so a
    // stale client (typically a cached customer QR page) is told to refresh
    // before throttling, auth, or any DB work runs. Headerless requests
    // pass unchecked (B3(a)).
    { provide: APP_GUARD, useClass: ClientVersionGuard },
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
