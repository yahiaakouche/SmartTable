import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '../../config/config.module';
import { DatabaseModule, DRIZZLE_CLIENT } from '../../database/database.module';
import { auditLog } from '../../database/schema';
import { AuditModule } from './audit.module';
import { AuditService } from './audit.service';
import { AUDIT_REPOSITORY, AuditRepository } from './audit.repository';
import { openIsolatedTestDb } from '../../../test/helpers/test-db';
import { createTestApp, getDb } from '../../../test/helpers/test-app';

/**
 * Integration: audit module against a real, migrated SQLite database
 * (Engineering Standards §10 — mandatory for every module that touches
 * persistence). Verifies the append path works AND that the append-only
 * guarantee (NFR16) holds structurally.
 */
describe('AuditModule (integration)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const db = await openIsolatedTestDb();
    app = await createTestApp(
      Test.createTestingModule({ imports: [ConfigModule, DatabaseModule, AuditModule] })
        .overrideProvider(DRIZZLE_CLIENT)
        .useValue(db),
    );
  });

  afterEach(async () => {
    await app.close();
  });

  it('appends an entry retrievable from the audit_log table', async () => {
    const service = app.get(AuditService);
    await service.append({
      actorEmployeeId: null,
      entityType: 'employee',
      entityId: 'emp-1',
      action: 'role_changed',
      oldValueJson: JSON.stringify({ role: 'waiter' }),
      newValueJson: JSON.stringify({ role: 'manager' }),
    });

    const rows = await getDb(app).select().from(auditLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entityType: 'employee',
      entityId: 'emp-1',
      action: 'role_changed',
      oldValueJson: '{"role":"waiter"}',
      newValueJson: '{"role":"manager"}',
    });
    expect(rows[0].id).toBeTruthy();
    expect(rows[0].createdAt).toBeGreaterThan(0);
  });

  it('structurally exposes ONLY append() — no update/delete code path exists (NFR16)', () => {
    const repository = app.get<AuditRepository>(AUDIT_REPOSITORY);
    const members = [
      ...Object.getOwnPropertyNames(repository),
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(repository)),
    ];
    expect(members).toContain('append');
    expect(members).not.toContain('update');
    expect(members).not.toContain('delete');
    expect(members).not.toContain('remove');
  });
});
