# SmartTable — Real-Time Architecture Notes (Step 3.5)

**Status:** consolidation record, written at implementation time
**Authority:** every binding rule below is restated from the frozen corpus — this file introduces no new decisions

---

## 1. Why this file exists

The frozen documents reference a standalone "Real-Time Architecture" source
document (API Contract Design §4/§5, Phase 2 Blueprint ADR-006, Database
Schema Design companions). That source document is **not present in the
frozen document set**. Its binding content survives by restatement elsewhere,
and Step 3.5 was implemented exclusively against those surviving rules:

| Rule | Surviving frozen source |
|---|---|
| Socket.IO (staff) + SSE (customer), no Redis/message broker | Phase 2 Blueprint ADR-006; Technology Stack table |
| SSE is read-only — no client→server messages | API Contract §5 (restating RT-Arch §2.4) |
| No event is ever emitted before its DB transaction commits | API Contract §4 ("restated … now binding on the contract") |
| Frozen event list, room vocabulary, payload shapes | API Contract §4 table (9 events) |
| Presence tracked in-memory only, never persisted | Phase 2 Blueprint ADR-011 |
| One real-time transport serves orders, tables, config sync, presence, notifications | MVP Scope Freeze §6.1 |
| Staff channel rides HTTPS (`wss://`); customer channel is plain HTTP, unauthenticated | Security Architecture §1/§3 |
| Real-time channel health check ("Socket.IO server accepting connections") | Unified Monitoring Architecture §4 |

If the original Real-Time Architecture document ever resurfaces and conflicts
with this implementation, the conflict is a **formal architectural change**
(Phase 2 Blueprint §13) and must be resolved before any code changes.

## 2. Step 3.5 rulings (approved by the Owner of the frozen process)

- **B1(a) — presence emit-only.** The gateway emits
  `employee.presence_changed {employeeId, online}` to `owner-room` on
  transitions (first socket online, last socket offline — multi-device staff
  stay online while any device is connected). All REST presence surface
  (`GET /employees/:id/presence`, roster fields) stays with the dedicated
  presence step.
- **B2(a) — owner-room = Owner + Manager.** The frozen room vocabulary has
  no `role:manager`; a Manager's entire live visibility (PRD §11, FR28,
  FR31) flows through owner-room and restaurant-broadcast.
- **B3(a) — `order.status_changed` → role:kitchen + role:waiter +
  role:cashier + owner-room for every transition.** The payload
  `{orderId, fromStatus, toStatus}` carries no pricing, so the static set is
  FR6-safe by construction.
- **D1–D13** as recorded in the Step 3.5 engineering review: single
  cross-cutting gateway; JWT in `handshake.auth.token` verified at handshake
  with a fresh `isActive` reload; server→client only (zero
  `@SubscribeMessage` handlers); handshake-time auth with REST refetch as
  the reconnect reconciliation (no replay buffer); FR6/Q7 per-room kitchen
  shaping at the gateway; `invitation.accepted` wired post-commit;
  SSE endpoint semantics (initial snapshot first, stream stays open after
  terminal states, plain JSON, 60/min class); `menu_updated` narrowing (see
  §3 below); `notification.created` pre-wired routing; realtime health check;
  `socket.io-client` as a test-only devDependency; `table.status_changed`
  payload passthrough; observability without audit-log noise.

## 3. Known narrowing: FR31 vs the frozen event list

FR31 asks for real-time propagation of "menu categories, products, prices,
images, availability, or table count". The frozen §4 event list is
exhaustive and contains only `product.availability_changed` (products) and
`restaurant_profile.changed` (branding). Therefore in v1:

- **Availability** changes propagate in real time to staff
  (restaurant-broadcast) and customers (`menu_updated` SSE event — the
  customer client refetches `GET /public/menu/:qrToken`).
- **Profile/branding** changes will propagate the same way once the config
  module ships (the bridge and SSE handler already subscribe — that step
  needs zero real-time changes).
- **All other menu edits** (price, image, category, table count) propagate
  on the next menu fetch or page load. No new events may be invented without
  a formal contract change.

## 4. Client contract (for the frontend steps)

- **Staff:** connect with `auth: { token: <acting-employee JWT> }`. Rooms are
  assigned server-side from the verified token — never client-claimed. Auth
  is evaluated at handshake only; **reconnect after every PIN switch or
  token refresh** so room membership follows the acting employee. After any
  reconnect, refetch current state via REST (`GET /orders`, `GET /tables`)
  — events received while disconnected are not replayed.
- **Customer:** open `GET /public/orders/:id/stream` (EventSource). The first
  `status_changed` event is the current-status snapshot. On `menu_updated`,
  refetch the menu. **Close the EventSource on terminal status** (`paid`,
  `completed`, `cancelled`) — the server deliberately keeps the stream open
  because native EventSource auto-reconnect would storm a server-closed
  stream against the 60/minute rate class.

## 5. Explicitly deferred (recorded, not forgotten)

- `X-Client-Version` / `CLIENT_VERSION_STALE` (API Contract §1): meaningful
  only once a versioned frontend client exists; to be assigned when the
  customer frontend step is scheduled.
- CORS policy for browser clients on other LAN devices: a Host/static-
  serving concern, resolved with the frontend/host integration steps.
- REST presence surface: the dedicated presence step (reads the registry the
  gateway already maintains).
