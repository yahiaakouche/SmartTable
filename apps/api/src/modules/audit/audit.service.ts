import { Inject, Injectable } from '@nestjs/common';
import type { AuditLogEntryDto, ListAuditLogResponse } from '@smarttable/shared-types';
import { AUDIT_REPOSITORY, AuditEntry, AuditLogRowWithActor, AuditRepository } from './audit.repository';
import { ListAuditLogQueryDto } from './dto/list-audit-log-query.dto';
import { ValidationFailedException } from '../../common/exceptions/domain.exception';

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;

/**
 * The single write path into the audit trail (FR38, Security Architecture §9).
 * Every security-relevant or administrative action in the system flows through
 * here — there is deliberately no parallel security log anywhere else.
 *
 * Step 3.8 added the query side (GET /audit-log — the Owner/Manager review
 * capability the trail exists for): cursor pagination and the four frozen
 * filters (Contract §3). Reading is not itself audited — FR38's trigger list
 * covers mutations only (D8).
 */
@Injectable()
export class AuditService {
  constructor(@Inject(AUDIT_REPOSITORY) private readonly auditRepository: AuditRepository) {}

  async append(entry: AuditEntry): Promise<void> {
    await this.auditRepository.append(entry);
  }

  /** GET /audit-log — the four Contract §3 filters (AND-combined, D4) plus
   * cursor pagination identical in shape to the notifications surface (D1–D3). */
  async list(query: ListAuditLogQueryDto): Promise<ListAuditLogResponse> {
    if (query.from !== undefined && query.to !== undefined && query.from > query.to) {
      throw new ValidationFailedException('`from` must not be after `to`.');
    }
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_PAGE_LIMIT, 1), MAX_PAGE_LIMIT);
    const cursor = query.cursor !== undefined ? this.decodeCursor(query.cursor) : null;

    // Fetch one extra row to learn whether another page exists.
    const rows = await this.auditRepository.findPage({
      ...(query.entityType !== undefined ? { entityType: query.entityType } : {}),
      ...(query.entityId !== undefined ? { entityId: query.entityId } : {}),
      ...(query.actorEmployeeId !== undefined ? { actorEmployeeId: query.actorEmployeeId } : {}),
      ...(query.from !== undefined ? { from: query.from } : {}),
      ...(query.to !== undefined ? { to: query.to } : {}),
      cursor,
      limit: limit + 1,
    });
    const pageRows = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const lastRow = pageRows[pageRows.length - 1];

    return {
      data: pageRows.map((row) => this.toDto(row)),
      meta: { nextCursor: hasMore && lastRow ? this.encodeCursor(lastRow) : null },
    };
  }

  private toDto(row: AuditLogRowWithActor): AuditLogEntryDto {
    return {
      id: row.id,
      actorEmployeeId: row.actorEmployeeId,
      actorName: row.actorName,
      entityType: row.entityType,
      entityId: row.entityId,
      action: row.action,
      oldValue: row.oldValueJson !== null ? (JSON.parse(row.oldValueJson) as unknown) : null,
      newValue: row.newValueJson !== null ? (JSON.parse(row.newValueJson) as unknown) : null,
      createdAt: row.createdAt,
    };
  }

  private encodeCursor(row: AuditLogRowWithActor): string {
    return Buffer.from(JSON.stringify({ c: row.createdAt, i: row.id }), 'utf8').toString('base64url');
  }

  private decodeCursor(cursor: string): { createdAt: number; id: string } {
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { c?: unknown; i?: unknown };
      if (typeof parsed.c !== 'number' || typeof parsed.i !== 'string') throw new Error('bad shape');
      return { createdAt: parsed.c, id: parsed.i };
    } catch {
      throw new ValidationFailedException('Malformed pagination cursor.');
    }
  }
}
