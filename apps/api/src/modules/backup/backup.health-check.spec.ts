import { BackupHealthCheck } from './backup.health-check';

/**
 * Unit tests for the backup-status health check (Step 3.12 ruling B3(a)/D4,
 * Monitoring §4's "age of last successful verified backup" row): the
 * fresh-install semantics (degraded, NEVER critical — R3), the 7-day
 * window boundary, the success-age rule ('failed' rows never affect the
 * result — they already notified at write time per 3.9 B5(a)), and the
 * critical path when the history itself is unreadable.
 */
describe('BackupHealthCheck', () => {
  let registry: { register: jest.Mock };

  const checkWith = (selectResult: Array<{ createdAt: number }> | Error) => {
    const limit = () => {
      if (selectResult instanceof Error) throw selectResult;
      return selectResult;
    };
    const db = {
      select: jest.fn(() => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit }) }) }) })),
    };
    registry = { register: jest.fn() };
    return new BackupHealthCheck(registry as never, db as never);
  };

  it('self-registers into the open registry on module init (the 3.5 D10 idiom)', async () => {
    const check = checkWith([]);
    expect(registry.register).not.toHaveBeenCalled();
    check.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(check);
    expect(check.name).toBe('backup');
  });

  it('no backup rows at all → degraded "no verified backup exists yet", never critical (fresh install)', async () => {
    await expect(checkWith([]).check()).resolves.toEqual({
      status: 'degraded',
      detail: 'no verified backup exists yet',
    });
  });

  it('a verified success within 7 days → healthy', async () => {
    const twoDaysAgo = Date.now() - 2 * 86_400_000;
    await expect(checkWith([{ createdAt: twoDaysAgo }]).check()).resolves.toEqual({
      status: 'healthy',
      detail: 'a verified backup exists within the last 7 days',
    });
  });

  it('the latest success older than 7 days → degraded with the age in days', async () => {
    const eightDaysAgo = Date.now() - 8 * 86_400_000;
    const result = await checkWith([{ createdAt: eightDaysAgo }]).check();
    expect(result.status).toBe('degraded');
    expect(result.detail).toBe('last verified backup is 8 day(s) old');
  });

  it('exactly 7 days old is still within the window (boundary)', async () => {
    const sevenDaysAgo = Date.now() - 7 * 86_400_000 + 60_000;
    await expect(checkWith([{ createdAt: sevenDaysAgo }]).check()).resolves.toMatchObject({ status: 'healthy' });
  });

  it('the history being unreadable is the ONLY critical path', async () => {
    const result = await checkWith(new Error('database is locked')).check();
    expect(result.status).toBe('critical');
    expect(result.detail).toMatch(/backup history unreadable: database is locked/);
  });
});
