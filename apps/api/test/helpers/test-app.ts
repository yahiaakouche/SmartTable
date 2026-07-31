import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TestingModuleBuilder } from '@nestjs/testing';
import * as argon2 from 'argon2';
import { GlobalExceptionFilter } from '../../src/common/filters/global-exception.filter';
import { ResponseEnvelopeInterceptor } from '../../src/common/interceptors/response-envelope.interceptor';
import { IdempotencyInterceptor } from '../../src/common/idempotency/idempotency.interceptor';
import { IDEMPOTENCY_REPOSITORY, IdempotencyRepository } from '../../src/common/idempotency/idempotency.repository';
import { DRIZZLE_CLIENT } from '../../src/database/database.module';
import type { DbClient } from '../../src/database/connection';
import { employees } from '../../src/database/schema';

/**
 * Boots a Nest application for integration tests exactly the way main.ts
 * boots the real one (same global pipe, filter, and the SAME interceptor
 * pair in the SAME order as AppModule: idempotency outermost so memoized
 * responses are the exact enveloped body, envelope inner) — integration
 * tests verify the WHOLE slice: controller → service → real DB.
 */
export async function createTestApp(
  builder: TestingModuleBuilder,
  options: { globalPrefix?: string; moduleProvidesInterceptors?: boolean } = {},
): Promise<INestApplication> {
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication();
  if (options.globalPrefix) {
    app.setGlobalPrefix(options.globalPrefix); // main.ts: 'api/v1' — used by E2E tests
  }
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new GlobalExceptionFilter());
  // Suites importing the full AppModule (E2E) already have BOTH interceptors
  // registered via AppModule's APP_INTERCEPTOR providers — adding a manual
  // pair on top would run the idempotency interceptor TWICE per request
  // (the second pass would see the first pass's pending marker and wrongly
  // 409). Feature-module suites (integration) get the manual mirror pair:
  // idempotency outermost, envelope inner — exactly AppModule's order.
  if (!options.moduleProvidesInterceptors) {
    // Suites whose module under test imports IdempotencyModule get the full
    // mirror pair; suites without it run the envelope only (their routes
    // carry no @Idempotent() marks, so nothing changes for them).
    let idempotencyRepository: IdempotencyRepository | null = null;
    try {
      idempotencyRepository = moduleRef.get<IdempotencyRepository>(IDEMPOTENCY_REPOSITORY, { strict: false });
    } catch {
      idempotencyRepository = null; // token not present in this module context
    }
    const interceptors = idempotencyRepository
      ? [new IdempotencyInterceptor(idempotencyRepository, moduleRef.get(Reflector)), new ResponseEnvelopeInterceptor()]
      : [new ResponseEnvelopeInterceptor()];
    app.useGlobalInterceptors(...interceptors);
  }
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
