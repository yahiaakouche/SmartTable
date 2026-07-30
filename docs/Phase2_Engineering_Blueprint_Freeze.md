# SmartTable — Phase 2 Engineering Blueprint Freeze

**Status:** OFFICIAL — Phase 2 (System Architecture & Database Design) FROZEN
**Companion documents (source of truth for full reasoning):** Engineering Standards, Database Schema Design, API Contract Design, Security Architecture, Hardware Integration Architecture, Backup & Resilience Architecture, Installer & Auto-Update Architecture, Unified Monitoring Architecture
**Product baseline:** PRD v1.3 (frozen), MVP Scope Freeze

This document is the single, top-level index and freeze record for the entire engineering foundation. It **summarizes and references** every Phase 2 decision — it does not restate full trade-off analysis, which remains in each source document. Where a summary here and a source document ever appear to conflict, **the source document is authoritative**; this index should be corrected to match it, never the other way around.

---

## 1. System Topology

Electron desktop host application, running on the restaurant's primary machine (Cashier station or dedicated Mini PC), embedding a Node.js server internally. All other devices (waiter tablets, kitchen screens, customer phones) connect as browser clients over the local network — no per-device installation required. The host machine must remain powered on and awake during operating hours. *(Full reasoning: Technology Stack discussion, Step 2.1)*

## 2. Technology Stack

| Layer | Decision |
|---|---|
| Host application | Electron |
| Backend runtime/framework | Node.js + NestJS + TypeScript |
| Database engine | SQLite via `better-sqlite3`, WAL mode |
| Data access layer | Drizzle ORM, Repository pattern behind interfaces, Promise-based signatures |
| Real-time (staff) | Socket.IO, room-based |
| Real-time (customer) | Server-Sent Events (SSE) |
| Internal event bus | Node `EventEmitter` (no Redis/message broker in v1) |
| API style | REST + auto-generated OpenAPI (`@nestjs/swagger`) |
| Installer | electron-builder, NSIS, code-signed |

*(Full reasoning and rejected alternatives: Technology Stack discussion, Steps 2.1–2.4)*

## 3. Engineering Standards

Mandatory, binding on all future code: monorepo structure (`apps/host`, `apps/api`, `apps/web`, `packages/shared-types`), one NestJS module per business domain, thin controllers / logic-bearing services, constructor-only dependency injection, DTO-based validation with global whitelist enforcement, centralized exception handling via domain exceptions, structured logging, typed configuration with fail-fast startup validation, mandatory unit/integration/E2E testing tiers (especially for money and lifecycle logic), and a strict naming convention. Raw SQL string concatenation is forbidden (Drizzle parameterized queries only). *(Full detail: Engineering Standards document)*

## 4. Database Architecture

UUID v7 primary keys throughout; epoch-millisecond integer timestamps; integer-minor-unit money storage with an explicit tax field; strict `NOT NULL`-by-default with documented exceptions; foreign keys enforced (`PRAGMA foreign_keys = ON`); soft delete for historically-referenced entities (Employees, Tables, Halls, Categories), hard delete permitted for Products (protected by Order Item Snapshots). Full entity set: restaurant configuration, employees/invitations/role permissions, halls/tables/table bill groups, categories/products, orders/order items/order status events, payments/shifts, audit log, notifications, three-tier sales rollups (daily/hourly/product), backup history. Complete `CHECK` constraint and index appendices are part of the source document. *(Full detail: Database Schema Design document)*

## 5. API Architecture

REST over `/api/v1/`, consistent success/error response envelopes, cursor pagination for unbounded-growth resources and offset pagination for bounded ones, mandatory `Idempotency-Key` on financial-mutation endpoints, two-tier authentication (long-lived Device Trust refresh token + short-lived Acting Employee JWT enabling fast PIN-based operator switching on shared terminals without reconnecting), and a full endpoint catalog across all modules (auth, setup-wizard, employees/invitations, tables/halls, menu, orders, billing, analytics, audit, notifications, backup, config, diagnostics). *(Full detail: API Contract Design document)*

## 6. Security Architecture

Argon2id password/PIN hashing with lockout policy; dual-layer authorization (hard-coded Guards as authoritative baseline + DB-configurable `role_permissions` for fine-tuning, never able to grant beyond the code baseline); split transport security (mandatory HTTPS for the staff/WebSocket channel via a locally-generated certificate installed during employee invitation acceptance; accepted-risk plain HTTP for the unauthenticated customer QR channel); no application-level database encryption (relies on OS-level full-disk encryption instead, with encrypted backup-file export as the actual higher-risk artifact); secrets stored via Electron `safeStorage`; per-route-class rate limiting; content-sniffing/re-encoding file upload security; a named "Active Devices" revocation capability (`refresh_tokens` table). All security-relevant events flow into the single Audit Log — no parallel security log. *(Full detail: Security Architecture document)*

## 7. Hardware Integration

