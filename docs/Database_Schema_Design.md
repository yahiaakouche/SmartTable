# SmartTable — Database Schema Design (Engineering Blueprint)

**Status:** FROZEN — official database architecture, no implementation yet (per instruction)
**Database engine:** SQLite (better-sqlite3, WAL mode) — see Technology Stack Decisions
**Companion documents:** PRD v1.3, Engineering Standards, Real-Time Architecture Decisions

---

## Naming Conventions

| Element | Convention | Example |
|---|---|---|
| Table names | `snake_case`, plural | `order_items`, `sales_rollup_daily` |
| Column names | `snake_case` | `created_at`, `price_minor` |
| Primary key | Always `id` | never `order_id` inside the `orders` table itself |
| Foreign key | `<singular_entity>_id` | `employee_id`, `table_id`, `category_id` |
| Boolean columns | `is_`/`has_` prefix, stored as `INTEGER (0/1)` (SQLite has no native boolean) | `is_active`, `is_addon`, `is_available` |
| Money columns | suffix `_minor` | `price_minor`, `amount_minor`, `revenue_minor` — the suffix is mandatory and non-negotiable, so a raw `price` column name can never silently reintroduce ambiguity about units |
| Timestamp columns | suffix `_at`, always epoch milliseconds | `created_at`, `accepted_at`, `expires_at` |
| Snapshot columns | suffix `_snapshot` | `name_snapshot`, `unit_price_minor_snapshot` — makes immutability intent visible in the column name itself, not just in documentation |
| Enum-like text columns | lowercase, `snake_case` values | `status = 'needs_cleaning'`, `channel = 'dine_in'` |
| Index names | `idx_<table>_<column(s)>` | `idx_orders_status`, `idx_tables_qr_token` |
| Foreign key constraint names | `fk_<table>_<referenced_table>` | `fk_orders_table_bill_groups` |

---

## Cross-Cutting Rules (apply to every table below)

1. **Primary keys:** UUID v7 (time-ordered), stored as `TEXT`, for every table except where noted.
2. **Timestamps:** `INTEGER` — Unix epoch milliseconds, UTC. No string dates anywhere (one deliberate exception: `sales_rollup_*.date`, explained in Section 8).
3. **Money:** `INTEGER` — minor currency units only (e.g., centimes). Never `REAL`/`FLOAT`.
4. **Foreign keys:** `PRAGMA foreign_keys = ON` enforced on every connection at Host startup — non-negotiable, since SQLite disables this by default. Every FK below defaults to `ON DELETE RESTRICT` unless explicitly noted otherwise (e.g., `ON DELETE SET NULL` for `products`).
5. **Soft delete:** `is_active INTEGER (0/1) NOT NULL DEFAULT 1` on entities referenced by historical records (Employees, Tables, Halls, Categories). Hard delete permitted only on entities protected by Snapshot data (Products).
6. **Every table has:** `id` (UUID v7 PK, `NOT NULL`), `created_at` (epoch ms, `NOT NULL`). Mutable tables also have `updated_at` (`NOT NULL`, updated on every write).
7. **NOT NULL by default:** every column is `NOT NULL` unless explicitly marked `(nullable)` in the tables below — nullability is always an intentional, documented choice, never an oversight.

---

## 1. Restaurant Configuration

### `restaurant_profile` (single logical row)
| Column | Type | Notes |
|---|---|---|
| id | TEXT (PK) | |
| name | TEXT | |
| logo_path | TEXT (nullable) | local file path served statically |
| primary_color | TEXT | hex |
| secondary_color | TEXT | hex |
| currency_code | TEXT | default `DZD` |
| tax_rate_percent | INTEGER | stored as integer basis points (e.g., 1900 = 19.00%) to avoid float tax math entirely |
| default_language | TEXT | `ar` \| `fr` |
| setup_completed_at | INTEGER (nullable) | null until Setup Wizard finishes |
| updated_at | INTEGER | |

### `halls`
| Column | Type | Notes |
|---|---|---|
| id | TEXT (PK) | |
| name | TEXT | e.g., "Main Hall", "Terrace" |
| sort_order | INTEGER | |
| is_active | INTEGER | soft delete |

---

## 2. People & Access

