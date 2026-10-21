# bundle domain

Provider-neutral bundle composition contracts, plus the shared half of the
operator write vertical for sellable bundles. A bundle is a bill of materials over
catalogue units, sold under one operator-set target price.

## Owns / does not own

The application implementation now lives in
[`@openlup/platform/catalog`](../../../packages/platform/README.md#catalog).
This directory keeps named rule/availability compatibility bindings and local
browser schema definitions. The server compatibility paths bind the existing
admin kit, operation spec/flags, validators, responder and versions; BundleRpcError
stays reference-owned and is injected by constructor identity. Core bundle
contracts/ports are unchanged. The package publishes DTO types without moving
Zod into its browser contracts or making browser code reach the server entry.
The native read store and unchanged SQL queries now also live in catalog; its
reference paths are named compatibility exports. The injected executor introduces
only a data type edge. SQL 16/19 are sparse canonical projections, not a standalone
installation chain. Write/transaction/transport composition stays reference-owned,
and native human-only activation still depends on the handler gate.

- **Owns:** `Bundle`, `BundleLineRef`, `CompositionConstraint` and
  `CompositionRulesPort` contract types; the admin write and lifecycle request
  contracts; the domain's rule-code registry and its pure rule predicates; the
  `AgentDomainSpec` both heads project; and the browser client.
- **Does not own:** catalog product data, checkout, subscription lifecycle state,
  package sizing, or any adopter-specific composition algorithm. Concrete sizing
  and eligibility rules belong to downstream adapters behind
  `CompositionRulesPort`.
- **Does not own:** target-price arithmetic. `@openlup/core/pricing` allocates one
  target price back onto the components; this domain projects its two failure codes
  onto its own registry through an exhaustive table, so the two cannot drift apart.

## Public surface (import cross-domain ONLY these)

- `contracts.ts` — bundle DTO and public type re-exports.
- `ports.ts` — composition validation and resize port.

## Where the code lives

- Engine: `packages/core/src/bundle/{contracts,ports}.ts`, exposed as
  `@openlup/core/bundle` — the neutral `Bundle` / `BundleLineRef` /
  `CompositionConstraint` / `CompositionRulesPort` types. `contracts.ts` and
  `ports.ts` in this directory are type re-export shims over them; the rest of
  the folder retains browser schemas, clients and operation authority.
- Shared/frontend: `src/domains/bundle/`
  - `adminBundleContracts.ts` / `adminBundleLifecycleContracts.ts` — write contracts.
  - `adminBundleReadContracts.ts` — the admin read contracts and the price-preview
    shape; the currency regex is reused from the write contracts, never restated.
  - `sellableBundleContracts.ts` — `catalog.sellable-bundle.v1`, the PUBLIC feed.
    Strict, and deliberately carries no lifecycle field: a draft cannot be
    expressed in the shape a storefront consumes.
  - `availability.ts` — binds the package derived-stock kernel to the status ladder
    and reason-code vocabulary from `src/domains/commerce/offerAvailability.ts`, so
    a bundle and a single unit cannot disagree about what `low_stock` means.
  - `bundleRuleCodes.ts` / `bundleRules.ts` — named package exports and the existing
    lifecycle-predicate binding for request-decidable rules.
  - `bundleSpec.ts` — the `AgentDomainSpec` the BFF handler factory and the MCP
    tool generator both project.
  - `adminBundleClient.ts` — the browser head for the admin surface.
  - `sellableBundleClient.ts` — the browser head for the public feed. Deliberately
    separate: it carries no credential, because a public feed that answers
    differently when signed in is a different surface.
- Server: `server/domains/bundle/` (write port + handlers, read port + handlers,
  the derived-stock service and the public feed handler),
  `server/adapters/{supabase,postgres}/bundleAdminWriteStore.ts` and
  `.../bundleCatalogStore.ts` (the two chains, write and read),
  a deployment-only bundle-store binding (which one answers, for
  both capabilities of the one binding).
- Agent head: `mcp/bundle/tools.ts`.
- The current composition adapter lives at
  `server/domains/commerce/petfoodCompositionRulesPort.ts`; it implements this
  domain's `CompositionRulesPort` without making `bundle` own package sizing.

## Publish is human-only

`activate` and `deactivate` carry lifecycle markers on the spec and
`allowedActorKinds: ["human"]`. The MCP generator drops them, so the agent surface
has no publish tool at all. The managed write routine independently refuses
machine actors; native SQL has no independent actor-kind gate and relies on the
handler. The spec comments distinguish these boundaries: request checks do not
establish an independent native database actor-kind check. This extraction does
not close that pending parity outcome. See `server/domains/bundle/README.md` for the enforcement table.

## Public navigation and availability

Use [Architecture and extension boundaries](../../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md)
for public ownership and extension seams, and the
[publication catalog](../../../config/openlup-publication-catalog.json) for the
bounded public-source inventory. A repository path establishes source existence
at the reviewed commit; a listed `/api/...` value is a logical interface
coordinate. Mounting needs separate dispatcher or registry evidence, and even a
mounted reference interface is not proof that an adopter deployment exposes it.

## Verification

The five package bundle suites under `packages/platform/test/catalog/` retain
44 cases; the two actual-kit admin suites under `tests/platform/catalog/` retain
18. Four neutral conformance cases capture composition through stock/allocation,
invalid-set refusal, draft fulfillment and activation authority; the single
binding case proves DTO/schema parity and both browser closures. Adapter,
browser-client and MCP suites remain at their current owners. Native stores,
SQL and durable parity evidence belong to the next bounded slice.
