import { PresenceRegistry } from './presence-registry';

/**
 * In-memory presence semantics (ADR-011, NFR11, B1 ruling): online on the
 * FIRST socket, offline on the LAST socket; multi-device employees stay
 * online while any device is connected.
 */
describe('PresenceRegistry', () => {
  let registry: PresenceRegistry;

  beforeEach(() => {
    registry = new PresenceRegistry();
  });

  it('first socket brings the employee online; last socket takes them offline', () => {
    expect(registry.register('emp-1', 'sock-1')).toBe(true);
    expect(registry.isOnline('emp-1')).toBe(true);
    const result = registry.unregister('sock-1');
    expect(result).toEqual({ employeeId: 'emp-1', becameOffline: true });
    expect(registry.isOnline('emp-1')).toBe(false);
  });

  it('a second socket for the same employee is NOT a new online transition', () => {
    expect(registry.register('emp-1', 'sock-1')).toBe(true);
    expect(registry.register('emp-1', 'sock-2')).toBe(false);
    expect(registry.isOnline('emp-1')).toBe(true);
  });

  it('disconnecting one of two sockets keeps the employee online (multi-device)', () => {
    registry.register('emp-1', 'sock-1');
    registry.register('emp-1', 'sock-2');
    const first = registry.unregister('sock-1');
    expect(first).toEqual({ employeeId: 'emp-1', becameOffline: false });
    expect(registry.isOnline('emp-1')).toBe(true);
    const last = registry.unregister('sock-2');
    expect(last).toEqual({ employeeId: 'emp-1', becameOffline: true });
    expect(registry.isOnline('emp-1')).toBe(false);
  });

  it('tracks employees independently', () => {
    registry.register('emp-1', 'sock-1');
    registry.register('emp-2', 'sock-2');
    registry.unregister('sock-1');
    expect(registry.isOnline('emp-1')).toBe(false);
    expect(registry.isOnline('emp-2')).toBe(true);
  });

  it('unregistering an unknown socket returns null (rejected handshakes)', () => {
    expect(registry.unregister('never-registered')).toBeNull();
  });

  it('counts live connections across all employees', () => {
    expect(registry.connectionCount()).toBe(0);
    registry.register('emp-1', 'sock-1');
    registry.register('emp-1', 'sock-2');
    registry.register('emp-2', 'sock-3');
    expect(registry.connectionCount()).toBe(3);
    registry.unregister('sock-2');
    expect(registry.connectionCount()).toBe(2);
  });
});
