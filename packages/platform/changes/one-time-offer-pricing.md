### Added

- Let hosts pass authoritative, exact one-time offer allocations to the strict quote engine. Price component lines before promotions, shipping and tax while retaining independently read retail reference prices. Server quote snapshots carry versioned private offer-price provenance.
- Add opt-in explicit offer review to existing signed quote acceptance, including quotes without code, shipping or acquisition adjustments. A bound checkout offer can require that review.

Migration: no database migration. Existing callers keep their price, provenance and token behavior. Opt-in hosts must authorize the offer, resolve the full allocation on the server, sign and verify the same offer revision and checkout context, and re-resolve terms at acceptance. Readers that opt in must accept the server-only `catalog_facts_v3` variant. Older authoritative quote snapshots continue to parse.
