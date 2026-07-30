# SmartTable — Engineering Standards

**Status:** MANDATORY — applies to all code written from this point forward
**Scope:** Backend (NestJS/TypeScript) and cross-cutting engineering practices. Frontend-specific conventions will be appended once the frontend stack is selected (later in Phase 2).
**Companion documents:** PRD v1.3, MVP Scope Freeze, Technology Stack Decisions (Electron + NestJS + TypeScript)

---

## 1. Repository & Folder Structure

Monorepo, organized by deployable unit and shared code — not by technical layer:

```
smarttable/
├── apps/
│   ├── host/              # Electron host application (main process, tray, updater, diagnostics UI)
│   ├── api/                # Embedded NestJS application (runs inside the host process)
│   └── web/                # Frontend client(s) — added once frontend stack is chosen
├── packages/
│   ├── shared-types/       # DTOs, enums, and interfaces shared between api and web (single source of truth for contracts)
│   └── shared-config/      # Shared lint/tsconfig/build configuration
└── docs/                   # PRD, UX Blueprint, Engineering Standards, ADRs (see Section 11)
```

**Rule:** Nothing in `apps/web` may import directly from `apps/api`'s internals. Cross-boundary contracts (request/response shapes, WebSocket event names) live only in `packages/shared-types`. This is what makes the future optional SaaS track (NFR7) realistic without a rewrite — the contract layer doesn't care whether `api` is embedded or hosted.

## 2. Module Structure (NestJS)

One module per business domain, never per technical layer. A domain module owns everything it needs:

```
apps/api/src/modules/orders/
├── orders.module.ts
├── orders.controller.ts
├── orders.gateway.ts        # WebSocket events for this domain, if any
├── orders.service.ts
├── dto/
│   ├── create-order.dto.ts
│   └── accept-order.dto.ts
├── entities/
│   └── order.entity.ts
└── orders.service.spec.ts   # unit tests co-located with the code they test
```

**Rule:** A module may only be imported by another module through its exported providers, declared explicitly in `@Module({ exports: [...] })`. No reaching into another module's internal files.

**Baseline module list (v1 scope, per PRD v1.3):** `auth`, `employees`, `invitations`, `tables`, `orders`, `kitchen`, `billing`, `menu`, `analytics`, `audit`, `notifications`, `presence`, `printing`, `backup`, `setup-wizard`, `config`.

## 3. Controller Responsibilities

Controllers are a thin translation layer only. A controller:

- Maps an HTTP route or WebSocket event to exactly one service call.
- Applies validation (via DTOs + Pipes) and authorization (via Guards) — never contains business logic itself.
- Shapes the response, but does not compute it.
- Must not contain `if` statements that encode business rules (e.g., "if order is locked, reject" belongs in the service, not the controller).

**Rule:** If a controller method is longer than ~10 lines excluding decorators, that is a signal business logic has leaked into it and must move to the service.

## 4. Service Responsibilities

Services own all business logic and are the only layer allowed to:

- Enforce domain rules (e.g., order-lock transitions, Table Bill Group lifecycle, RBAC-adjacent business constraints not already covered by Guards).
- Orchestrate calls to repositories and other services.
- Raise domain-specific exceptions (Section 7).

**Rule:** Services must not import anything from `@nestjs/common`'s HTTP-specific decorators (`@Req`, `@Res`, etc.) — a service must be testable and callable with no knowledge that HTTP or WebSocket exists. This is what keeps unit tests fast and controller-independent.

## 5. Dependency Injection Rules

- **Constructor injection only.** No `new SomeService()` anywhere in application code outside of test files.
- Every service has a single, clearly named responsibility (Single Responsibility Principle) — a service named `OrdersService` handles order lifecycle logic only, not billing calculations (that belongs to `BillingService`).
- Repositories are injected behind an interface/token, not a concrete ORM class, wherever the underlying data source could plausibly change (this directly supports NFR7 — architectural SaaS-readiness — without over-engineering it now).
- **No circular module dependencies.** If Module A needs Module B and Module B needs Module A, extract the shared logic into a third module both depend on.

## 6. Validation Rules

- Every controller input (HTTP body, WebSocket payload) is defined as a DTO class with `class-validator` decorators. Raw, unvalidated `any` payloads are forbidden.
- Global `ValidationPipe` configured with `whitelist: true` and `forbidNonWhitelisted: true` — unknown fields are rejected, not silently ignored.
- Money fields are validated as positive integers only (enforcing the integer-minor-units decision, FR36) — never as floats, at the DTO layer itself, before the value ever reaches a service.
- Cross-entity validation (e.g., "this table ID actually exists and belongs to this restaurant installation") happens in the service layer, not the DTO — DTOs validate shape, services validate business truth.

## 7. Error Handling Strategy