### `employees`
| Column | Type | Notes |
|---|---|---|
| id | TEXT (PK) | |
| name | TEXT | |
| role | TEXT | enum: `owner`,`manager`,`cashier`,`waiter`,`kitchen` — fixed set in v1, see note below |
| email | TEXT (nullable) | |
| password_hash | TEXT (nullable) | null until invitation accepted |
| pin_hash | TEXT (nullable) | separate from password, for fast terminal login |
| is_active | INTEGER | soft delete |
| last_login_at | INTEGER (nullable) | |
| created_at | INTEGER | |

**Design note (challenging an assumption):** Roles are stored as a fixed enum, not a separate freely-editable `roles` table, because PRD v1.3 defines exactly 5 fixed roles — a fully dynamic role system is a materially larger feature (custom role creation, arbitrary permission composition) not in scope. However, see `role_permissions` below for the actual configurability the PRD does require ("Manage role permissions").

### `role_permissions`
| Column | Type | Notes |
|---|---|---|
| id | TEXT (PK) | |
| role | TEXT | enum, matches `employees.role` |
| permission_key | TEXT | e.g., `order.accept`, `order.cancel`, `menu.edit` |
| allowed | INTEGER (0/1) | |

**Design note:** This table lets the Owner's "Manage role permissions" screen do something real without a code deploy for *minor* tweaks. However, this is a **defense-in-depth secondary check**, not the sole gate — the hard-coded permission matrix (PRD Section 11) remains enforced in NestJS Guards as the authoritative baseline for security-critical transitions (Paid/Completed, Cancel). A DB-only permission system for financial state transitions would let a misconfigured row silently create a security hole; Guards + DB-backed fine-tuning together avoid that.

### `invitations`
| Column | Type | Notes |
|---|---|---|
| id | TEXT (PK) | |
| employee_id | TEXT (FK → employees) | |
| token_hash | TEXT | never store the raw token, only its hash (same principle as passwords) |
| channel | TEXT | `link` \| `qr` \| `email` |
| status | TEXT | `pending` \| `accepted` \| `revoked` \| `expired` |
| expires_at | INTEGER | |
| accepted_at | INTEGER (nullable) | |
| created_at | INTEGER | |

---

## 3. Tables & Bill Groups

### `tables`
| Column | Type | Notes |
|---|---|---|
| id | TEXT (PK) | |
| hall_id | TEXT (FK → halls) | |
| label | TEXT | e.g., "Table 5" |
| qr_token | TEXT (UNIQUE) | cryptographically random, **independent of the UUID PK** (see Cross-Cutting decisions above) |
| status | TEXT | `available` \| `occupied` \| `bill_requested` \| `needs_cleaning` |
| is_active | INTEGER | soft delete |
| updated_at | INTEGER | |

*Index:* unique index on `qr_token` (this is the lookup path for every customer QR request — must be O(1)).

### `table_bill_groups`
| Column | Type | Notes |
|---|---|---|
| id | TEXT (PK) | |
| table_id | TEXT (FK → tables) | |
| status | TEXT | `open` \| `closed` |
| opened_at | INTEGER | auto-set on first order of a visit |
| closed_at | INTEGER (nullable) | auto-set when payment completes / table → needs_cleaning |

*Index:* on `(table_id, status)` — the hot lookup path is "find the currently open bill group for this table."

---

## 4. Menu

### `categories`
| Column | Type | Notes |
|---|---|---|
| id | TEXT (PK) | |
| name_ar | TEXT | |
| name_fr | TEXT | |
| sort_order | INTEGER | |
| is_active | INTEGER | |

### `products`
| Column | Type | Notes |
|---|---|---|
| id | TEXT (PK) | |
| category_id | TEXT (FK → categories, `ON DELETE SET NULL`) | |
| name_ar | TEXT | |
| name_fr | TEXT | |
| price_minor | INTEGER | |
| image_path | TEXT (nullable) | |
| is_available | INTEGER | drives QR menu visibility (FR31 real-time propagation) |
| sort_order | INTEGER | |
| created_at | INTEGER | |
| updated_at | INTEGER | |

*Products support hard delete* — protected by Order Item Snapshot below.

---

## 5. Orders

