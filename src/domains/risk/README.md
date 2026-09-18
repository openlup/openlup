# risk domain

Provider-neutral fraud, risk, blocklist, and manual-review control plane.

## Owns / does not own

- **Owns:** pure risk scoring, current reason-code vocabulary, sanitized risk assessments,
  manual-review case contracts, exact blocklist checks, and review decisions.
- **Does not own:** payment success, order state, subscription lifecycle,
  fulfillment execution, PSP SDKs, provider payload parsing, or customer-facing
  UI copy.

## Public surface

- `core/` - compatibility shims to `@openlup/core/risk` for the pure
  reusable evaluator. No Supabase, provider, BFF, UI, or `api/*` imports.
- `types.ts` - compatibility shim to the current risk vocabulary in
  `@openlup/core/risk`.
- `contracts.ts` - Zod request/response schemas for BFF and persistence
  boundaries.
- `ports.ts` - provider-neutral read/write ports used by server handlers.
- `riskClient.ts` - hidden admin BFF client for the manual review queue.

## Where the code lives

- Engine: `packages/core/src/risk/`, exposed as `@openlup/core/risk` -
  `evaluateRisk`, `collectRiskRuleMatches` and the current risk vocabulary. The
  package surface is `candidate` under the `internal-candidate` compatibility
  policy in `packages/core/release-gates.json`, so this is not yet a stable
  public-API or support promise. A scoring or reason-code change belongs there.
- Shared/frontend: `src/domains/risk/`. `core/evaluator.ts`, `core/rules.ts`,
  `core/types.ts` and `types.ts` are re-export shims over the engine;
  `contracts.ts`, `ports.ts` and `riskClient.ts` are local.
- Server: handlers behind `ports.ts`, with the store adapters under
  `server/adapters/`.

Use the public [architecture and extension boundary](../../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md)
and [publication catalog](../../../config/openlup-publication-catalog.json)
before adding an adapter or changing composition. This domain defines no provider
adapter, BFF mounting, or deployment selection; those stay with their owning
server/runtime or adopter composition surface.