- **Domain-specific exception classes** per module (e.g., `OrderLockedException`, `InvitationExpiredException`, `InsufficientPermissionException`), all extending a common `DomainException` base.
- A **global exception filter** translates these into a consistent HTTP/WebSocket error response shape: `{ code, message, details? }` — the frontend always parses errors the same way regardless of which module raised them.
- **Expected business errors** (e.g., "order already locked") return 4xx and are *not* logged as errors — they're normal control flow, logged at `info`/`debug` level at most.
- **Unexpected system errors** (e.g., database unreachable) return 5xx, are always logged at `error` level with full stack trace, and — per the Host Application design — surface into the Health Monitoring system so the Host can react (Section 9 of this document ties in here).
- **No silent catches.** A `catch` block that does nothing (or only logs and swallows) is not permitted; every caught error either recovers meaningfully, rethrows, or is explicitly documented as an intentional no-op with a comment explaining why.

## 8. Logging Strategy

- **Structured (JSON) logging**, not raw string concatenation — required for the Host's Diagnostics page (Section 2.1 of the architecture discussion) to parse and display logs meaningfully.
- Standard levels: `debug` (development detail), `info` (normal business events — order accepted, shift closed), `warn` (recoverable anomalies — retrying a failed print job), `error` (unrecoverable failures needing attention).
- Every log line tied to a request carries a **correlation ID**, generated per HTTP request or WebSocket event, so a single customer action can be traced across REST calls, WebSocket broadcasts, and background jobs (e.g., rollup updates).
- **Never log:** raw PINs/passwords, full invitation tokens, or complete payment payloads. Log identifiers (employee ID, order ID) instead of sensitive content — this is a security requirement, not a style preference.
- The Audit Log (NFR16, append-only) is a *separate concern* from application logging: logs are for engineering diagnostics and may eventually be rotated/pruned; the Audit Log is permanent business-record data and is never treated as disposable log output.

## 9. Configuration Management

- A single `ConfigModule`, backed by a **typed configuration schema** validated at application startup — the app must fail fast with a clear error if a required config value is missing or malformed, rather than failing unpredictably later.
- Configuration for a desktop-installed product is **not** `.env`-file-based in the traditional server sense — it is read from the restaurant's local installation config (set during the Setup Wizard, editable via the Admin Dashboard), stored in the local database itself where it needs to be user-editable, or in a local config file for pre-database bootstrap values (e.g., database file path, port number).
- Secrets generated at install time (e.g., the signing key used for invitation tokens, NFR12) are generated once during the Setup Wizard, stored securely on disk, and never hardcoded or committed to source control.
- **No magic numbers/strings scattered in business logic** — thresholds like "invitation expires in 7 days" or "disk space warning at 85%" live in configuration, not inline in service code, so they can be tuned without a code change.

## 10. Testing Strategy

| Test type | Scope | Requirement |
|---|---|---|
| **Unit tests** | A single service's business logic, with repositories/other services mocked | Mandatory for every service containing business rules — especially money calculations, order lifecycle transitions, and RBAC-adjacent logic. Target: fast (milliseconds), no real database. |
| **Integration tests** | A full module (controller → service → real test database) | Mandatory for every module that touches persistence — verifies the whole slice works together, including DTO validation and database constraints. |
| **End-to-end (E2E) tests** | Full user-facing flows across modules | Mandatory for the critical paths explicitly called out in the PRD's Acceptance-Criteria spirit: full order lifecycle (Pending → Completed), Add-on Order creation after lock, employee invitation acceptance, Table Bill Group consolidation at payment, and the daily rollup trigger on order completion. |

**Non-negotiable rule:** Any code touching money (Section 6, FR36) or the order lifecycle state machine must have unit test coverage before it is considered done — these are the two areas where a silent bug directly costs the restaurant owner real money or real trust.

## 11. Naming Conventions

- **Files:** kebab-case (`accept-order.dto.ts`, `table-bill-group.service.ts`).
- **Classes:** PascalCase (`OrdersService`, `CreateOrderDto`).
- **Variables/functions:** camelCase.
- **Booleans:** prefixed `is`/`has`/`can` (`isLocked`, `hasActiveInvitation`, `canCancelOrder`) — never a bare adjective.
- **DTOs:** suffixed `Dto` (`CreateEmployeeDto`).
- **Domain exceptions:** suffixed `Exception` (`OrderLockedException`).
- **WebSocket/domain events:** past tense, since they represent something that already happened (`OrderAccepted`, `TableBillGroupClosed`), never imperative — imperative names (`AcceptOrder`) are reserved for commands/methods, not events. This distinction matters because it's the same convention that will make an eventual audit-log/event-sourcing-style history easy to reason about.
- **No Hungarian-style prefixes** (no `IOrderService` — modern TypeScript style favors the plain name; an interface and its implementation are distinguished by usage, not a prefix).

## 12. Architectural Decision Records (ADRs)

Every decision made in this Phase 2 process (Electron host, NestJS, TypeScript, upcoming database choice, etc.) gets a short ADR file in `docs/adr/`, following the standard format: **Context → Decision → Alternatives Considered → Consequences**. This is not bureaucracy for its own sake — it is what lets a developer joining this project in year 3 understand *why* NestJS was chosen over Express without needing to ask you directly. Each ADR produced during this architecture conversation should be transcribed into this folder before implementation begins.

---

*These standards are mandatory, not suggestions. A pull request that violates them (business logic in a controller, an uncaught silent exception, a float used for money, a missing unit test on a lifecycle transition) should be rejected in code review regardless of whether the feature "works."*