### `orders`
| Column | Type | Notes |
|---|---|---|
| id | TEXT (PK) | |
| table_bill_group_id | TEXT (FK → table_bill_groups) | |
| table_id | TEXT (FK → tables) | denormalized for query convenience |
| channel | TEXT | `dine_in` (v1 active) \| `delivery` (reserved, FR39) |
| is_addon | INTEGER (0/1) | true if not the first order in its bill group |
| status | TEXT | `pending`\|`accepted`\|`preparing`\|`ready`\|`served`\|`paid`\|`completed`\|`cancelled` |
| source | TEXT | `qr` \| `waiter_manual` |
| created_by_employee_id | TEXT (FK → employees, nullable) | null if `source = qr` |
| accepted_by_employee_id | TEXT (nullable) | |
| served_by_employee_id | TEXT (nullable) | |
| cancelled_by_employee_id | TEXT (nullable) | |
| cancellation_reason | TEXT (nullable) | |
| created_at | INTEGER | |
| updated_at | INTEGER | |

*Index:* on `(table_bill_group_id)`, on `(status)` (hot path for KDS board query), on `(table_id, status)`.

### `order_items`
| Column | Type | Notes |
|---|---|---|
| id | TEXT (PK) | |
| order_id | TEXT (FK → orders) | |
| product_id | TEXT (FK → products, `ON DELETE SET NULL`) | kept for analytics joins where the product still exists |
| name_snapshot | TEXT | **immutable copy**, per FR40 |
| category_snapshot | TEXT | immutable copy |
| unit_price_minor_snapshot | INTEGER | immutable copy |
| quantity | INTEGER | |
| notes | TEXT (nullable) | e.g., "no onions" |

### `order_status_events`
| Column | Type | Notes |
|---|---|---|
| id | TEXT (PK) | |
| order_id | TEXT (FK → orders) | |
| from_status | TEXT (nullable) | |
| to_status | TEXT | |
| actor_employee_id | TEXT (nullable) | null for system-driven transitions |
| created_at | INTEGER | |

*Purpose:* high-frequency operational event stream — feeds Average Preparation Time, Peak Sales Hour, and general lifecycle traceability. Deliberately separate from `audit_log` (see cross-cutting decision 3 above).

---

## 6. Payments & Shifts

### `payments`
| Column | Type | Notes |
|---|---|---|
| id | TEXT (PK) | |
| table_bill_group_id | TEXT (FK → table_bill_groups) | payment is against the consolidated bill group, not a single order |
| amount_minor | INTEGER | |
| method | TEXT | `cash` (v1 active) \| reserved values for future digital methods |
| collected_by_employee_id | TEXT (FK → employees) | |
| shift_id | TEXT (FK → shifts, nullable) | |
| created_at | INTEGER | |

### `shifts`
| Column | Type | Notes |
|---|---|---|
| id | TEXT (PK) | |
| employee_id | TEXT (FK → employees) | cashier |
| opening_cash_minor | INTEGER | |
| closing_cash_minor | INTEGER (nullable) | |
| expected_cash_minor | INTEGER (nullable) | computed at close |
| status | TEXT | `open` \| `closed` |
| opened_at | INTEGER | |
| closed_at | INTEGER (nullable) | |

---

## 7. Auditing & Notifications

### `audit_log` (administrative, low-frequency — see cross-cutting decision 3)
| Column | Type | Notes |
|---|---|---|
| id | TEXT (PK) | |
| actor_employee_id | TEXT (nullable) | |
| entity_type | TEXT | e.g., `product`, `employee`, `table`, `order` |
| entity_id | TEXT | |
| action | TEXT | e.g., `price_changed`, `role_changed`, `qr_regenerated`, `order_completed` |
| old_value_json | TEXT (nullable) | |
| new_value_json | TEXT (nullable) | |
| created_at | INTEGER | |

**Append-only enforcement:** no `UPDATE`/`DELETE` code path may ever target this table — enforced at the Repository layer (the `AuditRepository` interface exposes only an `append()` method, no update/delete methods exist to call).

### `notifications`
| Column | Type | Notes |
|---|---|---|
| id | TEXT (PK) | |
| recipient_role | TEXT (nullable) | broadcast to a role |
| recipient_employee_id | TEXT (nullable) | or a specific employee |
| type | TEXT | e.g., `order_ready`, `bill_requested`, `invitation_accepted` |
| payload_json | TEXT | |
| read_at | INTEGER (nullable) | |
| created_at | INTEGER | |

