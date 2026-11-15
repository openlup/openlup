Add opt-in catalogue definition/quantity/v1-draft checks, explicit refusal
fixtures and installed recipes with a copied stationery skeleton. Later attribute,
variant, taxonomy, tax, profile and promotion semantics remain explicitly pending.

Migration: Additive tooling for the next package set. Old imports and v1 canonical
bytes remain unchanged. The new Node-only `@openlup/platform/catalog/testing`
subpath and `openlup catalogue check --packs ./owned/catalogue.ts --json` require
an explicit trusted default-exported subject. No database migration, installation,
host wiring, publication or capability activation occurs. Upgrade all packages as
one exact set; an offline PASS is scoped evidence only.