A capability-interface Hardware Abstraction Layer, with only the network receipt/kitchen printer (ESC/POS over TCP/IP, port 9100) active in v1. Barcode Scanner (HID keyboard-wedge, zero integration needed when eventually activated per PRD's v2 timeline), Cash Drawer (piggybacks on the existing printer connection when/if approved), and Customer Display (a genuinely separate future hardware category) are defined at the interface level only — **not activated**, per PRD scope governance. Kitchen Display "integration" required no new design — it is simply the existing browser-based Kitchen dashboard. Hardware failures never block or reverse business-state transitions. *(Full detail: Hardware Integration Architecture document)*

## 8. Backup & Resilience

Dual backup mechanism: automatic zero-configuration safety-net snapshots (every 6 hours + clean shutdown, rolling 7-snapshot retention) alongside the existing Owner-triggered manual backup — both using SQLite's `VACUUM INTO` for consistency, both verified via post-backup integrity check before being trusted. Crash recovery relies on SQLite WAL, confirmed by a startup sequence (`quick_check` → conditional recovery attempt → migrations → periodic full `integrity_check`) that never silently starts against untrusted data. Disaster recovery (total machine loss) is named as an honest, unautomated gap requiring manual off-machine backup copies, documented in onboarding. *(Full detail: Backup & Resilience Architecture document)*

## 9. Installer & Auto-Update

NSIS installer via electron-builder, code-signed, silent-install-capable. Self-hosted (non-public) update feed via `electron-updater`; updates download silently but **never auto-install/restart while active orders exist**, requiring explicit Owner confirmation by default (with an opt-in "Quiet Hours" window for full automation). Previous installer retained locally for manual rollback; every schema migration is preceded by an automatic tagged backup snapshot as the real rollback safety net. Strict separation between versioned application code and persistent user data, so a rollback can never lose data by construction. Licensing/activation enforcement remains explicitly deferred and separate from update delivery. *(Full detail: Installer & Auto-Update Architecture document)*

## 10. Monitoring Architecture

Three distinct, non-overlapping record-keeping systems (rotating 14-day Application Logs; permanent append-only Audit Log; permanent Order Status Events for analytics). Structured JSON logging throughout. A unified, pluggable Health Check Registry (database, real-time channel, printer, disk space, backup status, update status) aggregated into one status feeding both the Owner's simple ambient indicator and the full technical Diagnostics page — which is itself the entire monitoring dashboard, with no separate external tool. Opt-in (default off), local-first crash reporting. Lightweight, log-derived performance monitoring with no APM tooling. Structured logs are the deliberate enabler of any future centralized observability, should the optional SaaS track ever be pursued. *(Full detail: Unified Monitoring Architecture document)*

---

## 11. Consolidated Architectural Decision Record (ADR) Registry

Every major decision made across Phase 2, indexed for quick reference. Full Context/Alternatives/Consequences reasoning for each lives in the referenced source document — this registry is the map, not the territory.

| ID | Decision | Rejected Alternatives | Source |
|---|---|---|---|
| ADR-001 | Electron as desktop host | Tauri, headless Windows Service | Tech Stack, 2.1 |
| ADR-002 | NestJS + TypeScript backend | Express, Fastify | Tech Stack, 2.1 |
| ADR-003 | SQLite + better-sqlite3 + WAL | PostgreSQL, MySQL/MariaDB | Tech Stack, 2.2 |
| ADR-004 | Drizzle ORM | TypeORM, Prisma, Kysely | Tech Stack, 2.3 |
| ADR-005 | Repository pattern, Promise-based interfaces over sync driver | Direct sync calls exposed | Tech Stack, 2.3 |
| ADR-006 | Socket.IO (staff) + SSE (customer), no Redis | Single unified WebSocket for all clients; Redis-backed pub/sub | Real-Time Architecture, 2.4 |
| ADR-007 | UUID v7 primary keys | Integer autoincrement, UUID v4 | Database Schema, 2.5 |
| ADR-008 | Epoch-millisecond integer timestamps | ISO 8601 strings | Database Schema, 2.5 |
| ADR-009 | Integer minor-unit money + explicit tax field | Float/decimal storage | Money & Tax Model (pre-Phase-2 product decision, carried into schema) |
| ADR-010 | Separate Audit Log vs Order Status Events tables | Single unified audit table | Database Schema, 2.5 |
| ADR-011 | Presence tracked in-memory only | Persisting presence to DB | Database Schema, 2.5 |
| ADR-012 | Soft delete (Employees/Tables) vs hard delete (Products) | Uniform delete policy | Database Schema, 2.5 |
| ADR-013 | REST + OpenAPI | GraphQL, tRPC | API Contract, 2.6 |
| ADR-014 | Lightweight `/api/v1` versioning, no multi-version support | Full multi-version API strategy | API Contract, 2.6 |
| ADR-015 | Standard success/error response envelope | Ad hoc per-endpoint response shapes | API Contract, 2.6 |
| ADR-016 | Cursor pagination (unbounded) + offset pagination (bounded) | Uniform offset pagination | API Contract, 2.6 |
| ADR-017 | `Idempotency-Key` on financial mutations | No duplicate-submission protection | API Contract, 2.6 |
| ADR-018 | Two-tier auth: Device Trust + Acting Employee JWT | Single session model requiring full reconnect per PIN switch | API Contract, 2.6 |
| ADR-019 | Split transport security: HTTPS (staff) / HTTP (customer, accepted risk) | Uniform HTTPS everywhere; uniform HTTP everywhere | Security Architecture, 2.7 |
| ADR-020 | No app-level DB encryption; rely on OS full-disk encryption + encrypted backup export | SQLCipher | Security Architecture, 2.7 |
| ADR-021 | Secrets via Electron `safeStorage` | Custom secret storage, plaintext config | Security Architecture, 2.7 |
| ADR-022 | Per-route-class rate limiting (`@nestjs/throttler`) | Uniform global rate limit | Security Architecture, 2.7 |
| ADR-023 | File upload: content-sniffing + format allow-list + mandatory re-encoding | Extension/MIME-based trust | Security Architecture, 2.7 |
| ADR-024 | Capability-interface Hardware Abstraction Layer | Device-specific integration code per feature | Hardware Integration, 2.8 |
| ADR-025 | Network/ESC-POS printer only | USB-direct printer | Hardware Integration, 2.8 |
| ADR-026 | Barcode scanner: HID keyboard-wedge only, abstraction-ready | Raw serial/USB scanner as primary support | Hardware Integration, 2.8 |
| ADR-027 | Cash Drawer / Customer Display: abstraction-only, not activated | Building either feature now | Hardware Integration, 2.8 |
| ADR-028 | Dual backup (automatic safety-net + manual), via `VACUUM INTO` | Manual-only backup; raw file copy | Backup & Resilience, 2.9 |
| ADR-029 | Mandatory post-backup integrity verification | Trusting backup creation without verification | Backup & Resilience, 2.9 |
| ADR-030 | WAL-based crash recovery + formal startup integrity sequence | Custom crash-recovery logic | Backup & Resilience, 2.9 |
| ADR-031 | Disaster recovery gap named explicitly, manual mitigation only | Silent gap; premature cloud-backup build | Backup & Resilience, 2.9 |
| ADR-032 | NSIS installer, code-signed | Unsigned installer; MSI as primary | Installer & Auto-Update, 2.10 |
| ADR-033 | Self-hosted update feed; never auto-restart during active service | Public GitHub Releases; fully automatic silent updates | Installer & Auto-Update, 2.10 |
| ADR-034 | Pre-migration automatic backup snapshot as rollback safety net | Building a separate schema-rollback engine | Installer & Auto-Update, 2.10 |
| ADR-035 | Three-tier structured logging (App Logs / Audit Log / Order Status Events) | Single unified log table | Monitoring, 2.11 |
| ADR-036 | Unified pluggable Health Check Registry | Ad hoc, per-subsystem health checks | Monitoring, 2.11 |
| ADR-037 | Opt-in, local-first crash reporting | Always-on remote crash reporting; no crash reporting at all | Monitoring, 2.11 |
| ADR-038 | Log-derived performance monitoring, no APM tooling | Dedicated APM/metrics platform | Monitoring, 2.11 |

---

## 12. Document Map

| Document | Covers |
|---|---|
| PRD v1.3 | Product scope (frozen baseline) |
| MVP Scope Freeze | Product scope governance |
| Engineering Standards | Coding rules, module structure, testing |
| Database Schema Design | Full schema, constraints, indexes |
| API Contract Design | Endpoints, conventions, real-time contracts |
| Security Architecture | Auth, encryption, rate limiting, attack prevention |
| Hardware Integration Architecture | Printer, HAL, deferred devices |
| Backup & Resilience Architecture | Backup, crash recovery, integrity |
| Installer & Auto-Update Architecture | Distribution, updates, migrations-in-the-field |
| Unified Monitoring Architecture | Logging, health, diagnostics, crash reporting |
| **Phase 2 Engineering Blueprint Freeze** (this document) | Index and freeze record for all of the above |

---

## 13. Freeze Statement

**Phase 2 (System Architecture & Database Design) is FROZEN as of this document.** Every decision indexed above is approved and binding on Phase 3 implementation. Consistent with the governance rule already established in the MVP Scope Freeze: any future change to an ADR listed here is a **formal architectural change**, not a refinement, and must be logged — in both the relevant source document and this index — before any implementation work proceeds on it.

**No further architectural decisions are required before Phase 3 begins.**

---

**Phase 2 (System Architecture & Database Design) is now formally closed.**
**Phase 3 (Implementation) may officially begin.**