---

## 8. Analytics (Hybrid Architecture)

### `sales_rollup_daily`
| Column | Type | Notes |
|---|---|---|
| date | TEXT (PK) | `YYYY-MM-DD`, the one deliberate exception to "no string dates" — this is a grouping key, never compared/sorted as a date object, so plain lexicographic string sort is correct and simplest |
| total_revenue_minor | INTEGER | |
| dine_in_revenue_minor | INTEGER | |
| delivery_revenue_minor | INTEGER | 0 until Delivery ships |
| total_orders | INTEGER | |
| cancelled_orders | INTEGER | |
| updated_at | INTEGER | |

### `sales_rollup_hourly`
| Column | Type | Notes |
|---|---|---|
| date | TEXT | `YYYY-MM-DD` |
| hour | INTEGER | 0–23 |
| revenue_minor | INTEGER | |
| orders_count | INTEGER | |

*Composite primary key:* `(date, hour)`. Powers Peak Sales Hour without scanning raw orders.

**Update mechanism:** both rollup tables are updated **synchronously, in the same database transaction** as the order's `Completed` transition — not by a nightly batch job. Given single-restaurant data volume, this keeps rollups always consistent with zero eventual-consistency window, and avoids needing a job scheduler as a new moving part.

### `product_sales_rollup` (supports Best Selling Product/Category without scanning all order_items historically)
| Column | Type | Notes |
|---|---|---|
| date | TEXT | |
| product_name_snapshot | TEXT | grouped by snapshot name, consistent with historical accuracy |
| category_snapshot | TEXT | |
| quantity_sold | INTEGER | |
| revenue_minor | INTEGER | |

---

## 9. Backups

### `backup_history`
| Column | Type | Notes |
|---|---|---|
| id | TEXT (PK) | |
| file_path | TEXT | |
| size_bytes | INTEGER | |
| status | TEXT | `success` \| `failed` |
| created_at | INTEGER | |

*Purpose:* backs the Host's "Backup status monitoring" responsibility (frozen in the Host Application design) with real data instead of just filesystem inspection.

---

## Appendix A — Complete Constraints Reference

Beyond the per-table `NOT NULL`/FK rules already noted inline, the following `CHECK` constraints are mandatory at the schema level (not just application-layer validation, per Engineering Standards Section 6 — the database is the last line of defense for data integrity, application validation is the first, not the only, line):

| Table | Constraint | Reason |
|---|---|---|
| `employees` | `CHECK (role IN ('owner','manager','cashier','waiter','kitchen'))` | fixed role enum |
| `invitations` | `CHECK (status IN ('pending','accepted','revoked','expired'))` | |
| `invitations` | `CHECK (expires_at > created_at)` | prevents a logically invalid invitation from ever being written |
| `tables` | `CHECK (status IN ('available','occupied','bill_requested','needs_cleaning'))` | |
| `table_bill_groups` | `CHECK (status IN ('open','closed'))` | |
| `table_bill_groups` | `CHECK ((status = 'open' AND closed_at IS NULL) OR (status = 'closed' AND closed_at IS NOT NULL))` | enforces the state/timestamp pair can never contradict itself |
| `products` | `CHECK (price_minor >= 0)` | |
| `orders` | `CHECK (channel IN ('dine_in','delivery'))` | |
| `orders` | `CHECK (status IN ('pending','accepted','preparing','ready','served','paid','completed','cancelled'))` | |
| `orders` | `CHECK (source IN ('qr','waiter_manual'))` | |
| `orders` | `CHECK ((status = 'cancelled' AND cancellation_reason IS NOT NULL) OR status != 'cancelled')` | makes FR10 (mandatory cancellation reason) a database-enforced guarantee, not just an API-layer convention |
| `order_items` | `CHECK (quantity > 0)` | |
| `order_items` | `CHECK (unit_price_minor_snapshot >= 0)` | |
| `payments` | `CHECK (amount_minor > 0)` | |
| `payments` | `CHECK (method IN ('cash'))` | intentionally restrictive in v1 — extending this list is a one-line migration when digital payments ship (v3), not a redesign |
| `shifts` | `CHECK (status IN ('open','closed'))` | |
| `restaurant_profile` | `CHECK (default_language IN ('ar','fr'))` | |
| `restaurant_profile` | `CHECK (tax_rate_percent >= 0)` | |
| `backup_history` | `CHECK (status IN ('success','failed'))` | |

