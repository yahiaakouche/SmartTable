import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { io, Socket } from 'socket.io-client';
import { randomBytes } from 'crypto';
import { AppModule } from '../src/app.module';
import { DRIZZLE_CLIENT } from '../src/database/database.module';
import { refreshTokens } from '../src/database/schema';
import { TokensService } from '../src/modules/auth/tokens.service';
import { openIsolatedTestDb } from './helpers/test-db';
import { createTestApp, getDb, seedEmployee } from './helpers/test-app';

/**
 * E2E — Step 3.15 critical path (API Contract Design §3, FR28/FR30, NFR11),
 * against the FULL application composition (real migrated database, /api/v1
 * prefix, real listening port so the staff gateway genuinely attaches):
 *
 *  GET /api/v1/employees/:id/presence answers from the in-memory gateway
 *  state only (B3(a)) — a REAL staff socket connection through the real
 *  Socket.IO handshake flips the answer to online:true, and that socket's
 *  disconnect flips it back to online:false. The same real-time channel
 *  maintains presence; no polling, no database read (ADR-011).
 */
describe('Employee Presence (E2E critical path)', () => {
  let app: INestApplication;
  let port: number;
  let ownerToken: string;
  const sockets: Socket[] = [];

  const db = () => getDb(app);
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    const isolatedDb = await openIsolatedTestDb();
    app = await createTestApp(
      Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE_CLIENT).useValue(isolatedDb),
      { globalPrefix: 'api/v1', moduleProvidesInterceptors: true },
    );
    await app.listen(0);
    const address = app.getHttpServer().address();
    port = typeof address === 'object' && address ? address.port : 0;

    await seedEmployee(db(), { name: 'Karim', role: 'owner', password: 'owner-secret-1' });
    const ownerLogin = await http()
      .post('/api/v1/auth/password-login')
      .send({ name: 'Karim', password: 'owner-secret-1', deviceLabel: 'Owner Laptop' });
    ownerToken = ownerLogin.body.data.accessToken;
  }, 90_000);

  afterAll(async () => {
    for (const socket of sockets.splice(0)) socket.disconnect();
    await app.close();
  });

  const pinLogin = async (name: string, role: string, pin: string): Promise<{ employeeId: string; token: string }> => {
    const employeeId = await seedEmployee(db(), { name: `${name} ${randomBytes(3).toString('hex')}`, role, pin });
    const rawToken = randomBytes(48).toString('base64url');
    await db().insert(refreshTokens).values({
      employeeId,
      deviceLabel: 'Presence E2E Terminal',
      tokenHash: TokensService.hashToken(rawToken),
      lastUsedAt: Date.now(),
      expiresAt: Date.now() + 86_400_000,
    });
    const res = await http().post('/api/v1/auth/pin-login').send({ deviceRefreshToken: rawToken, employeeId, pin });
    return { employeeId, token: res.body.data.accessToken };
  };

  const connectStaff = (token: string): Promise<Socket> =>
    new Promise((resolve, reject) => {
      const socket = io(`http://127.0.0.1:${port}`, {
        auth: { token },
        transports: ['websocket'],
        reconnection: false,
        timeout: 5_000,
      });
      sockets.push(socket);
      socket.on('connect', () => resolve(socket));
      socket.on('connect_error', reject);
    });

  const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

  const readPresence = async (employeeId: string) => {
    const res = await http()
      .get(`/api/v1/employees/${employeeId}/presence`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    return res.body.data as { employeeId: string; online: boolean };
  };

  it('a real staff socket connection flips presence to online, and its disconnect flips it back (D5)', async () => {
    const waiter = await pinLogin('Sofia', 'waiter', '2222');

    // No socket yet — offline, exact B4(a) envelope shape.
    expect(await readPresence(waiter.employeeId)).toEqual({ employeeId: waiter.employeeId, online: false });

    const socket = await connectStaff(waiter.token);
    await settle();
    expect(await readPresence(waiter.employeeId)).toEqual({ employeeId: waiter.employeeId, online: true });

    socket.disconnect();
    await settle();
    expect(await readPresence(waiter.employeeId)).toEqual({ employeeId: waiter.employeeId, online: false });
  });

  it('multi-device semantics: an employee stays online until their LAST socket drops (ADR-011 registry semantics)', async () => {
    const cashier = await pinLogin('Iman', 'cashier', '3333');

    const first = await connectStaff(cashier.token);
    const second = await connectStaff(cashier.token);
    await settle();
    expect((await readPresence(cashier.employeeId)).online).toBe(true);

    first.disconnect();
    await settle();
    expect((await readPresence(cashier.employeeId)).online).toBe(true); // second socket still connected

    second.disconnect();
    await settle();
    expect((await readPresence(cashier.employeeId)).online).toBe(false);
  });
});
