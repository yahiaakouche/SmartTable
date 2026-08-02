import { DrizzleSetupWizardRepository, SetupCompletionWrite } from './setup-wizard.repository';
import { SetupAlreadyCompletedException } from '../../common/exceptions/domain.exception';

/**
 * Unit tests for the wizard repository's atomic transaction (Step 3.11
 * ruling B5(a)): the in-transaction one-shot guard (B1(a)/D5), the
 * whole-batch retry on a qr_token unique violation (R5) with the same
 * 3-attempt ceiling as TablesService, and the strict rule that ONLY a
 * qr_token collision is ever retried (ES §7). The Drizzle client is
 * mocked at the transaction boundary; the real-SQLite atomicity proof
 * lives in the integration suite.
 */
describe('DrizzleSetupWizardRepository', () => {
  const write = (tableCount = 2): SetupCompletionWrite => ({
    profile: {
      name: 'Restaurant El Djazair',
      logoPath: null,
      primaryColor: '#112233',
      secondaryColor: '#ddeeff',
      currencyCode: 'DZD',
      defaultLanguage: 'ar',
      setupCompletedAt: 5000,
    },
    hall: { name: 'Main Hall', sortOrder: 0 },
    tables: Array.from({ length: tableCount }, (_, index) => ({ label: `Table ${index + 1}` })),
    owner: { name: 'Karim', passwordHash: 'pw-hash', pinHash: 'pin-hash' },
  });

  const qrCollision = () => new Error('UNIQUE constraint failed: tables.qr_token');

  /** A minimal synchronous stand-in for the better-sqlite3 transaction
   * handle: select().from().limit().all() and insert().values().returning().all(). */
  const mockDb = (options: { existingProfile?: boolean; insertBehavior?: (call: number) => unknown } = {}) => {
    const inserted: Array<{ table: unknown; row: unknown }> = [];
    let insertCalls = 0;
    const tx = {
      select: jest.fn(() => ({
        from: () => ({ limit: () => ({ all: () => (options.existingProfile ? [{ id: 'p0' }] : []) }) }),
      })),
      insert: jest.fn((table: unknown) => ({
        values: (row: unknown) => ({
          returning: () => ({
            all: () => {
              insertCalls += 1;
              if (options.insertBehavior) {
                const outcome = options.insertBehavior(insertCalls);
                if (outcome instanceof Error) throw outcome;
              }
              inserted.push({ table, row });
              return [{ id: `row-${insertCalls}`, ...(row as object) }];
            },
          }),
        }),
      })),
    };
    const db = { transaction: jest.fn((callback: (tx: unknown) => unknown) => callback(tx)) };
    return { db, tx, inserted };
  };

  it('B1(a)/D5 — an existing profile row aborts inside the transaction before ANY insert', async () => {
    const { db, tx } = mockDb({ existingProfile: true });
    const repository = new DrizzleSetupWizardRepository(db as never);

    await expect(repository.completeTransaction(write())).rejects.toBeInstanceOf(SetupAlreadyCompletedException);
    expect((await repository.completeTransaction(write()).catch((e) => e)).code).toBe('SETUP_ALREADY_COMPLETED');
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it('happy path: profile + hall + N tables + owner insert in ONE transaction, each table with a fresh 256-bit QR token', async () => {
    const { db, tx, inserted } = mockDb();
    const repository = new DrizzleSetupWizardRepository(db as never);

    const result = await repository.completeTransaction(write(3));

    expect(db.transaction).toHaveBeenCalledTimes(1);
    // 1 profile + 1 hall + 3 tables + 1 owner.
    expect(tx.insert).toHaveBeenCalledTimes(6);
    expect(inserted[2]!.row).toMatchObject({ label: 'Table 1' });
    const tokens = inserted.slice(2, 5).map((entry) => (entry.row as { qrToken: string }).qrToken);
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes, base64url
    expect(new Set(tokens).size).toBe(3);
    expect(inserted[5]!.row).toMatchObject({ name: 'Karim', role: 'owner', email: null, passwordHash: 'pw-hash', pinHash: 'pin-hash' });
    expect(result.owner).toMatchObject({ role: 'owner' });
    expect(result.tables).toHaveLength(3);
  });

  it('R5 — a qr_token collision retries the ENTIRE batch with fresh tokens', async () => {
    let attempt = 0;
    const { db, tx } = mockDb({
      insertBehavior: () => {
        // First attempt dies on the first table insert; the retry succeeds.
        attempt += 1;
        return attempt === 2 ? qrCollision() : undefined;
      },
    });
    const repository = new DrizzleSetupWizardRepository(db as never);

    const result = await repository.completeTransaction(write());
    expect(db.transaction).toHaveBeenCalledTimes(2);
    expect(result.tables).toHaveLength(2);
    expect(tx.insert).toHaveBeenCalledTimes(2 + 5); // aborted attempt + full retry
  });

  it('only a qr_token collision is retried — any other error propagates immediately (ES §7)', async () => {
    const diskError = new Error('disk I/O error');
    const { db } = mockDb({ insertBehavior: () => diskError });
    const repository = new DrizzleSetupWizardRepository(db as never);

    await expect(repository.completeTransaction(write())).rejects.toBe(diskError);
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it('three consecutive collisions surface the failure rather than looping forever', async () => {
    const { db } = mockDb({ insertBehavior: () => qrCollision() });
    const repository = new DrizzleSetupWizardRepository(db as never);

    const failure = await repository.completeTransaction(write()).catch((error: unknown) => error);
    expect((failure as Error).message).toMatch(/UNIQUE constraint failed: tables\.qr_token/);
    expect(db.transaction).toHaveBeenCalledTimes(3);
  });
});
