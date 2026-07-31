import { Module } from '@nestjs/common';
import { AuthModule } from '../../modules/auth/auth.module';
import { HealthModule } from '../../modules/health/health.module';
import { StaffRealtimeGateway } from './staff-realtime.gateway';
import { PresenceRegistry } from './presence-registry';
import { RealtimeHealthCheck } from './realtime.health-check';

/**
 * Step 3.5 — the real-time bridge. Cross-cutting infrastructure (ruling D1),
 * placed beside common/events like the other process-wide seams. Domain
 * modules keep emitting on the internal bus exactly as they did in Steps
 * 3.2–3.4; this module subscribes and owns everything transport-facing:
 * the staff Socket.IO gateway, in-memory presence (ADR-011), and the
 * real-time health check (Monitoring §4).
 *
 * The customer SSE channel lives with its owning domain instead — the
 * stream endpoint is a public orders route (Contract §3/§5).
 */
@Module({
  imports: [AuthModule, HealthModule],
  providers: [StaffRealtimeGateway, PresenceRegistry, RealtimeHealthCheck],
  exports: [PresenceRegistry],
})
export class RealtimeModule {}
