import { NotificationsListener } from './notifications.listener';
import { NotificationsService } from './notifications.service';
import { DOMAIN_EVENT, DomainEventsService } from '../../common/events/domain-events.service';
import { OrderStatus } from '@smarttable/shared-types';

/**
 * Unit tests for the B5(a) seam (Engineering Standards §10):
 *  - subscribes to exactly the four live trigger events (3.6's three, plus
 *    Step 3.9's backup.failed per ruling B5(a)),
 *  - forwards each event to the matching service method,
 *  - FAILURE ISOLATION: a failing handler is caught and logged, never
 *    propagated back into the bus emitter's call stack,
 *  - unsubscribes on destroy (no dangling listeners across app lifecycles).
 */
describe('NotificationsListener', () => {
  let listener: NotificationsListener;
  let events: jest.Mocked<DomainEventsService>;
  let service: jest.Mocked<NotificationsService>;
  const unsubscribes: jest.Mock[] = [];

  /** Captures the registered listeners so tests can invoke them directly. */
  const registered = new Map<string, (payload: unknown) => void>();

  beforeEach(() => {
    registered.clear();
    unsubscribes.length = 0;
    events = {
      on: jest.fn((event: string, handler: (payload: unknown) => void) => {
        registered.set(event, handler);
        const unsubscribe = jest.fn();
        unsubscribes.push(unsubscribe);
        return unsubscribe;
      }),
    } as unknown as jest.Mocked<DomainEventsService>;
    service = {
      notifyOrderCreated: jest.fn().mockResolvedValue(undefined),
      notifyOrderStatusChanged: jest.fn().mockResolvedValue(undefined),
      notifyInvitationAccepted: jest.fn().mockResolvedValue(undefined),
      notifyBackupFailed: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<NotificationsService>;
    listener = new NotificationsListener(events, service);
  });

  it('subscribes to exactly the four live trigger events on init (B2 + Step 3.9 B5(a))', () => {
    listener.onModuleInit();
    expect([...registered.keys()].sort()).toEqual(
      [DOMAIN_EVENT.INVITATION_ACCEPTED, DOMAIN_EVENT.ORDER_CREATED, DOMAIN_EVENT.ORDER_STATUS_CHANGED, DOMAIN_EVENT.BACKUP_FAILED].sort(),
    );
  });

  it('forwards each event to the matching service method', async () => {
    listener.onModuleInit();
    registered.get(DOMAIN_EVENT.ORDER_CREATED)!({ id: 'o1', tableId: 't1' });
    registered.get(DOMAIN_EVENT.ORDER_STATUS_CHANGED)!({ orderId: 'o1', fromStatus: 'preparing', toStatus: OrderStatus.READY });
    registered.get(DOMAIN_EVENT.INVITATION_ACCEPTED)!({ invitationId: 'i1', employeeId: 'e1' });
    registered.get(DOMAIN_EVENT.BACKUP_FAILED)!({ backupHistoryId: 'h1' });
    await new Promise((r) => setImmediate(r));

    expect(service.notifyOrderCreated).toHaveBeenCalledWith({ id: 'o1', tableId: 't1' });
    expect(service.notifyOrderStatusChanged).toHaveBeenCalledWith({ orderId: 'o1', fromStatus: 'preparing', toStatus: OrderStatus.READY });
    expect(service.notifyInvitationAccepted).toHaveBeenCalledWith({ invitationId: 'i1', employeeId: 'e1' });
    expect(service.notifyBackupFailed).toHaveBeenCalledWith({ backupHistoryId: 'h1' });
  });

  it('isolation: an async handler failure is swallowed — the bus emit never throws', async () => {
    service.notifyOrderCreated.mockRejectedValue(new Error('db gone'));
    listener.onModuleInit();
    const handler = registered.get(DOMAIN_EVENT.ORDER_CREATED)!;
    // Must not throw synchronously…
    expect(() => handler({ id: 'o1', tableId: 't1' })).not.toThrow();
    // …and the rejection must be handled (no unhandledRejection), giving the
    // catch block a turn to run.
    await new Promise((r) => setImmediate(r));
    expect(service.notifyOrderCreated).toHaveBeenCalledTimes(1);
  });

  it('onModuleDestroy unsubscribes every listener', () => {
    listener.onModuleInit();
    listener.onModuleDestroy();
    for (const unsubscribe of unsubscribes) expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
