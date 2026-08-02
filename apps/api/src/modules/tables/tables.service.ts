import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { TableStatus } from '@smarttable/shared-types';
import type {
  CreateHallRequest,
  CreateTableRequest,
  HallDto,
  PublicMenuDto,
  TableDto,
  UpdateTableRequest,
} from '@smarttable/shared-types';
import { TABLES_REPOSITORY, TablesRepository } from './tables.repository';
import { MenuService } from '../menu/menu.service';
import { RestaurantConfigService } from '../config/restaurant-config.service';
import { AuditService } from '../audit/audit.service';
import { DomainEventsService } from '../../common/events/domain-events.service';
import {
  EntityNotFoundException,
  InvalidTableStatusTransitionException,
  TableHasActiveOrderException,
} from '../../common/exceptions/domain.exception';

type HallRow = Awaited<ReturnType<TablesRepository['findHallById']>> & {};
type TableRow = Awaited<ReturnType<TablesRepository['findTableById']>> & {};

/** 256 bits of CSPRNG entropy, base64url — cryptographically random and
 * non-sequential by construction (FR35), and deliberately disjoint from the
 * time-ordered UUIDv7 primary key (Database Schema Design §3 note). */
const QR_TOKEN_BYTES = 32;
/** The unique index on qr_token is the real backstop; a collision after one
 * retry at this entropy is not a realistic event, so three attempts is a
 * generous ceiling before surfacing a genuine failure rather than looping. */
const QR_TOKEN_MAX_ATTEMPTS = 3;

/**
 * Floor administration (FR1, FR16, FR20, FR21, FR32, FR35) — halls, tables,
 * and the QR token lifecycle, plus the unauthenticated customer menu entry
 * point that resolves those tokens (FR2).
 *
 * Frozen rules enforced here:
 *  - QR tokens are generated ONLY at table creation or explicit regeneration
 *    (FR32 idempotency: existing tables' tokens never change otherwise).
 *  - Regeneration invalidates the previous token and is audited (FR21, FR38).
 *  - Table removal is a soft delete, blocked by TABLE_HAS_ACTIVE_ORDER while
 *    any non-terminal order references the table (Contract §2, ruling R7).
 *  - mark-cleaned closes the table loop strictly from `needs_cleaning` back
 *    to `available` (ruling R6) and emits `table.status_changed` only after
 *    the write commits (Contract §4 binding rule).
 */
@Injectable()
export class TablesService {
  constructor(
    @Inject(TABLES_REPOSITORY) private readonly tablesRepository: TablesRepository,
    private readonly menuService: MenuService,
    private readonly configService: RestaurantConfigService,
    private readonly audit: AuditService,
    private readonly events: DomainEventsService,
  ) {}

  // ------------------------------------------------------------------ halls

  async listHalls(): Promise<HallDto[]> {
    const rows = await this.tablesRepository.listHalls();
    return rows.map((row) => this.hallToDto(row));
  }

  async createHall(input: CreateHallRequest): Promise<HallDto> {
    const row = await this.tablesRepository.insertHall({ name: input.name, sortOrder: input.sortOrder ?? 0 });
    return this.hallToDto(row);
  }

  // ----------------------------------------------------------------- tables

  async listTables(): Promise<TableDto[]> {
    const rows = await this.tablesRepository.listTables();
    return rows.map((row) => this.tableToDto(row));
  }

  /** FR16/FR20 — every table created (wizard or Admin Dashboard) receives
   * its QR token atomically with the row; no token-less table can exist. */
  async createTable(input: CreateTableRequest): Promise<TableDto> {
    const hall = await this.tablesRepository.findHallById(input.hallId);
    if (!hall || !hall.isActive) throw new EntityNotFoundException('hall', input.hallId);

    for (let attempt = 1; ; attempt++) {
      try {
        const row = await this.tablesRepository.insertTable({
          hallId: input.hallId,
          label: input.label,
          qrToken: this.generateQrToken(),
        });
        return this.tableToDto(row);
      } catch (error) {
        if (attempt >= QR_TOKEN_MAX_ATTEMPTS || !this.isQrTokenCollision(error)) throw error;
      }
    }
  }

  async updateTable(id: string, changes: UpdateTableRequest): Promise<TableDto> {
    const existing = await this.tablesRepository.findTableById(id);
    if (!existing) throw new EntityNotFoundException('table', id);

    if (changes.hallId !== undefined) {
      const hall = await this.tablesRepository.findHallById(changes.hallId);
      if (!hall || !hall.isActive) throw new EntityNotFoundException('hall', changes.hallId);
    }

    const updated = await this.tablesRepository.updateTable(id, {
      ...(changes.label !== undefined ? { label: changes.label } : {}),
      ...(changes.hallId !== undefined ? { hallId: changes.hallId } : {}),
    });
    return this.tableToDto(updated!);
  }

