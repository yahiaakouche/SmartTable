import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { randomBytes } from 'crypto';
import * as fs from 'fs/promises';
import Database from 'better-sqlite3';
import { NOTIFICATION_TYPE } from '@smarttable/shared-types';
import { ConfigModule } from '../../config/config.module';
import { DatabaseModule, DRIZZLE_CLIENT } from '../../database/database.module';
import { EventsModule } from '../../common/events/events.module';
import { halls, refreshTokens } from '../../database/schema';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { TokensService } from '../auth/tokens.service';
import { OrdersModule } from '../orders/orders.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { BackupModule } from './backup.module';
import { decryptBackup } from './backup-crypto';
import { openIsolatedTestDb } from '../../../test/helpers/test-db';
import { createTestApp, getDb, seedEmployee } from '../../../test/helpers/test-app';

const BACKUP_DIR = process.env.BACKUP_DIRECTORY!;

/**
 * Integration: the backup module against a real, migrated SQLite database
 * and the real BACKUP_DIRECTORY (Engineering Standards §10) — the strongest
 * possible proof of a working backup: the produced snapshot is opened as a
 * real database and queried for data written before the snapshot. Covered:
 * the frozen §2 sequence end-to-end (success + the failure path with the
 * Owner notification, B5(a)), the B2(a) attachment download, encrypted
 * export (B4(a)), history pagination (D5), validation, and the B3 access
 * matrix over real HTTP.
 */
