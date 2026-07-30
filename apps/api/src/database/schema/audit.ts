import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { uuidPk, createdAtColumn } from './_columns';
import { employees } from './people';

/** Append-only. No UPDATE/DELETE code path may ever target this table —
 * enforced at the Repository layer: AuditRepository exposes only append(),
 * no update/delete methods exist to call (Database Schema Design §7,
 * reaffirmed as NFR16 in the frozen PRD). */
export const auditLog = sqliteTable(
  'audit_log',
  {
    id: uuidPk(),
    actorEmployeeId: text('actor_employee_id').references(() => employees.id), // nullable
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    action: text('action').notNull(),
    oldValueJson: text('old_value_json'), // nullable
    newValueJson: text('new_value_json'), // nullable
    createdAt: createdAtColumn(),
  },
  (table) => ({
    entityIdx: index('idx_audit_log_entity').on(table.entityType, table.entityId),
    createdAtIdx: index('idx_audit_log_created_at').on(table.createdAt),
  }),
);

export const notifications = sqliteTable(
  'notifications',
  {
    id: uuidPk(),
    recipientRole: text('recipient_role'), // nullable — broadcast to a role
    recipientEmployeeId: text('recipient_employee_id').references(() => employees.id), // nullable
    type: text('type').notNull(),
    payloadJson: text('payload_json').notNull(),
    readAt: integer('read_at'), // nullable
    createdAt: createdAtColumn(),
  },
  (table) => ({
    recipientIdx: index('idx_notifications_recipient').on(table.recipientEmployeeId, table.readAt),
  }),
);
