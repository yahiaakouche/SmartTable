import { INestApplication, ValidationPipe } from '@nestjs/common';
import { TestingModuleBuilder } from '@nestjs/testing';
import * as argon2 from 'argon2';
import { GlobalExceptionFilter } from '../../src/common/filters/global-exception.filter';
import { ResponseEnvelopeInterceptor } from '../../src/common/interceptors/response-envelope.interceptor';
import { DRIZZLE_CLIENT } from '../../src/database/database.module';
import type { DbClient } from '../../src/database/connection';
import { employees } from '../../src/database/schema';

/**
 * Boots a Nest application for integration tests exactly the way main.ts
 * boots the real one (same global pipe, filter, envelope interceptor) —
 * integration tests verify the WHOLE slice: controller → service → real DB.
 */
export async function createTestApp(
  builder: TestingModuleBuilder,
  options: { globalPrefix?: string } = {},
): Promise<INestApplication> {
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication();
  if (options.globalPrefix) {
    app.setGlobalPrefix(options.globalPrefix); // main.ts: 'api/v1' — used by E2E tests
  }
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalInterceptors(new ResponseEnvelopeInterceptor());
  await app.init();
  return app;
}

export function getDb(app: INestApplication): DbClient {
  return app.get(DRIZZLE_CLIENT);
}

/** Seeds an employee directly (test fixture setup, not via the API under
 * test). Returns the new employee's id. */
export async function seedEmployee(
  db: DbClient,
  input: { name: string; role: string; password?: string; pin?: string },
): Promise<string> {
  const rows = await db
    .insert(employees)
    .values({
      name: input.name,
      role: input.role,
      email: null,
      passwordHash: input.password ? await argon2.hash(input.password) : null,
      pinHash: input.pin ? await argon2.hash(input.pin) : null,
    })
    .returning();
  return rows[0].id;
}