  /** Soft delete (Cross-Cutting Rule 5), blocked while any non-terminal
   * order references the table (Contract §2 TABLE_HAS_ACTIVE_ORDER). */
  async removeTable(id: string): Promise<void> {
    const existing = await this.tablesRepository.findTableById(id);
    if (!existing) throw new EntityNotFoundException('table', id);

    const blocking = await this.tablesRepository.countNonTerminalOrders(id);
    if (blocking > 0) throw new TableHasActiveOrderException(id);

    await this.tablesRepository.updateTable(id, { isActive: false });
  }

  /** FR21 — explicit regeneration invalidates the previous token; audited
   * with old/new values per FR38 (`qr_regenerated`). */
  async regenerateQr(id: string, actorEmployeeId: string): Promise<TableDto> {
    const existing = await this.tablesRepository.findTableById(id);
    if (!existing) throw new EntityNotFoundException('table', id);

    let updated: TableRow | undefined;
    for (let attempt = 1; ; attempt++) {
      try {
        updated = await this.tablesRepository.updateTable(id, { qrToken: this.generateQrToken() });
        break;
      } catch (error) {
        if (attempt >= QR_TOKEN_MAX_ATTEMPTS || !this.isQrTokenCollision(error)) throw error;
      }
    }

    await this.audit.append({
      actorEmployeeId,
      entityType: 'table',
      entityId: id,
      action: 'qr_regenerated',
      oldValueJson: JSON.stringify({ qrToken: existing.qrToken }),
      newValueJson: JSON.stringify({ qrToken: updated!.qrToken }),
    });
    return this.tableToDto(updated!);
  }

  /** The waiter's loop-closing action (Contract §3): strictly
   * `needs_cleaning → available`; anything else is a domain error. */
  async markCleaned(id: string): Promise<TableDto> {
    const existing = await this.tablesRepository.findTableById(id);
    if (!existing) throw new EntityNotFoundException('table', id);
    if (existing.status !== TableStatus.NEEDS_CLEANING) {
      throw new InvalidTableStatusTransitionException(id, existing.status, 'mark-cleaned');
    }

    const updated = await this.tablesRepository.updateTable(id, { status: TableStatus.AVAILABLE });

    // Contract §4 — emitted strictly after the write above has committed.
    this.events.emitTableStatusChanged({
      tableId: id,
      fromStatus: existing.status,
      toStatus: TableStatus.AVAILABLE,
    });
    return this.tableToDto(updated!);
  }

  // -------------------------------------------------- customer entry (FR2)

  /** Unauthenticated resolution of a table QR token to the live menu.
   * Unknown AND deactivated tokens produce the identical 404 — the endpoint
   * never reveals which tokens have ever existed (no oracle).
   * Step 3.10 ruling B2(a): the response also carries the restaurant's
   * branding (FR31's customer half) — `null` until the Setup Wizard creates
   * the profile row, so the menu still serves on a fresh install. */
  async getPublicMenuByQrToken(qrToken: string): Promise<PublicMenuDto> {
    const table = await this.tablesRepository.findTableByQrToken(qrToken);
    if (!table || !table.isActive) throw new EntityNotFoundException('table', qrToken);

    const hall = await this.tablesRepository.findHallById(table.hallId);
    const categories = await this.menuService.getPublicMenu();
    const profile = await this.configService.findProfileOrNull();
    return {
      table: { id: table.id, label: table.label, hallName: hall?.name ?? '' },
      categories,
      restaurant: profile
        ? {
            name: profile.name,
            logoPath: profile.logoPath,
            primaryColor: profile.primaryColor,
            secondaryColor: profile.secondaryColor,
            currencyCode: profile.currencyCode,
            defaultLanguage: profile.defaultLanguage,
          }
        : null,
    };
  }

  // ----------------------------------------------------------------- helpers

  private generateQrToken(): string {
    return randomBytes(QR_TOKEN_BYTES).toString('base64url');
  }

  /** Unique-index violation on qr_token — the ONLY collision this retry
   * loop is allowed to swallow; every other error propagates (ES §7). */
  private isQrTokenCollision(error: unknown): boolean {
    return error instanceof Error && /UNIQUE constraint failed: tables\.qr_token/.test(error.message);
  }

  private hallToDto(row: HallRow): HallDto {
    return { id: row!.id, name: row!.name, sortOrder: row!.sortOrder, isActive: row!.isActive };
  }

  private tableToDto(row: TableRow): TableDto {
    return {
      id: row!.id,
      hallId: row!.hallId,
      label: row!.label,
      qrToken: row!.qrToken,
      status: row!.status as TableStatus,
      isActive: row!.isActive,
      updatedAt: row!.updatedAt,
    };
  }
}
