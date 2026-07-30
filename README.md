# SmartTable

Standalone restaurant management platform — one independent installation per
restaurant. See `Phase2_Engineering_Blueprint_Freeze.md` (in the project docs)
for the complete, frozen engineering architecture this codebase implements.

## What exists so far (Phase 3, Step 3.0 — Foundation)

- `packages/shared-types` — the single source of truth for contract types
  (enums, error codes, response envelopes) shared between `apps/api` and the
  future `apps/web`.
- `apps/api` — the embedded NestJS application:
  - `src/config` — typed, fail-fast configuration (Engineering Standards §9).
  - `src/database` — Drizzle ORM schema translating every table in the frozen
    Database Schema Design, plus the SQLite connection setup enforcing WAL
    mode and foreign-key enforcement (the two most consequence-heavy PRAGMAs
    in the whole system).
  - `src/common` — the domain exception hierarchy and global exception filter
    implementing the standard API error envelope.
  - `src/modules/health` — the first working domain module: the pluggable
    Health Check Registry from the Monitoring Architecture, currently
    registering one check (database connectivity) as the pattern every future
    subsystem check will follow.
- `apps/host`, `apps/web` — reserved, not yet implemented (next steps).

## Not yet implemented (intentionally, per the incremental plan)

Authentication, employees/invitations, tables, menu, orders, billing,
analytics, audit logging, real-time gateways, hardware integration, the
Electron host shell itself, and the frontend. Each becomes its own step,
following the same pattern: explain the objective, then implement it fully
against the already-frozen contracts.

## Setup (once dependencies are installed)

```
npm install
npm run db:generate   # generates SQL migrations from the schema
npm run db:migrate    # applies them to a local SQLite file
npm run dev:api       # starts the NestJS app in watch mode
```
