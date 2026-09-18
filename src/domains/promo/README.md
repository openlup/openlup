# promo domain

Pure promotion evaluation: legacy eligibility/stacking plus an additive v2
best-price adjustment engine for future preview and finalization wiring.

⚠️ **Read this before looking for the promotion logic here.** This directory is
65 lines of non-test code and every one of those files is a re-export shim —
`promoEvaluator.ts` is a single line. The pure evaluators live in the core
package. The portable forward-migration inventory is exactly the two registered
files `db/platform/migrations/20260817180000_promotion_claim_lifecycle.sql` and
`db/platform/migrations/20260817180100_promotion_claim_lifecycle_validation.sql`,
not an eleven-file `supabase/migrations/*promotion*` glob. There is no
`server/domains/promo`. This folder is not a runtime implementation or a record
of which migration any deployment has applied.

## Owns / does not own
- **Owns:** compatibility exports for `@openlup/core/promo`.
- **Does not own:** DB promo storage, totals integration into the quote contract.

## Public surface (import cross-domain ONLY these)
- `types.ts` — legacy types plus v2 `PromotionAdjustmentCandidate`,
  `AppliedAdjustment`, context, rejection and result types.
- `promoEvaluator.ts` / `ports.ts` — legacy `evaluatePromos` plus additive
  `evaluatePromotionAdjustmentsV2`.

V2 treats product and shipping as independent lanes. Product percentage
benefits express a target effective discount against a trusted reference
subtotal. They are not multiplied into the current bundle/subscription price,
and product payable cannot cross the required caller-provided floor. This deployment's adapter supplies 100 minor
units of its own settlement currency; the neutral core assumes none. Runtime eligibility, storage, claims and rollout remain outside this
pure package.

## Where the code lives
- Engine: `packages/core/src/promo/`, exposed as `@openlup/core/promo` —
  `promoEvaluator.ts`, `adjustmentEngine.ts` and their types. Pure functions,
  no storage and no runtime eligibility.
- Shared/frontend: `src/domains/promo/` re-exports the package by name so
  existing product imports stay stable across the split. Shims only.
- Runtime transition sources: the two registered forward migrations named
  above plus the `promotion*` modules under `server/domains/commerce/`.
  Historical `supabase/migrations/*promotion*` files are not that forward
  migration inventory.

Use the public [architecture and extension boundary](../../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md)
and [publication catalog](../../../config/openlup-publication-catalog.json)
before adding an adapter or changing composition. This folder owns compatibility
exports only: pure evaluator changes belong in `packages/core`, while stored
promotion lifecycle, quote integration, and runtime composition remain outside
this folder and need their own owning surface.
