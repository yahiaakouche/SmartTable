/**
 * Audit-log read DTOs — Step 3.8 (FR38 review capability, API Contract §3
 * `audit`: "GET /audit-log — cursor pagination, filterable by entityType,
 * entityId, actorEmployeeId, date range — Owner/Manager only").
 *
 * The entry mirrors the frozen `audit_log` schema (Database Schema §7) one
 * to one, with two deliberate read-side shapes:
 *  - old/new values are delivered as PARSED JSON (never raw strings) —
 *    field-level DTO design is an implementation-time artifact (Contract §7);
 *  - `actorName` rides alongside `actorEmployeeId` (Step 3.8 ruling B3(b)):
 *    a left join at read time, nullable for system-generated rows.
 */

export interface AuditLogEntryDto {
  id: string;
  /** Null for system-generated entries (D11 — first-class citizens). */
  actorEmployeeId: string | null;
  /** Ruling B3(b) — resolved via a left join; null when no actor is recorded. */
  actorName: string | null;
  /** Open vocabulary by design (Schema §7: "e.g., product, employee, table,
   * order") — filtering is exact-match over whatever the write path records. */
  entityType: string;
  entityId: string;
  action: string;
  /** Parsed old/new values (D6); null when the append recorded none. */
  oldValue: unknown;
  newValue: unknown;
  /** Epoch milliseconds — every timestamp this API emits. */
  createdAt: number;
}

export interface ListAuditLogResponse {
  data: AuditLogEntryDto[];
  meta: {
    /** Opaque base64url cursor (D1 — the notifications codec pattern);
     * null when this is the last page. */
    nextCursor: string | null;
  };
}
