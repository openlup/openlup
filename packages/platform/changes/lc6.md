Adds an experimental, unbound native catalogue admission fence to order acceptance
and subscription edits. `CatalogAdmissionPort.assertCurrent` delegates to the same
SQL assertion called by the native writers. It checks immutable accepted references,
current publication heads, offer membership and the exact consulted price rows.
Sized unchanged or reduced selections keep their retained identities; fresh and
increased demand requires current admission. Existing lane pricing is unchanged.

Migration: apply the complete native catalogue including the admission forward
after the lifecycle forward. Compose the new server evidence alongside existing
quote provenance, keeping existing strict readers for historical formats and the
lifecycle-aware reference reader for new acceptance. No capability is enabled.
Plain and promoted order functions retain their identical signatures and legacy
results. Missing lineage refuses only for a purchased product or SKU with native
version 3 publication data; raw writes and old publication writers cannot downgrade
those facts. Completed commands replay before current admission. The publisher's
existing busy refusal is unchanged.

Mixed acceptance prelocks its existing commerce targets before taking shared
catalogue guards. The new port requires the accepting connection and transaction;
it grants no transaction, identity or pricing authority. Capture full evidence in
the trusted preview ledger, never from a browser. Native package, exact and sized
SQL writers consume `quote_snapshot.catalogAdmission`; the native legacy bundle
lane binds `compositionConstraint.catalogAdmission` through its existing request
fingerprint. Order writers consume `quoteSnapshot.catalogAdmission`. Acceptance
is recorded in the existing lifecycle carriers, without repricing or rescheduling
any agreement. Archive remains unavailable; no obligation is drained.

Transfer: no new relation, constraint, trigger, backfill or transfer class is
introduced. Existing authoritative order, line, event and retained-term capture
retains the acceptance bytes, and the complete migration selection installs the
assertion before runtime use. Historical inventories and old reader bytes remain
unchanged.

Managed divergence design: a twin uses the same `catalog_products`, `catalog_skus`,
`catalog_publications`, `catalog_publication_heads`, `catalog_sku_revisions`,
`catalog_type_versions`, `price_lists`, `price_entries`, `subscriptions`,
`subscription_lines`, `subscription_renewal_terms`, `subscription_events` and
`commerce_orders` facts. RLS-preserving trusted wrappers must derive actor/client
ownership from the authenticated session before the assertion, with complete
unfiltered catalogue evidence. `anon` and `authenticated` receive no direct
assertion authority; a trusted `service_role` wrapper retains its existing scope.
Advisory locks and the existing row modes have managed equivalents. This forward
relaxes no mandatory managed industry-specific column; any such relaxation remains
separately qualified;
the managed rail does not supply this feature.
