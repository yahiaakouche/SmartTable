# Known Gap — `bill_requested` table status (Step 3.4 ruling B1)

**Status:** Documented gap — accepted, no code change.
**Ruling:** Step 3.4 approval, B1 option (a).

## The gap

The frozen schema (`tables.status` CHECK, Database Schema Design §3) and the PRD's
workflow (§13: "guest requests bill → cashier consolidates and collects cash")
both include a `bill_requested` table status — but no frozen API endpoint sets it.
The API Contract §3 defines no "request bill" route for either staff or customers,
and adding one is a contract change, which the frozen-document process forbids
without an explicit ruling.

## The accepted behavior in v1

- **No endpoint sets `bill_requested`.** The value remains in the schema CHECK (it
  is part of the frozen enum and stays valid for a future version), but no v1 code
  path ever writes it.
- **Payment is allowed directly from `occupied`.** The cashier opens the
  consolidated bill (`GET /billing/table-bill-groups/:id`) and records payment
  (`POST /payments`) against a table in `occupied` state; the payment transaction
  flips the table strictly `occupied → needs_cleaning`.
- **`bill_requested` is still guarded like `needs_cleaning`** in order creation
  (ruling D8): should the status ever appear (a future version, or manual data
  intervention), the table accepts no new orders while in it.

## Candidate future resolution

A contract addition (e.g. `POST /tables/:id/request-bill` for staff, or a
customer-side bill request on the QR channel) was presented as ruling options
(b) and (c) and explicitly NOT approved for v1. If adopted later, it is a small
additive change: one endpoint, one table-status transition
(`occupied → bill_requested`), and a relaxation of the payment transaction's
compare-and-set to accept `bill_requested` as an additional from-state.
