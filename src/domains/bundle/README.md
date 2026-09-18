# bundle domain

Provider-neutral bundle composition contracts, plus the shared half of the
operator write vertical for sellable bundles. A bundle is a bill of materials over
catalogue units, sold under one operator-set target price.

## Owns / does not own

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
  the folder is genuinely local.
- Shared/frontend: `src/domains/bundle/`
  - `adminBundleContracts.ts` / `adminBundleLifecycleContracts.ts` — write contracts.
  - `adminBundleReadContracts.ts` — the admin read contracts and the price-preview
    shape; the currency regex is reused from the write contracts, never restated.
  - `sellableBundleContracts.ts` — `catalog.sellable-bundle.v1`, the PUBLIC feed.
    Strict, and deliberately carries no lifecycle field: a draft cannot be
    expressed in the shape a storefront consumes.
  - `availability.ts` — the pure derived-stock kernel. It IMPORTS the status ladder
    and reason-code vocabulary from `src/domains/commerce/offerAvailability.ts`, so
    a bundle and a single unit cannot disagree about what `low_stock` means.
  - `bundleRuleCodes.ts` / `bundleRules.ts` — the rule vocabulary and the pure
    predicates decidable from a request alone.
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
has no publish tool at all; the write routine RAISEs independently as the second
layer. See `server/domains/bundle/README.md` for the enforcement table.

## Public navigation and availability

Use [Architecture and extension boundaries](../../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md)
for public ownership and extension seams, and the
[publication catalog](../../../config/openlup-publication-catalog.json) for the
bounded public-source inventory. A repository path establishes source existence
at the reviewed commit; a listed `/api/...` value is a logical interface
coordinate. Mounting needs separate dispatcher or registry evidence, and even a
mounted reference interface is not proof that an adopter deployment exposes it.
