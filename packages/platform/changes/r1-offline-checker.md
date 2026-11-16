Add opt-in catalogue definition/quantity/v1-draft checks, explicit refusal
fixtures and installed recipes with a copied stationery skeleton. Separate
attribute/projection and V2 combination fixtures use their owner validators. Taxonomy, dated tax, profile and promotion semantics remain pending.

Migration: Opt-in tooling for the unreleased 0.44.0 package set. Await
`runCatalogExtensionConformance(subject)`, which returns
`Promise<CatalogConformanceReport>`. Released imports and v1 canonical
bytes remain unchanged. The new Node-only `@openlup/platform/catalog/testing`
subpath and `openlup catalogue check --packs ./owned/catalogue.ts --json` require
an explicit trusted default-exported subject. No database migration, installation,
host wiring, publication or capability activation occurs. Upgrade all packages as
one exact set; an offline PASS is scoped evidence only.

Quantity fixture type references now use the shared `catalogProductTypeRefIssues`
owner before resolution; malformed keys/versions report existing definition codes.
Refusal capability keys must be own string keys, and pack versions share the
installer's existing positive bounded integer rule. Valid inputs are unchanged;
malformed fixtures and pack versions that could pass offline now refuse.
