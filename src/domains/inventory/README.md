# inventory domain

Hidden stock/ATP/reservation control plane: stock ledger, available-to-promise, reservations, lots/expiry, subscription demand forecast. Reserve-before-sell + paid-order hold.

## Owns / does not own
- **Owns:** stock ledger, ATP, reservations, lots/expiry, demand forecast, hidden inventory read models.
- **Does not own:** catalog SKU ownership, order/payment state, carrier or
  third-party logistics execution, raw provider stock evidence or provider execution.

## Public surface (import cross-domain ONLY these)
- `inventoryClient.ts` — hidden admin inventory BFF client.
- `contracts.ts` — stock / ATP / reservation / subscription forecast contracts.
- `ports.ts` — reservation + read ports.
- `atp.ts` — re-export shim over the core available-to-promise kernel.
- `forecast.ts` — the pure demand-forecast helper, still local to this domain.

## Where the code lives
- Engine: `packages/core/src/inventory/atp.ts`, exposed as
  `@openlup/core/inventory` — `calculateInventoryAtp` and `availableNow`, the
  pure available-to-promise arithmetic. An ATP behaviour change belongs there;
  `atp.ts` here forwards the names and must never grow logic of its own.
- Shared/frontend: `src/domains/inventory/` (the forecast helper, contracts,
  ports, client, and the ATP shim)
- Server domain: `server/domains/inventory/inventoryHandlers.ts`
- Managed persistence adapter: `server/adapters/managed/inventory/inventoryPort.ts`

## Subscription forecast

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
