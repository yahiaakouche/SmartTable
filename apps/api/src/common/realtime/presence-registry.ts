import { Injectable } from '@nestjs/common';

/**
 * In-memory staff presence — ADR-011 ("presence tracked in-memory only",
 * never persisted) and NFR11 (maintained via the same real-time channel as
 * order/table updates; no separate polling mechanism).
 *
 * Semantics (B1 ruling): an employee is ONLINE while at least one of their
 * sockets is connected — multi-device staff (terminal + tablet) stay online
 * until their LAST socket drops. `employee.presence_changed` is emitted by
 * the gateway only on transitions, never on every connect/disconnect.
 */
@Injectable()
export class PresenceRegistry {
  private readonly socketIdsByEmployee = new Map<string, Set<string>>();
  private readonly employeeIdBySocket = new Map<string, string>();

  /** Returns true when this socket brought the employee ONLINE (first socket). */
  register(employeeId: string, socketId: string): boolean {
    this.employeeIdBySocket.set(socketId, employeeId);
    let sockets = this.socketIdsByEmployee.get(employeeId);
    if (!sockets) {
      sockets = new Set();
      this.socketIdsByEmployee.set(employeeId, sockets);
    }
    const becameOnline = sockets.size === 0;
    sockets.add(socketId);
    return becameOnline;
  }

  /** Returns the owning employee and whether this socket took them OFFLINE
   * (their last socket), or null for a socket that was never registered
   * (e.g. a rejected handshake that disconnected before joining). */
  unregister(socketId: string): { employeeId: string; becameOffline: boolean } | null {
    const employeeId = this.employeeIdBySocket.get(socketId);
    if (!employeeId) return null;
    this.employeeIdBySocket.delete(socketId);
    const sockets = this.socketIdsByEmployee.get(employeeId);
    if (!sockets) return { employeeId, becameOffline: true };
    sockets.delete(socketId);
    if (sockets.size === 0) {
      this.socketIdsByEmployee.delete(employeeId);
      return { employeeId, becameOffline: true };
    }
    return { employeeId, becameOffline: false };
  }

  isOnline(employeeId: string): boolean {
    return this.socketIdsByEmployee.has(employeeId);
  }

  /** Live socket count across all employees — health-check detail (D10). */
  connectionCount(): number {
    return this.employeeIdBySocket.size;
  }
}
