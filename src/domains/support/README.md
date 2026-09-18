# Support Domain

Support owns portable operator evidence composition and one narrow command delegated to existing recovery authority. It owns no customer, order, payment, fulfillment, communication, subscription, or recovery state machine.

## Portable surface

- `clients.customer_360.v2` supplies neutral subject identity, lifecycle, summary, search, and detail contracts.
- `support.customer_360.v2` supplies customer-journey search/snapshot and recovery-command contracts.
- Admin BFF: `GET|POST /api/bff/admin/support/customer-journey`.
- `GET` searches with `mode=search` or reads a snapshot by `subjectId`, `orderId`, `subscriptionId`, `email`, or `query`.
- `POST` accepts only `issue_recovery` with `subjectId`, `caseId`, and `idempotencyKey`.
- MCP exposes sanitized read tools only; it does not expose the mutation.

## Invariants

- Authorize the admin before creating a direct Postgres or managed Supabase data lane.
- Compose existing ledgers and canonical status maps; never create parallel truth.
- Recovery delegates to D15 case/token/notice authority and must be atomic, durable, and replay-safe.
- A recovery token is `available` only while it remains live and its related
  order is still `pending_payment`; a settled or otherwise terminal order is
  durable consumed-token evidence even when the physical ledger has no
  `used_at` column.
- Dunning and recovery delivery status uses only customer-directed notices.
- The dual-bundle proof pins complete v2 output and names lifecycle, audit,
  timestamp, money-source, status, order-number, and linkage differences
  explicitly; adapters must not normalize those differences away in production
  code.
- The same idempotency key replays; a changed fingerprint conflicts; ineligible state returns a named refusal.
- Never return bearer credentials, token material/hash/path, provider references/payloads, payment credentials, or raw metadata.
- Managed deployments may add optional `managedOverlay`; portable callers and MCP must not depend on or expose it.
- Recovery outcomes are limited to sanitized issued, replayed, refused, or conflict evidence.

## Diagnostic evidence

The managed snapshot preserves controlled source-availability warnings through
`lookup.warnings`. Unavailable ancillary evidence differs from a successful empty
read; mandatory identity/order/subscription/recovery truth fails closed. Source
limits are disclosed, so missing history does not prove no action happened.
The managed `auditTrail` keeps recent evidence in chronological display order,
with stable event identity and source-backed outcomes; it does not turn scheduled
cycles into past customer actions. Portable output remains strict v2 and excludes
raw provider and recovery material. Other adapters retain their documented parity
differences; this is not a new shared event store.

Use `support__customer_journey_snapshot`, then the exact order's
`oms__get_order_detail` for canonical attempts, transitions and communication
deliveries. For browser actions before an order or account UI failures, use
`support__customer_diagnostics`; those observations do not prove hosted ingestion,
live retention or a business outcome.

## Where the code lives

- Shared/frontend: `src/domains/support/` — `customer360Contracts.ts`,
  `customerJourneyContracts.ts`, `customerSupportAddressContracts.ts`,
  `customerSupportCommandContracts.ts`, `customerSubjectCorrectionContracts.ts`,
  `contactHealth.ts`, and the typed `customer360Client.ts`.
- Server: `server/domains/support/` — customer-journey projection/snapshot,
  recovery command, lead absorption, and operator identity move.
- BFF handler: a deployment-owned admin support handler, exposed through
  `/api/bff/admin/support/customer-journey`.
- Read-only operator tools: `mcp/support/tools.ts`.
