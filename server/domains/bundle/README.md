# bundle domain (server)

The operator write side of sellable bundles, the read side that answers what a
bundle IS, and the public feed that says which bundles may be sold today. A bundle
is a bill of materials over existing catalogue units, sold under one operator-set
target price.

## Owns / does not own

- **Owns:** the semantic write port (`adminBundleWritePort.ts`) and the write
  handlers built from the generic agent-domain kit (`adminBundleHandler.ts`).
- **Owns:** the semantic read port (`bundleCatalogReadPort.ts`), the read handlers
  (`adminBundleReadHandler.ts`), the derived-stock service
  (`bundleAvailabilityService.ts`) and the public feed handler
  (`sellableBundleHandler.ts`).
- **Does not own:** stock. `bundleAvailabilityService.ts` composes the EXISTING
  commerce offer-availability port; this domain never counts inventory, it only
  folds one batched answer through the pure kernel in
  `src/domains/bundle/availability.ts`.
- **Does not own:** storage. No table name, routine name or data client appears in
  this folder. Both live in `server/adapters/`, and the runtime binding in
  `server/runtime/bundleCatalog/` decides which one answers.
- **Does not own:** the composition rules themselves. A non-empty
  `composition_constraint` is handed to the injected `CompositionRulesPort`; this
  domain stores and forwards the envelope and never interprets it.
- **Does not own:** the target-price arithmetic. `@openlup/core/pricing` allocates
  one target price back onto the components, and its two failure codes are the same
  two rule codes this domain declares.

## Where the rules live, and why in three places

| Layer | Decides | Example |
| --- | --- | --- |
| request (`src/domains/bundle/bundleRules.ts`) | what the payload alone shows | the set is empty, names a unit twice, or is add-ons only |
| rules port (`CompositionRulesPort`) | what the adopter's constraint says | a fixed-slot constraint that this set does not satisfy |
| write boundary (the routines) | everything that depends on stored state | the code is taken, a unit is unsellable, the target exceeds the component sum |

The first two are a fast refusal, not the boundary. The routine re-derives what it
can see and refuses independently, so a confused or compromised caller changes
nothing about what is enforced.

## Publish is human-only, twice over

`activate` and `deactivate` are gated at two independent machine-checked layers:
the handler factory refuses a non-human actor from the spec's `allowedActorKinds`
(the actor kind is re-derived from the admin registry, never taken from the
caller), and the routine RAISEs `42501 publish_requires_human` on its own. They are
also structurally absent from the agent head — `mcp/bundle/tools.ts` carries no
path for either, so there is nothing to call rather than a call that is refused.

The self-hosted chain has no operator registry, so its routines enforce the state
preconditions and record the principal but cannot re-derive its kind; there, the
human-only rule rests on the handler alone. That difference is named in the
platform forward's header and in the wave plan rather than smoothed over.

## Derived stock fails to unknown, never to a guess

A bundle's `sellableNow` is `min(floor(component.sellableNow / quantity))` over the
counted components, and add-ons are excluded by default because an add-on must not
make the bundle unsellable. If ANY counted component's stock is unknown, the
bundle's stock is unknown and the component is named — never the minimum of the
parts that happened to answer. Treating a missing figure as unlimited oversells;
treating it as zero hides a sellable bundle, and neither decision belongs to a
stock derivation.

## The public feed shows only derivable money

`GET /api/bff/catalog/bundles` carries the operator's one price plus the
per-component lines `allocateBundleTargetPrice` derives from it; their subtotals
sum to the price exactly, and each line satisfies `unitPrice x quantity ===
lineSubtotal`. A bundle whose money cannot be derived — an unpriced component, an
empty composition, or a target the kernel refuses — is DROPPED from the feed rather
than published with a partial figure no order line could reproduce. The feed
contract has no lifecycle field at all, so a draft cannot be expressed in it.

## Surface

- `POST /api/bff/admin/commerce/bundles/{create,update,set-composition,set-target-price,archive,restore,clone-draft}` — mutation-gated, human and machine.
- `POST /api/bff/admin/commerce/bundles/{activate,deactivate}` — activation-gated, human only.
- `GET /api/bff/admin/commerce/bundles/{list,get,history,preview-price}` — read-gated, human and machine. Reading is not the publish decision, so an agent may read everything it may compose.
- `GET /api/bff/catalog/bundles` — PUBLIC sellable feed, read-gated.

## Public navigation and availability

Use [Architecture and extension boundaries](../../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md)
for public ownership and extension seams, and the
[publication catalog](../../../config/openlup-publication-catalog.json) for the
bounded public-source inventory. A repository path establishes source existence
at the reviewed commit; a listed `/api/...` value is a logical interface
coordinate. Mounting needs separate dispatcher or registry evidence, and even a
mounted reference interface is not proof that an adopter deployment exposes it.