describe('BackupModule (integration)', () => {
  let app: INestApplication;

  const db = () => getDb(app);
  const authed = () => request(app.getHttpServer());
  const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

  beforeEach(async () => {
    const isolatedDb = await openIsolatedTestDb();
    app = await createTestApp(
      Test.createTestingModule({
        imports: [ConfigModule, DatabaseModule, EventsModule, AuditModule, AuthModule, OrdersModule, NotificationsModule, BackupModule],
      }).overrideProvider(DRIZZLE_CLIENT).useValue(isolatedDb),
    );
    await fs.rm(BACKUP_DIR, { recursive: true, force: true });
  });

  afterEach(async () => {
    await app.close();
    await fs.rm(BACKUP_DIR, { recursive: true, force: true });
  });

  const loginWithPin = async (name: string, role: string, pin = '1234') => {
    const employeeId = await seedEmployee(db(), { name, role, pin });
    const rawToken = randomBytes(48).toString('base64url');
    await db().insert(refreshTokens).values({
      employeeId,
      deviceLabel: `${name} Terminal`,
      tokenHash: TokensService.hashToken(rawToken),
      lastUsedAt: Date.now(),
      expiresAt: Date.now() + 30 * 86_400_000,
    });
    const res = await authed().post('/auth/pin-login').send({ deviceRefreshToken: rawToken, employeeId, pin });
    return { token: res.body.data.accessToken as string, employeeId };
  };

  it('create → verified snapshot on disk AND a downloadable copy that opens as a real database with the data inside (§2/B2(a))', async () => {
    const owner = await loginWithPin('Karim', 'owner');
    // A fact that must survive into the snapshot.
    await db().insert(halls).values({ id: 'hall-proof', name: 'قاعة الإثبات' });

    const res = await authed().post('/backup/create').set('Authorization', `Bearer ${owner.token}`).expect(201);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="smarttable-backup-\d{8}-\d{6}-manual\.db"$/);
    expect(res.headers['content-type']).toContain('application/octet-stream');

    // The downloaded body IS a real SQLite database containing the fact.
    const downloaded = res.body as Buffer;
    expect(downloaded.subarray(0, 15).toString('latin1')).toBe('SQLite format 3');
    const probe = new Database(Buffer.from(downloaded) as never, { readonly: true });
    const hall = probe.prepare(`SELECT name FROM halls WHERE id = 'hall-proof'`).get() as { name: string };
    expect(hall.name).toBe('قاعة الإثبات');
    expect(probe.pragma('integrity_check', { simple: true })).toBe('ok');
    probe.close();

    // The server-side copy exists and the history row matches (D4).
    const files = await fs.readdir(BACKUP_DIR);
    expect(files).toHaveLength(1);
    const history = await authed().get('/backup/history').set('Authorization', `Bearer ${owner.token}`).expect(200);
    expect(history.body.data).toHaveLength(1);
    expect(history.body.data[0]).toMatchObject({
      status: 'success',
      trigger: 'manual',
      sizeBytes: (await fs.stat(`${BACKUP_DIR}/${files[0]}`)).size,
      filePath: `${BACKUP_DIR}/${files[0]}`,
    });
    expect(history.body.meta.nextCursor).toBeNull();
  });

  it('encrypted export: the attachment is the STB1 container, the server keeps verified plaintext (B4(a))', async () => {
    const owner = await loginWithPin('Karim', 'owner');
    const res = await authed()
      .post('/backup/create')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ passphrase: 'export-secret-1' })
      .expect(201);
    expect(res.headers['content-disposition']).toMatch(/\.db\.enc"$/);

    const container = res.body as Buffer;
    expect(container.subarray(0, 4).toString('ascii')).toBe('STB1');
    const decrypted = decryptBackup(Buffer.from(container), 'export-secret-1');
    expect(decrypted.subarray(0, 15).toString('latin1')).toBe('SQLite format 3');
    // The server-side snapshot stays plaintext (the machine is FDE-protected).
    const [file] = await fs.readdir(BACKUP_DIR);
    expect(file.endsWith('.db')).toBe(true);
    expect((await fs.readFile(`${BACKUP_DIR}/${file}`)).subarray(0, 15).toString('latin1')).toBe('SQLite format 3');
  });

  it('failure path: unwritable directory → failed row, partial file removed, Owner notified (§2(4)/D13/B5(a))', async () => {
    const owner = await loginWithPin('Karim', 'owner');
    await fs.mkdir(BACKUP_DIR, { recursive: true });
    await fs.chmod(BACKUP_DIR, 0o555); // read-only target
    try {
      await authed().post('/backup/create').set('Authorization', `Bearer ${owner.token}`).expect(500);
    } finally {
      await fs.chmod(BACKUP_DIR, 0o755);
    }

    expect(await fs.readdir(BACKUP_DIR)).toEqual([]); // D13 — nothing restorable left behind
    const history = await authed().get('/backup/history').set('Authorization', `Bearer ${owner.token}`).expect(200);
    expect(history.body.data).toHaveLength(1);
    expect(history.body.data[0]).toMatchObject({ status: 'failed', trigger: 'manual', sizeBytes: 0 });

    await settle();
    const notifications = await authed().get('/notifications').set('Authorization', `Bearer ${owner.token}`).expect(200);
    const alert = notifications.body.data.find((n: { type: string }) => n.type === NOTIFICATION_TYPE.BACKUP_FAILED);
    expect(alert).toMatchObject({
      recipientRole: 'owner',
      payload: { backupHistoryId: history.body.data[0].id },
    });
  });

  it('history paginates by cursor, newest first (D5)', async () => {
    const owner = await loginWithPin('Karim', 'owner');
    for (let i = 0; i < 3; i++) {
      await authed().post('/backup/create').set('Authorization', `Bearer ${owner.token}`).expect(201);
      await new Promise((r) => setTimeout(r, 5));
    }
    const page1 = await authed().get('/backup/history?limit=2').set('Authorization', `Bearer ${owner.token}`).expect(200);
    expect(page1.body.data).toHaveLength(2);
    expect(page1.body.meta.nextCursor).toBeTruthy();
    const page2 = await authed()
      .get(`/backup/history?limit=2&cursor=${encodeURIComponent(page1.body.meta.nextCursor)}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(200);
    expect(page2.body.data).toHaveLength(1);
    expect(page2.body.meta.nextCursor).toBeNull();
    // No overlap, all three covered, newest first.
    const ids = [...page1.body.data, ...page2.body.data].map((e: { id: string }) => e.id);
    expect(new Set(ids).size).toBe(3);
    const createdAts = [...page1.body.data, ...page2.body.data].map((e: { createdAt: number }) => e.createdAt);
    expect([...createdAts].sort((a, b) => b - a)).toEqual(createdAts);
  });

  it('validates the query and body DTOs (400 VALIDATION_FAILED)', async () => {
    const owner = await loginWithPin('Karim', 'owner');
    // Build each request INSIDE the loop: supertest re-listens on a fresh
    // ephemeral port per Test object once the previous one has closed the
    // lazily-bound server — eagerly built Tests would all target the first
    // (already closed) port.
    const cases = [
      () => authed().get('/backup/history?cursor=garbage').set('Authorization', `Bearer ${owner.token}`),
      () => authed().get('/backup/history?limit=0').set('Authorization', `Bearer ${owner.token}`),
      () => authed().get('/backup/history?limit=101').set('Authorization', `Bearer ${owner.token}`),
      () => authed().post('/backup/create').set('Authorization', `Bearer ${owner.token}`).send({ passphrase: 'short' }),
      () => authed().post('/backup/create').set('Authorization', `Bearer ${owner.token}`).send({ passphrase: 42 }),
    ];
    for (const build of cases) {
      const res = await build().expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    }
  });

  it('enforces B3 over real HTTP: Owner + Manager, floor roles 403, anonymous 401', async () => {
    const manager = await loginWithPin('Amina', 'manager');
    const denied = [await loginWithPin('Sofia', 'waiter'), await loginWithPin('Yanis', 'kitchen'), await loginWithPin('Lina', 'cashier')];
    for (const login of denied) {
      const create = await authed().post('/backup/create').set('Authorization', `Bearer ${login.token}`).expect(403);
      expect(create.body.error.code).toBe('INSUFFICIENT_PERMISSION');
      await authed().get('/backup/history').set('Authorization', `Bearer ${login.token}`).expect(403);
    }
    await authed().get('/backup/history').set('Authorization', `Bearer ${manager.token}`).expect(200);
    await authed().post('/backup/create').expect(401);
    await authed().get('/backup/history').expect(401);
  });
});
