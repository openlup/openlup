### Starter applications adopting the supplements reference pack

Migration: Extract the target starter separately. For an upgrade that first
adds the sample pack, put these exact files from the target extraction in
the target snapshot only:

- `owned/catalog-packs/supplements/pack.ts`
- `owned/catalog-packs/supplements/catalogue.ts`
- `owned/catalog-packs/supplements/fixtures.ts`
- `owned/catalog-packs/supplements/policy.ts`
- `owned/market-packs/market-fictional/tax-table.ts`

Use the target's `owned/catalogue.ts` for a pristine registry. For a
customized registry, retain the local definitions and merge the single
pack entry into the existing registry if the application selects it.
Keep the registry outside both snapshots. If one of the new paths already
exists with local bytes, reconcile it before applying the snapshots. In
subsequent upgrades, keep the installed pack and market files outside both
snapshots and preserve local edits. Definition installation and draft
publication are separately authorized operations.
