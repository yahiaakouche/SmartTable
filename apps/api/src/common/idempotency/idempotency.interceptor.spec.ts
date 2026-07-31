import { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash } from 'crypto';
import { lastValueFrom, of, throwError } from 'rxjs';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { IdempotencyKeyRow, IdempotencyRepository } from './idempotency.repository';
import {
  IdempotencyKeyConflictException,
  IdempotencyKeyRequiredException,
  IdempotencyKeyReusedException,
} from '../exceptions/domain.exception';

/**
 * Unit tests for the Contract §1 idempotency machinery (Step 3.3 ruling Q1):
 * key requirement, memo replay (200 path), body-mismatch conflict, the
 * insert-pending-before-handler guarantee against duplicate execution, the
 * UNIQUE-race fallback, and failed-handler key release.
 */
describe('IdempotencyInterceptor', () => {
  let interceptor: IdempotencyInterceptor;
  let repository: jest.Mocked<IdempotencyRepository>;
  let reflector: jest.Mocked<Reflector>;

  const body = { tableId: 't-1', items: [{ productId: 'p-1', quantity: 1 }] };
  const hashOf = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

  const row = (overrides: Partial<IdempotencyKeyRow> = {}): IdempotencyKeyRow => ({
    id: 'row-1',
    key: 'key-1',
    endpoint: 'POST /orders',
    requestHash: hashOf(body),
    responseJson: null,
    createdAt: 1000,
    ...overrides,
  });

  const contextFor = (requestBody: unknown = body): ExecutionContext =>
    ({
      getType: () => 'http',
      getHandler: () => ({}),
      switchToHttp: () => ({
        getRequest: () => ({
          method: 'POST',
          originalUrl: '/orders',
          headers: { 'idempotency-key': 'key-1' },
          body: requestBody,
        }),
      }),
    }) as unknown as ExecutionContext;

  const handlerReturning = (value: unknown): CallHandler => ({ handle: () => of(value) });

  beforeEach(() => {
    repository = {
      findByKeyAndEndpoint: jest.fn().mockResolvedValue(undefined),
      insertPending: jest.fn().mockResolvedValue(undefined),
      storeResponse: jest.fn().mockResolvedValue(undefined),
      deleteIfPending: jest.fn().mockResolvedValue(undefined),
    } as jest.Mocked<IdempotencyRepository>;
    reflector = { get: jest.fn().mockReturnValue(true) } as unknown as jest.Mocked<Reflector>;
    interceptor = new IdempotencyInterceptor(repository, reflector);
  });

  it('passes unmarked routes straight through without touching the repository', async () => {
    reflector.get.mockReturnValue(false);
    const result = await lastValueFrom(await interceptor.intercept(contextFor(), handlerReturning('ok')));
    expect(result).toBe('ok');
    expect(repository.findByKeyAndEndpoint).not.toHaveBeenCalled();
  });

  it('rejects a missing Idempotency-Key header with 400', async () => {
    const context = {
      getType: () => 'http',
      getHandler: () => ({}),
      switchToHttp: () => ({ getRequest: () => ({ method: 'POST', originalUrl: '/orders', headers: {}, body }) }),
    } as unknown as ExecutionContext;
    await expect(interceptor.intercept(context, handlerReturning('x'))).rejects.toThrow(IdempotencyKeyRequiredException);
  });

  it('replays the stored ORIGINAL response via the 200 reuse path when key+endpoint+body match', async () => {
    const storedBody = { data: { id: 'order-1', status: 'pending' } };
    repository.findByKeyAndEndpoint.mockResolvedValue(row({ responseJson: JSON.stringify(storedBody) }));
    const next = handlerReturning('SHOULD-NOT-RUN');

    const error: any = await lastValueFrom(await interceptor.intercept(contextFor(), next)).catch((e) => e);

    expect(error).toBeInstanceOf(IdempotencyKeyReusedException);
    expect(error.httpStatus).toBe(200);
    expect(error.replayBody).toEqual(storedBody);
  });

  it('rejects the same key with a DIFFERENT body with 409 conflict', async () => {
    repository.findByKeyAndEndpoint.mockResolvedValue(row());
    await expect(
      interceptor.intercept(contextFor({ tableId: 'DIFFERENT' }), handlerReturning('x')),
    ).rejects.toThrow(IdempotencyKeyConflictException);
  });

  it('first sight of a key: inserts the pending marker BEFORE the handler runs, then stores the response', async () => {
    repository.findByKeyAndEndpoint
      .mockResolvedValueOnce(undefined) // pre-insert lookup
      .mockResolvedValueOnce(row()); // post-insert lookup (for the row id)
    const callOrder: string[] = [];
    repository.insertPending.mockImplementation(async () => {
      callOrder.push('insertPending');
    });
    const next: CallHandler = {
      handle: () => {
        callOrder.push('handler');
        return of({ data: { id: 'order-1' } });
      },
    };

    const result = await lastValueFrom(await interceptor.intercept(contextFor(), next));

    expect(result).toEqual({ data: { id: 'order-1' } });
    expect(callOrder).toEqual(['insertPending', 'handler']); // the Q1 ordering guarantee
    expect(repository.storeResponse).toHaveBeenCalledWith('row-1', JSON.stringify({ data: { id: 'order-1' } }));
    expect(repository.deleteIfPending).not.toHaveBeenCalled();
  });

  it('a FAILED handler releases the key (pending marker deleted) and propagates the error', async () => {
    repository.findByKeyAndEndpoint.mockResolvedValueOnce(undefined).mockResolvedValueOnce(row());
    const failure = new Error('domain failure');
    const next: CallHandler = { handle: () => throwError(() => failure) };

    await expect(lastValueFrom(await interceptor.intercept(contextFor(), next))).rejects.toBe(failure);
    expect(repository.deleteIfPending).toHaveBeenCalledWith('key-1', 'POST /orders');
    expect(repository.storeResponse).not.toHaveBeenCalled();
  });

  it('losing the UNIQUE insert race falls back to replaying the winner\'s response', async () => {
    const storedBody = { data: { id: 'order-winner' } };
    repository.findByKeyAndEndpoint
      .mockResolvedValueOnce(undefined) // pre-insert lookup: not there yet
      .mockResolvedValueOnce(row({ responseJson: JSON.stringify(storedBody) })); // winner's completed row
    repository.insertPending.mockRejectedValue(
      new Error('UNIQUE constraint failed: idempotency_keys.key, idempotency_keys.endpoint'),
    );

    const error: any = await lastValueFrom(await interceptor.intercept(contextFor(), handlerReturning('NO'))).catch((e) => e);

    expect(error).toBeInstanceOf(IdempotencyKeyReusedException);
    expect(error.replayBody).toEqual(storedBody);
  });

  it('a concurrent in-flight twin is awaited, then its response replayed', async () => {
    const storedBody = { data: { id: 'order-twin' } };
    repository.findByKeyAndEndpoint
      .mockResolvedValueOnce(row({ responseJson: null })) // in flight…
      .mockResolvedValueOnce(row({ responseJson: null }))
      .mockResolvedValue(row({ responseJson: JSON.stringify(storedBody) })); // …then done

    const error: any = await lastValueFrom(await interceptor.intercept(contextFor(), handlerReturning('NO'))).catch((e) => e);

    expect(error).toBeInstanceOf(IdempotencyKeyReusedException);
    expect(error.replayBody).toEqual(storedBody);
  }, 10_000);

  it('a key whose first request vanished (failed) reports a retryable 409', async () => {
    repository.findByKeyAndEndpoint
      .mockResolvedValueOnce(row({ responseJson: null })) // in flight…
      .mockResolvedValueOnce(undefined); // …then cleaned up after failure

    const observable = await interceptor.intercept(contextFor(), handlerReturning('NO'));
    await expect(lastValueFrom(observable)).rejects.toThrow(IdempotencyKeyConflictException);
  });
});
