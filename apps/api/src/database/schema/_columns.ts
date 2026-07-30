import { text, integer } from 'drizzle-orm/sqlite-core';
import { v7 as uuidv7 } from 'uuid';

/**
 * Cross-cutting column helpers — Database Schema Design, "Cross-Cutting Rules".
 * Every table in this schema uses these instead of ad hoc column definitions,
 * so the frozen conventions (UUID v7 PKs, epoch-ms timestamps) can never be
 * silently violated by a new table added later.
 */

/** UUID v7 primary key — ADR-007. Time-ordered, so index locality stays good
 * even though the value is globally unique (unlike a plain autoincrement int),
 * which is what makes a future multi-restaurant SaaS data merge realistic. */
export const uuidPk = () =>
  text('id')
    .primaryKey()
    .$defaultFn(() => uuidv7());

/** Epoch-millisecond integer timestamp — ADR-008. Never a string date. */
export const epochMs = (name: string) => integer(name, { mode: 'number' });

export const createdAtColumn = () =>
  epochMs('created_at')
    .notNull()
    .$defaultFn(() => Date.now());

export const updatedAtColumn = () =>
  epochMs('updated_at')
    .notNull()
    .$defaultFn(() => Date.now());

/** Money is always an integer minor-unit column — never REAL/FLOAT. Naming
 * convention: caller must suffix the column name with `_minor` themselves. */
export const moneyMinor = (name: string) => integer(name, { mode: 'number' });

/** Boolean columns — SQLite has no native boolean; stored as 0/1 integers,
 * mapped to real booleans in application code via Drizzle's boolean mode. */
export const boolFlag = (name: string) => integer(name, { mode: 'boolean' });
