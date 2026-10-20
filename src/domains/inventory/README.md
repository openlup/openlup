# inventory domain

Hidden stock/ATP/reservation control plane: stock ledger, available-to-promise, reservations, lots/expiry, subscription demand forecast. Reserve-before-sell + paid-order hold.

## Owns / does not own
- **Owns:** stock ledger, ATP, reservations, lots/expiry, demand forecast, hidden inventory read models.
- **Does not own:** catalog SKU ownership, order/payment state, carrier or
  third-party logistics execution, raw provider stock evidence or provider execution.

## Public surface (import cross-domain ONLY these)
- `inventoryClient.ts` — hidden admin inventory BFF client.
- `contracts.ts` — stock / ATP / reservation / subscription forecast contracts.
- `ports.ts` — named compatibility exports of `@openlup/platform/inventory` read/mutation ports and errors.
- `atp.ts` — re-export shim over the core available-to-promise kernel.
- `forecast.ts` — named shortage export and exact provider binding for the packaged forecast.

## Where the code lives
- Engine: `packages/core/src/inventory/atp.ts`, exposed as
  `@openlup/core/inventory` — `calculateInventoryAtp` and `availableNow`, the
  pure available-to-promise arithmetic. An ATP behaviour change belongs there;
  `atp.ts` here forwards the names and must never grow logic of its own.
- Shared/frontend: `src/domains/inventory/` (the forecast binding, contracts,
  ports, client, and the ATP shim)
- Server domain: `server/domains/inventory/inventoryHandlers.ts`
- Managed persistence adapter: `server/adapters/managed/inventory/inventoryPort.ts`

## Package boundary

`@openlup/platform/inventory/contracts` owns explicit inventory DTOs with no runtime imports. The server entry owns stock/reservation/request schemas and read/mutation ports; its forecast response schema requires an injected stock-master provider validator, with no default. Browser validators remain local here and keep their exact wire constraints. The reference forecast response type remains derived from its local validator to retain its exact provider type. The named server handler/native-store wrappers inject that same exact validator and preserve existing import paths. The package's native store retains stock/reservation/ATP/forecast reads and refuses stock adjustment. Its new-purchase projection returns the catalog bundle-stock port through a type-only entry import; host composition supplies normalized rows, defaults, missing-function fallback, observation and the existing availability calculation. No transport, stock-wait SQL or cycle writer moves. W1/W9 transplants and conformance tests pin projection and operator behavior; transport/native parity remains pending in the [M06 ledger](../../../docs/platform/plans/oss-m06-stock-reservations-delivery.md#inventory-lane-p1ap2c). ATP contracts and arithmetic remain in Core.

## ATP region configuration

The stock and ATP schemas are re-exported from `@openlup/core/inventory`.
The optional `region` field accepts a configured region string; it has no country
default. The admin ATP route uses server-only `INVENTORY_REGION` when the request
omits `region`. An explicit request region takes precedence. With neither input,
region remains absent. A configured value must be a trimmed string of 2–32
characters; malformed configuration refuses the route before the inventory port
runs. On upgrade, configure the intended region or send it explicitly instead
of relying on the former implicit country value.

## Subscription forecast

The package keeps OpenLup's forecast arithmetic and strict response validation.
Its required provider value and validator are injected; this reference wrapper
binds the existing exact identity. The separate `calculateSubscriptionForecastSkus`
and `calculateSubscriptionForecastTotals` retain the adopter's dated calculator
without replacing the reference forecast or changing its validation, defaults,
ordering, rounding or fault modes. The calculator accepts structural inputs;
validation remains with its caller. These functions only plan coverage: they
never write reservations, cycles, anchors, due dates or attempts. W5 retains
managed dated supply and expired-reservation readback versus the native aggregate
projection's stale sellable stock, nullable coverage and absent planned supply.


`GET /api/bff/admin/inventory/subscription-forecast` is read-only. It uses
OmniPack provider-current stock as the physical stock master, subtracts open
OmniPack hard reservations and safety stock, then overlays active subscription
renewal demand for the requested horizon. Horizon gaps indicate future coverage
risk; protection-window gaps indicate urgent coverage risk. Future renewals
remain soft forecast only; hard reservations start when a concrete subscription
cycle/order exists.

## Public navigation and availability

Use [Architecture and extension boundaries](../../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md)
for public ownership and extension seams, and the
[publication catalog](../../../config/openlup-publication-catalog.json) for the
bounded public-source inventory. A repository path establishes source existence
at the reviewed commit; a listed `/api/...` value is a logical interface
coordinate. Mounting needs separate dispatcher or registry evidence, and even a
mounted reference interface is not proof that an adopter deployment exposes it.

P2c exposes `INVENTORY_MIGRATIONS` as sparse immutable canonical units 27/33,
not an installation chain. The [store/refusal matrix](../../../docs/platform/plans/oss-m06-stock-reservations-delivery.md#parity-pending-rows)
records direct observed-stock versus managed lot semantics and pending real-host
proof. Manual reservation repair remains POST/auth/flag/manual_admin-lease gated,
without a schedule; automatic expiry, provider stock sync and recount are distinct
operations. Retry maintenance releases holds without cancelling subscriptions or
dunning. The TTL documentation versus staging flag/control mismatch is report-only.
W4 is a frozen boundary transcript at the incumbent charge routine, not a private
stock-wait implementation: no subscription, payment or delivery timing writer moves.
