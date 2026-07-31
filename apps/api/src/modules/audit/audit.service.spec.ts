import { AuditService } from './audit.service';
import { AuditLogRowWithActor, AuditRepository } from './audit.repository';
import { ValidationFailedException } from '../../common/exceptions/domain.exception';

/**
 * Unit tests for the audit query surface (Step 3.8): cursor codec (D1),
 * page-size rules (D3), filter pass-through (D4), date-range validation
 * (B2(a)/D5), and the read-side DTO shaping — parsed old/new values (D6)
 * and the nullable actor fields (B3(b)/D11).
 */
describe('AuditService.list', () => {
  let service: AuditService;
  let repository: jest.Mocked<AuditRepository>;

  const row = (overrides: Partial<AuditLogRowWithActor> = {}): AuditLogRowWithActor => ({
    id: 'entry-1',
    actorEmployeeId: 'emp-1',
    actorName: 'Karim',
    entityType: 'product',
    entityId: 'prod-1',
    action: 'price_changed',
    oldValueJson: JSON.stringify({ priceMinor: 25000 }),
    newValueJson: JSON.stringify({ priceMinor: 30000 }),
    createdAt: 1_700_000_000_000,
    ...overrides,
  });

  beforeEach(() => {
    repository = {
      append: jest.fn().mockResolvedValue(undefined),
      findPage: jest.fn().mockResolvedValue([]),
    } as jest.Mocked<AuditRepository>;
    service = new AuditService(repository);
  });

  it('returns an empty page with a null cursor when nothing matches', async () => {
    const result = await service.list({});
    expect(result).toEqual({ data: [], meta: { nextCursor: null } });
    expect(repository.findPage).toHaveBeenCalledWith({ cursor: null, limit: 51 }); // default 50 + 1 lookahead (D3)
  });

  it('maps rows to DTOs with parsed old/new values and the resolved actor name (D6/B3(b))', async () => {
    repository.findPage.mockResolvedValue([row()]);
    const result = await service.list({});
    expect(result.data[0]).toEqual({
      id: 'entry-1',
      actorEmployeeId: 'emp-1',
      actorName: 'Karim',
      entityType: 'product',
      entityId: 'prod-1',
      action: 'price_changed',
      oldValue: { priceMinor: 25000 },
      newValue: { priceMinor: 30000 },
      createdAt: 1_700_000_000_000,
    });
  });

  it('keeps system entries first-class: null actor and null values stay null (D11)', async () => {
    repository.findPage.mockResolvedValue([row({ actorEmployeeId: null, actorName: null, oldValueJson: null, newValueJson: null })]);
    const result = await service.list({});
    expect(result.data[0]).toMatchObject({ actorEmployeeId: null, actorName: null, oldValue: null, newValue: null });
  });

  it('passes every filter through to the repository, AND-combined by the repository (D4)', async () => {
    await service.list({ entityType: 'product', entityId: 'prod-1', actorEmployeeId: 'a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d', from: 100, to: 200 });
    expect(repository.findPage).toHaveBeenCalledWith({
      entityType: 'product',
      entityId: 'prod-1',
      actorEmployeeId: 'a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d',
      from: 100,
      to: 200,
      cursor: null,
      limit: 51,
    });
  });

  it('rejects an inverted date range (B2(a)/D5)', async () => {
    await expect(service.list({ from: 200, to: 100 })).rejects.toBeInstanceOf(ValidationFailedException);
    expect(repository.findPage).not.toHaveBeenCalled();
  });

  it('clamps the page size and fetches limit+1 to detect the next page (D3)', async () => {
    await service.list({ limit: 10 });
    expect(repository.findPage).toHaveBeenCalledWith({ cursor: null, limit: 11 });
  });

  it('emits a nextCursor only when more rows exist, and the cursor round-trips (D1/D2)', async () => {
    const rows = [row({ id: 'e3', createdAt: 300 }), row({ id: 'e2', createdAt: 200 }), row({ id: 'e1', createdAt: 100 })];
    repository.findPage.mockResolvedValue(rows);

    const page1 = await service.list({ limit: 2 });
    expect(page1.data.map((e) => e.id)).toEqual(['e3', 'e2']);
    expect(page1.meta.nextCursor).not.toBeNull();

    // The cursor decodes to the LAST row of the emitted page.
    const decoded = JSON.parse(Buffer.from(page1.meta.nextCursor!, 'base64url').toString('utf8'));
    expect(decoded).toEqual({ c: 200, i: 'e2' });

    repository.findPage.mockResolvedValue([row({ id: 'e1', createdAt: 100 })]);
    const page2 = await service.list({ limit: 2, cursor: page1.meta.nextCursor! });
    expect(repository.findPage).toHaveBeenLastCalledWith({ cursor: { createdAt: 200, id: 'e2' }, limit: 3 });
    expect(page2.data.map((e) => e.id)).toEqual(['e1']);
    expect(page2.meta.nextCursor).toBeNull();
  });

  it('rejects a malformed cursor as VALIDATION_FAILED, never a 500 (D1)', async () => {
    await expect(service.list({ cursor: 'garbage!!!' })).rejects.toBeInstanceOf(ValidationFailedException);
    // Valid base64 but wrong shape is equally rejected.
    const wrongShape = Buffer.from(JSON.stringify({ x: 1 }), 'utf8').toString('base64url');
    await expect(service.list({ cursor: wrongShape })).rejects.toBeInstanceOf(ValidationFailedException);
  });

  it('append-only guarantee is untouched: the service exposes no mutation path beyond append (NFR16)', () => {
    // TS-private helpers appear on the prototype at runtime; the guarantee
    // is that NO update/delete-style method exists anywhere on the service.
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(service)).sort()).toEqual([
      'append',
      'constructor',
      'decodeCursor',
      'encodeCursor',
      'list',
      'toDto',
    ]);
  });
});
