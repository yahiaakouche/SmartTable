import { Logger, OnModuleInit } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import {
  EmployeePresenceChangedEventPayload,
  EmployeeRole,
  OWNER_ROOM,
  OWNER_ROOM_ROLES,
  RESTAURANT_BROADCAST_ROOM,
  STAFF_EVENT,
  employeeRoom,
  roleRoom,
} from '@smarttable/shared-types';
import { DOMAIN_EVENT, DomainEventsService } from '../events/domain-events.service';
import { TokensService } from '../../modules/auth/tokens.service';
import { PresenceRegistry } from './presence-registry';
import { routeStaffEvent } from './staff-event-router';

/**
 * The staff real-time bridge (API Contract Design §4; ADR-006: Socket.IO,
 * no Redis). Cross-cutting infrastructure, deliberately NOT a business
 * module — the single handshake/auth/room oracle for every domain's events
 * (ruling D1; Engineering Standards §2's per-domain gateway sketch is
 * illustrative, and duplicating security logic across domains would be the
 * worse outcome).
 *
 * Rulings implemented here:
 *  - D2: JWT in `handshake.auth.token`, verified via TokensService (same
 *    key, `type === 'access'`, fresh isActive reload). Rooms are assigned
 *    server-side from the verified identity — never client-claimed. Failed
 *    handshakes are disconnected and app-logged (D13).
 *  - D3: server→client only. There are intentionally no @SubscribeMessage
 *    handlers — all mutations stay REST, so guards/pipes/throttler semantics
 *    are unchanged (they do not run on connection lifecycle hooks).
 *  - D4: auth is evaluated at handshake only; a connected socket survives
 *    token expiry until it disconnects (mirrors JWT semantics; every event's
 *    content is already visible to that role via REST). After reconnect,
 *    clients refetch current state via REST — there is no replay buffer.
 *  - B1(a): `employee.presence_changed` originates HERE — the gateway is the
 *    only component that can know connect/disconnect truth.
 *  - B2: owner-room membership = Owner + Manager.
 *
 * Transport security (Security §3 `wss://`) is enforced by the Electron
 * Host's HTTPS termination, exactly like the REST channel (see main.ts).
 */
@WebSocketGateway()
export class StaffRealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit {
  @WebSocketServer() server!: Server;
  private readonly logger = new Logger(StaffRealtimeGateway.name);

  constructor(
    private readonly events: DomainEventsService,
    private readonly tokens: TokensService,
    private readonly presence: PresenceRegistry,
  ) {}

  /** Subscribes the bridge to the frozen internal bus (Contract §1). Every
   * domain event is already post-commit by the bus's binding rule, so what
   * leaves this gateway can never describe an uncommitted state (§4). */
  onModuleInit(): void {
    for (const event of Object.values(DOMAIN_EVENT)) {
      this.events.on(event, (payload) => this.routeToRooms(event, payload));
    }
  }

  private routeToRooms(event: string, payload: unknown): void {
    if (!this.server) return; // adapter not attached yet (early test emission)
    for (const emission of routeStaffEvent(event, payload)) {
      this.server.to(emission.rooms).emit(event, emission.payload);
      this.logger.debug(`Emitted ${event} → [${emission.rooms.join(', ')}]`);
    }
  }

  async handleConnection(client: Socket): Promise<void> {
    const token = (client.handshake.auth as Record<string, unknown> | undefined)?.['token'];
    if (typeof token !== 'string' || token.length === 0) {
      this.logger.warn(`Rejected unauthenticated staff socket from ${client.handshake.address}`);
      client.disconnect(true);
      return;
    }

    let identity: { id: string; name: string; role: string };
    try {
      identity = await this.tokens.verifyAccessToken(token);
    } catch {
      this.logger.warn(`Rejected staff socket with invalid or expired token from ${client.handshake.address}`);
      client.disconnect(true);
      return;
    }

    const role = identity.role as EmployeeRole;
    const rooms = [roleRoom(role), employeeRoom(identity.id), RESTAURANT_BROADCAST_ROOM];
    if (OWNER_ROOM_ROLES.includes(role)) rooms.push(OWNER_ROOM); // B2
    await client.join(rooms);

    // The socket may have dropped while the async verification was in flight.
    if (!client.connected) return;

    const becameOnline = this.presence.register(identity.id, client.id);
    if (becameOnline) {
      this.emitPresenceChanged({ employeeId: identity.id, online: true });
    }
    this.logger.debug(
      `Staff socket connected: employee ${identity.id} (${role}) — ${this.presence.connectionCount()} connection(s) online`,
    );
  }

  handleDisconnect(client: Socket): void {
    const result = this.presence.unregister(client.id);
    if (result?.becameOffline) {
      this.emitPresenceChanged({ employeeId: result.employeeId, online: false });
    }
  }

  /** B1 ruling — presence events are born at the transport layer and go to
   * owner-room only (Contract §4). */
  private emitPresenceChanged(payload: EmployeePresenceChangedEventPayload): void {
    if (!this.server) return;
    this.server.to(OWNER_ROOM).emit(STAFF_EVENT.EMPLOYEE_PRESENCE_CHANGED, payload);
  }

  /** Monitoring Architecture §4 — "Socket.IO server accepting connections". */
  isAttached(): boolean {
    return !!this.server;
  }
}
