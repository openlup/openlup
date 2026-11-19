### Starter applications adopting the supplements reference pack

Migration: In a fresh target extraction with its exact dependencies installed,
run `./lifecycle upgrade-catalogue /path/to/existing-starter` during the
application maintenance window. The existing step reconciles
`owned/catalogue.ts` and `owned/copy.ts` and introduces these owned paths:

- `owned/catalog-packs/supplements/pack.ts`
- `owned/catalog-packs/supplements/catalogue.ts`
- `owned/catalog-packs/supplements/fixtures.ts`
- `owned/catalog-packs/supplements/policy.ts`
- `owned/market-packs/market-fictional/tax-table.ts`

Reconcile any local conflicts manually. Keep the registry, pack and market
files application-owned during later managed-file upgrades. Definition
installation and publication retain their separate authority.

When selecting `supplements-pack`, build the draft recipe with the selected
registration's `supplementsCatalogueFor(selection)` from `owned/catalogue.ts`.
The recipe uses the installed base-price list. The registration supplies the
pack's per-line demand and capsule swap group for subscription quotes.
