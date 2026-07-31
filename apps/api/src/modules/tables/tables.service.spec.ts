import { TablesService } from './tables.service';
import { TablesRepository } from './tables.repository';
import { MenuService } from '../menu/menu.service';
import { AuditService } from '../audit/audit.service';
import { DomainEventsService } from '../../common/events/domain-events.service';
import {
  EntityNotFoundException,
  InvalidTableStatusTransitionException,
  TableHasActiveOrderException,
} from '../../common/exceptions/domain.exception';

/**
 * Unit tests for floor business rules (Engineering Standards §10): QR token
 * entropy/lifecycle (FR32, FR35, FR21), the removal guard (Contract §2),
 * the mark-cleaned transition (ruling R6) with post-commit event ordering
 * (Contract §4), and the public endpoint's no-oracle behavior.
 */
describe('TablesService', () => {
  let service: TablesService;
  let repository: jest.Mocked<TablesRepository>;
  let menuService: jest.Mocked<MenuService>;
  let audit: jest.Mocked<AuditService>;
  let events: jest.Mocked<DomainEventsService>;

  const hallRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'hall-1',
    name: 'Main Hall',
    sortOrder: 0,
    isActive: true,
    ...overrides,
  });

  const tableRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'table-1',
    hallId: 'hall-1',
    label: 'Table 5',
    qrToken: 'old-token',
    status: 'available',
    isActive: true,
    updatedAt: 1000,
    ...overrides,
  });

  beforeEach(() => {
    repository = {
      listHalls: jest.fn(),
      findHallById: jest.fn(),
      insertHall: jest.fn(),
      listTables: jest.fn(),
      findTableById: jest.fn(),
      findTableByQrToken: jest.fn(),
      insertTable: jest.fn(),
      updateTable: jest.fn(),
      countNonTerminalOrders: jest.fn(),
    } as jest.Mocked<TablesRepository>;
    menuService = { getPublicMenu: jest.fn().mockResolvedValue([]) } as unknown as jest.Mocked<MenuService>;
    audit = { append: jest.fn() } as unknown as jest.Mocked<AuditService>;
    events = {
      emitTableStatusChanged: jest.fn(),
      emitProductAvailabilityChanged: jest.fn(),
      on: jest.fn(),
    } as unknown as jest.Mocked<DomainEventsService>;

    service = new TablesService(repository, menuService, audit, events);
  });

  it('generates QR tokens with 256 bits of CSPRNG entropy, non-sequential (FR35)', async () => {
    repository.findHallById.mockResolvedValue(hallRow() as never);
    const tokens: string[] = [];
    repository.insertTable.mockImplementation(async (row) => {
      tokens.push(row.qrToken);
      return tableRow({ qrToken: row.qrToken }) as never;
    });

    await service.createTable({ label: 'T1', hallId: 'hall-1' });
    await service.createTable({ label: 'T2', hallId: 'hall-1' });

    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); // base64url of 32 bytes, no padding
    }
    expect(tokens[0]).not.toBe(tokens[1]); // non-sequential by construction
  });

  it('refuses to create a table under a missing or inactive hall', async () => {
    repository.findHallById.mockResolvedValue(hallRow({ isActive: false }) as never);

    await expect(service.createTable({ label: 'T1', hallId: 'hall-1' })).rejects.toBeInstanceOf(
      EntityNotFoundException,
    );
    expect(repository.insertTable).not.toHaveBeenCalled();
  });

  it('retries ONLY on a qr_token unique collision and succeeds (unique index is the backstop)', async () => {
    repository.findHallById.mockResolvedValue(hallRow() as never);
    repository.insertTable
      .mockRejectedValueOnce(new Error('UNIQUE constraint failed: tables.qr_token'))
      .mockResolvedValueOnce(tableRow() as never);

    const result = await service.createTable({ label: 'T1', hallId: 'hall-1' });

    expect(repository.insertTable).toHaveBeenCalledTimes(2);
    expect(result.id).toBe('table-1');
  });

  it('does NOT retry on unrelated database errors (no silent catch, ES §7)', async () => {
    repository.findHallById.mockResolvedValue(hallRow() as never);
    repository.insertTable.mockRejectedValue(new Error('disk I/O error'));

    await expect(service.createTable({ label: 'T1', hallId: 'hall-1' })).rejects.toThrow('disk I/O error');
    expect(repository.insertTable).toHaveBeenCalledTimes(1);
  });

  it('blocks removal while any non-terminal order exists (TABLE_HAS_ACTIVE_ORDER)', async () => {
    repository.findTableById.mockResolvedValue(tableRow() as never);
    repository.countNonTerminalOrders.mockResolvedValue(2);

    await expect(service.removeTable('table-1')).rejects.toBeInstanceOf(TableHasActiveOrderException);
    expect(repository.updateTable).not.toHaveBeenCalled();
  });

  it('soft-deletes a table whose orders are all terminal', async () => {
    repository.findTableById.mockResolvedValue(tableRow() as never);
    repository.countNonTerminalOrders.mockResolvedValue(0);

    await service.removeTable('table-1');

    expect(repository.updateTable).toHaveBeenCalledWith('table-1', { isActive: false });
  });

  it('regenerates the QR token and audits old/new values (FR21, FR38)', async () => {
    repository.findTableById.mockResolvedValue(tableRow() as never);
    repository.updateTable.mockResolvedValue(tableRow({ qrToken: 'brand-new-token' }) as never);

    const result = await service.regenerateQr('table-1', 'owner-1');

    expect(result.qrToken).toBe('brand-new-token');
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'table',
        entityId: 'table-1',
        action: 'qr_regenerated',
        oldValueJson: JSON.stringify({ qrToken: 'old-token' }),
        newValueJson: JSON.stringify({ qrToken: 'brand-new-token' }),
      }),
    );
  });

  it('mark-cleaned flips needs_cleaning → available and emits AFTER the commit (ruling R6, Contract §4)', async () => {
    const callOrder: string[] = [];
    repository.findTableById.mockResolvedValue(tableRow({ status: 'needs_cleaning' }) as never);
    repository.updateTable.mockImplementation(async () => {
      callOrder.push('db');
      return tableRow({ status: 'available' }) as never;
    });
    events.emitTableStatusChanged.mockImplementation(() => callOrder.push('event'));

    const result = await service.markCleaned('table-1');

    expect(callOrder).toEqual(['db', 'event']);
    expect(events.emitTableStatusChanged).toHaveBeenCalledWith({
      tableId: 'table-1',
      fromStatus: 'needs_cleaning',
      toStatus: 'available',
    });
    expect(result.status).toBe('available');
  });

  it.each(['available', 'occupied', 'bill_requested'])(
    'mark-cleaned rejects from "%s" — only needs_cleaning is legal (ruling R6)',
    async (status) => {
      repository.findTableById.mockResolvedValue(tableRow({ status }) as never);

      await expect(service.markCleaned('table-1')).rejects.toBeInstanceOf(InvalidTableStatusTransitionException);
      expect(repository.updateTable).not.toHaveBeenCalled();
      expect(events.emitTableStatusChanged).not.toHaveBeenCalled();
    },
  );

  it('public menu: unknown AND deactivated tokens produce the identical 404 (no oracle)', async () => {
    repository.findTableByQrToken.mockResolvedValueOnce(undefined);
    await expect(service.getPublicMenuByQrToken('nope')).rejects.toBeInstanceOf(EntityNotFoundException);

    repository.findTableByQrToken.mockResolvedValueOnce(tableRow({ isActive: false }) as never);
    await expect(service.getPublicMenuByQrToken('old-token')).rejects.toBeInstanceOf(EntityNotFoundException);
  });

  it('public menu resolves table + hall name + live menu for a valid token (FR2)', async () => {
    repository.findTableByQrToken.mockResolvedValue(tableRow() as never);
    repository.findHallById.mockResolvedValue(hallRow() as never);
    menuService.getPublicMenu.mockResolvedValue([
      { id: 'cat-1', nameAr: 'مشروبات', nameFr: 'Boissons', sortOrder: 0, products: [] },
    ]);

    const result = await service.getPublicMenuByQrToken('old-token');

    expect(result.table).toEqual({ id: 'table-1', label: 'Table 5', hallName: 'Main Hall' });
    expect(result.categories).toHaveLength(1);
  });
});