## Appendix B — Complete Index Reference

Every index that exists purely to make a known hot query path fast (not just PK/unique lookups, which SQLite indexes automatically):

| Index Name | Table | Columns | Purpose |
|---|---|---|---|
| `idx_tables_qr_token` | tables | `qr_token` (UNIQUE) | O(1) lookup on every customer QR scan — the single most frequent read in the system |
| `idx_table_bill_groups_table_status` | table_bill_groups | `(table_id, status)` | "find the open bill group for this table" — hit on every order placed |
| `idx_orders_status` | orders | `(status)` | Kitchen Display Screen board query, filtered by status |
| `idx_orders_bill_group` | orders | `(table_bill_group_id)` | consolidated billing lookup at payment time |
| `idx_orders_table_status` | orders | `(table_id, status)` | table map live-status rendering |
| `idx_order_items_order` | order_items | `(order_id)` | fetching all items for a given order |
| `idx_order_status_events_order` | order_status_events | `(order_id, created_at)` | reconstructing an order's timeline, and prep-time analytics |
| `idx_payments_bill_group` | payments | `(table_bill_group_id)` | |
| `idx_audit_log_entity` | audit_log | `(entity_type, entity_id)` | "show me the history of this specific product/employee" |
| `idx_audit_log_created_at` | audit_log | `(created_at)` | chronological audit review |
| `idx_notifications_recipient` | notifications | `(recipient_employee_id, read_at)` | unread-notifications query per employee |
| `idx_sales_rollup_hourly_date` | sales_rollup_hourly | `(date)` | BI Dashboard date-range queries |
| `idx_product_sales_rollup_date` | product_sales_rollup | `(date)` | Best Selling Product queries |
| `idx_invitations_employee` | invitations | `(employee_id)` | |
| `idx_role_permissions_role` | role_permissions | `(role)` | |

**Design principle applied throughout:** every index above exists because it backs a *named, already-designed* query from either the UX Blueprint or the BI Dashboard KPIs — this schema deliberately avoids "just in case" indexes, since every extra index has a real write-performance cost on every `INSERT`/`UPDATE`, and SQLite's single-writer model (Cross-Cutting Rule 4 from the Database Selection step) makes write latency a shared cost across every connected device, not a free resource to spend speculatively.

---

## Entity Relationship Summary

```
restaurant_profile (singleton)

halls 1──* tables 1──* table_bill_groups 1──* orders 1──* order_items
                                                    │
                                                    └──* order_status_events

table_bill_groups 1──* payments ──* shifts

categories 1──* products ──(snapshot, decoupled)──> order_items

employees 1──* invitations
employees 1──* role_permissions (via role enum, not FK)
employees ──(actor)──> audit_log, order_status_events, payments, shifts

orders ──(on Completed, same transaction)──> sales_rollup_daily / sales_rollup_hourly / product_sales_rollup
```

**Deliberately not yet defined:** session/token storage (e.g., `refresh_tokens` or equivalent) is intentionally excluded from this schema freeze. It depends on the authentication mechanism decision (JWT vs. server-side sessions) that belongs to the upcoming Auth & Security Architecture step, not to database design in isolation — defining it now would mean guessing at a decision not yet made, which this process has consistently avoided.

---

## Migration & Startup Integrity (ties to Host Application design)

- Schema migrations are plain, version-controlled SQL files (Drizzle Kit output), applied automatically by the Host on startup, before the API layer accepts any connection.
- Immediately after migrations run, the Host performs `PRAGMA integrity_check` — this is the concrete mechanism behind the "Startup Integrity Check" responsibility frozen earlier in the Host Application design, closing that previously-deferred item.
- If integrity check fails, the Host halts startup and directs the Owner to the Backup & Restore flow rather than allowing the API to start against a potentially corrupted file.

---

*This schema is the direct translation of every frozen product decision (PRD v1.3) into engineering structure. Nothing here introduces a new product decision — where a trade-off touched product scope (e.g., role permission configurability), it was resolved conservatively in favor of the already-approved PRD behavior.*
