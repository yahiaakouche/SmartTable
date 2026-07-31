import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, lt, or } from 'drizzle-orm';
import { DRIZZLE_CLIENT } from '../../database/database.module';
import type { DbClient } from '../../database/connection';
import { notifications } from '../../database/schema';

export const NOTIFICATIONS_REPOSITORY = Symbol('NOTIFICATIONS_REPOSITORY');

export interface NotificationRow {
  id: string;
  recipientRole: string | null;
  recipientEmployeeId: string | null;
  type: string;
  payloadJson: string;
  readAt: number | null;
  createdAt: number;
}

export interface NewNotification {
  recipientRole: string | null;
  recipientEmployeeId: string | null;
  type: string;
  payloadJson: string;
}

/** Keyset cursor position — (created_at, id) pair of the last row seen,
 * identical in shape and meaning to the orders cursor (Contract §1). */
export interface CursorPosition {
  createdAt: number;
  id: string;
}

/**
 * Persistence for the notifications domain (Database Schema Design §7 —
 * the table already exists since migration 0000; this module is its only
 * writer/reader).
 *
 * The table is NOT append-only like audit_log: `read_at` is the one frozen,
 * intentional mutation (POST /notifications/:id/read). To keep read history
 * truthful, markRead only ever SETS a null read_at — a first-read timestamp
 * is never overwritten by a repeat call (D7 idempotency).
 */
export interface NotificationsRepository {
  insert(entry: NewNotification): Promise<NotificationRow>;
  /** B4(a) recipient scope: rows targeting the caller's role OR the caller
   * personally; unreadOnly adds `read_at IS NULL`. Keyset-paginated,
   * newest first (same ordering as orders). */
  listForRecipient(
    role: string,
    employeeId: string,
    unreadOnly: boolean,
    cursor: CursorPosition | null,
    limit: number,
  ): Promise<NotificationRow[]>;
  findById(id: string): Promise<NotificationRow | null>;
  /** Sets read_at only where it is still NULL — repeat marks keep the
   * original first-read timestamp (D7). */
  markRead(id: string, readAt: number): Promise<void>;
}

@Injectable()
export class DrizzleNotificationsRepository implements NotificationsRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DbClient) {}

  async insert(entry: NewNotification): Promise<NotificationRow> {
    const rows = await this.db
      .insert(notifications)
      .values({
        recipientRole: entry.recipientRole,
        recipientEmployeeId: entry.recipientEmployeeId,
        type: entry.type,
        payloadJson: entry.payloadJson,
      })
      .returning();
    return rows[0];
  }

  async listForRecipient(
    role: string,
    employeeId: string,
    unreadOnly: boolean,
    cursor: CursorPosition | null,
    limit: number,
  ): Promise<NotificationRow[]> {
    const conditions = [
      or(eq(notifications.recipientRole, role), eq(notifications.recipientEmployeeId, employeeId))!,
      ...(unreadOnly ? [isNull(notifications.readAt)] : []),
      ...(cursor !== null
        ? [
            or(
              lt(notifications.createdAt, cursor.createdAt),
              and(eq(notifications.createdAt, cursor.createdAt), lt(notifications.id, cursor.id)),
            )!,
          ]
        : []),
    ];
    return this.db
      .select()
      .from(notifications)
      .where(and(...conditions))
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(limit);
  }

  async findById(id: string): Promise<NotificationRow | null> {
    const rows = await this.db.select().from(notifications).where(eq(notifications.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async markRead(id: string, readAt: number): Promise<void> {
    await this.db
      .update(notifications)
      .set({ readAt })
      .where(and(eq(notifications.id, id), isNull(notifications.readAt)));
  }
}
