### V1 readers identify SKUs that require typed quantities

Unscoped V1 envelope and quote scans skip SKUs with the guarded native typed
quantity marker before pagination. An explicit envelope selection returns a
`quantityRefusals` entry for each selected typed SKU. A V1 detail lookup or
cart containing a typed SKU reports `quantity_requires_v2` with the SKU code.
Activation readiness retains the result for each gram SKU beside that refusal.

Main's installed catalogue continues to use grams on these paths. Typed
issuance remains disabled. The native forward publishes this exact standalone line
`-- openlup:native-catalog-quantity-v2:live-guard` inside
`public.catalog_publication_admit()` alongside the live SKU guard. The
readers check the attested body and its enabled deferred trigger on
`catalog_skus` under the existing runtime grants. Qualify the active and rollback
app sets before issuance.
Keep products using the gram-only starter document on the gram lane until
their host can verify mixed documents.
