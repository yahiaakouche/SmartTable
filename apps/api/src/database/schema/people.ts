import { sqliteTable, text, integer, check } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { uuidPk, boolFlag, createdAtColumn } from './_columns';

/** Section 2 of Database Schema Design. Role is a fixed enum — see EmployeeRole
 * in @smarttable/shared-types, kept in sync manually with this CHECK constraint. */
export const employees = sqliteTable(
  'employees',
  {
    id: uuidPk(),
    name: text('name').notNull(),
    role: text('role').notNull(),
    email: text('email'), // nullable
    passwordHash: text('password_hash'), // nullable until invitation accepted
    pinHash: text('pin_hash'), // nullable until invitation accepted
    isActive: boolFlag('is_active').notNull().default(true), // soft delete
    lastLoginAt: integer('last_login_at'), // nullable
    createdAt: createdAtColumn(),
  },
  (table) => ({
    roleCheck: check(
      'chk_employees_role',
      sql`${table.role} IN ('owner','manager','cashier','waiter','kitchen')`,
    ),
  }),
);

/** Fine-tuning layer over the hard-coded Guard baseline — Security Architecture §2.
 * Can only restrict further than the code-level baseline, never loosen it. */
export const rolePermissions = sqliteTable('role_permissions', {
  id: uuidPk(),
  role: text('role').notNull(),
  permissionKey: text('permission_key').notNull(),
  allowed: boolFlag('allowed').notNull(),
});

export const invitations = sqliteTable(
  'invitations',
  {
    id: uuidPk(),
    employeeId: text('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'restrict' }),
    tokenHash: text('token_hash').notNull(), // raw token never stored, same principle as passwords
    channel: text('channel').notNull(),
    status: text('status').notNull().default('pending'),
    expiresAt: integer('expires_at').notNull(),
    acceptedAt: integer('accepted_at'), // nullable
    createdAt: createdAtColumn(),
  },
  (table) => ({
    statusCheck: check(
      'chk_invitations_status',
      sql`${table.status} IN ('pending','accepted','revoked','expired')`,
    ),
    channelCheck: check('chk_invitations_channel', sql`${table.channel} IN ('link','qr','email')`),
    expiryOrderCheck: check('chk_invitations_expiry_order', sql`${table.expiresAt} > ${table.createdAt}`),
  }),
);

/** Device Trust layer — Security Architecture §1. Deliberately deferred from
 * the original Database Schema Design freeze, resolved in Security Architecture. */
export const refreshTokens = sqliteTable('refresh_tokens', {
  id: uuidPk(),
  employeeId: text('employee_id')
    .notNull()
    .references(() => employees.id, { onDelete: 'restrict' }),
  deviceLabel: text('device_label').notNull(),
  tokenHash: text('token_hash').notNull(),
  revokedAt: integer('revoked_at'), // nullable — Owner-triggered "revoke device"
  lastUsedAt: integer('last_used_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  createdAt: createdAtColumn(),
});
