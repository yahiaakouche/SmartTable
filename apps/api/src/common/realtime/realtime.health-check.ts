import { Injectable, OnModuleInit } from '@nestjs/common';
import { HealthCheck, HealthResult } from '../../modules/health/health-check.interface';
import { HealthRegistryService } from '../../modules/health/health-registry.service';
import { StaffRealtimeGateway } from './staff-realtime.gateway';
import { PresenceRegistry } from './presence-registry';

/**
 * Monitoring Architecture §4 — the "WebSocket/real-time channel" row of the
 * frozen Health Check Registry table ("Socket.IO server accepting
 * connections"). Registers itself into the deliberately open registry the
 * moment the module initializes (ruling D10), feeding both the Owner's
 * ambient indicator and the technical Diagnostics page.
 */
@Injectable()
export class RealtimeHealthCheck implements HealthCheck, OnModuleInit {
  readonly name = 'realtime';

  constructor(
    private readonly registry: HealthRegistryService,
    private readonly gateway: StaffRealtimeGateway,
    private readonly presence: PresenceRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async check(): Promise<HealthResult> {
    if (!this.gateway.isAttached()) {
      return { status: 'critical', detail: 'Socket.IO server is not attached to the HTTP server' };
    }
    return { status: 'healthy', detail: `${this.presence.connectionCount()} staff connection(s) online` };
  }
}
