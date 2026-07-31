import { PinLockoutService, PIN_MAX_CONSECUTIVE_FAILURES } from './pin-lockout.service';

/**
 * Security Architecture §1 — 5 consecutive failures lock the account with an
 * escalating cooldown (1 → 5 → 15 minutes per episode). These rules protect
 * the fast daily terminal login; a silent bug here either locks staff out
 * mid-service or lets a PIN be brute-forced.
 */
describe('PinLockoutService', () => {
  let service: PinLockoutService;
  const EMPLOYEE = 'employee-1';

  beforeEach(() => {
    service = new PinLockoutService();
  });

  const fail = (times: number, now: number): number | null => {
    let lock: number | null = null;
    for (let i = 0; i < times; i++) lock = service.recordFailure(EMPLOYEE, now);
    return lock;
  };

  it('does not lock before the 5th consecutive failure', () => {
    expect(fail(PIN_MAX_CONSECUTIVE_FAILURES - 1, 0)).toBeNull();
    expect(service.getLockRemainingMs(EMPLOYEE, 0)).toBe(0);
  });

  it('locks for 1 minute on the 5th consecutive failure', () => {
    expect(fail(PIN_MAX_CONSECUTIVE_FAILURES, 0)).toBe(60_000);
    expect(service.getLockRemainingMs(EMPLOYEE, 0)).toBe(60_000);
    expect(service.getLockRemainingMs(EMPLOYEE, 30_000)).toBe(30_000);
    expect(service.getLockRemainingMs(EMPLOYEE, 60_001)).toBe(0);
  });

  it('escalates the cooldown 1 → 5 → 15 minutes across lockout episodes', () => {
    const t0 = 0;
    fail(5, t0); // first episode: 1 min
    const t1 = t0 + 60_001;
    expect(fail(5, t1)).toBe(5 * 60_000); // second episode: 5 min
    const t2 = t1 + 5 * 60_000 + 1;
    expect(fail(5, t2)).toBe(15 * 60_000); // third episode: 15 min
    const t3 = t2 + 15 * 60_000 + 1;
    expect(fail(5, t3)).toBe(15 * 60_000); // capped at the top rung
  });

  it('resets the failure count on a successful login', () => {
    fail(4, 0);
    service.recordSuccess(EMPLOYEE);
    expect(fail(4, 1_000)).toBeNull(); // 4 more without reaching 5
    expect(fail(1, 2_000)).toBe(60_000);
  });

  it('tracks lockouts independently per employee', () => {
    fail(5, 0);
    expect(service.getLockRemainingMs(EMPLOYEE, 0)).toBe(60_000);
    expect(service.getLockRemainingMs('employee-2', 0)).toBe(0);
  });
});
