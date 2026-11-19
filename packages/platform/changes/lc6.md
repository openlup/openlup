Adds an experimental, unbound native catalogue admission fence to order acceptance
and subscription edits. `CatalogAdmissionPort.assertCurrent` delegates to the same
SQL assertion called by the native writers. It distinguishes
unreadable authority, invalid anchors, stale heads and invalid membership.
Sized unchanged or reduced selections retain immutable identities. A separate
context records any price the existing quote owner consulted for a retained
selection. The shared assertion checks the consulted products' current
definitions before classifying retained demand. Subscription edits verify the
policy revision alongside its exact base row when their quote owner returns
policy-derived prices. Mixed carts and edits prove the exact governed subset.
Sized edits share the configured-offer binding and numbered-cycle evidence
between preview and apply. The graduation baseline retains the current add-on
agreement. Explicit opt-in checks the current offer membership for every
selection and keeps the agreed price where the SKU, quantity and role match.
Governed legacy edits require owned renewal terms for the accepted
selection before saving the template.

Migration: apply the complete native catalogue, including the membership-page,
lifecycle and admission forwards. Capture evidence using the native checkout
wrapper alongside the original trusted quote. The existing edit previews record
their own private evidence in the ledgers. Historical formats keep their
existing reader and new acceptance uses the lifecycle-aware reference reader.
Fully governed renewals still produce `native.purchase-renewal.v3`. The same
reader also accepts `native.purchase-renewal.v4` for mixed carts. The new
snapshot freezes the governed references and exact legacy renewal lines and
requires both to agree with the retained terms.
An authenticated graduation reference can retain a distinct governed SKU agreed
at checkout. It binds the quoted publication and SKU revision to the frozen
graduation marker. Attachment verifies the marker and servicing uses the
captured reference after later publications.
Hosts admitting governed sized checkout supply their existing availability port
and the accepted server quote's offer binding. The trusted quote reader also
supplies the product heads observed in its quote snapshot. Editors on older installed
contexts can still read the paid-cycle count for phase selection.
Hosts discovering governed sized candidates supply a repeatable-read
`withCandidateSnapshot`. The shared membership scan qualifies the governed
portion of the host's candidate roster.
The quote catalogue reader's experimental `governedOffer` option returns
publication stamps for the verified roster. The strict quote port places the
stamps in server-only provenance. Configured readers and accepting writers
check the live SKU roster against the sealed publication for each consulted
product. Admission verifies the quote stamps before recording acceptance.
Governed edit previews return a token for their recorded evidence. Repeating a
preview records a separate token, including when the quoted totals stay equal.
The publisher retains its nonblocking busy refusal.

The order entrypoints keep their signatures and legacy results. A purchased
product or SKU with native version 3 publication data requires lineage. Accepted
subscription drafts freeze the configured offer and proof. Captured-payment
activation binds the offer and first renewal attachment copies the exact proof
after checking the frozen line agreement. Accepted edits record the proof in
existing servicing carriers and clearing the last governed line clears it.
Replay precedes current admission. Commerce prelocking precedes shared catalogue
guards. Installation leaves the feature unbound.

Transfer: no new relation, constraint, trigger, backfill or transfer class is
introduced. Existing authoritative order, line, event and retained-term capture
retains the acceptance bytes, and the complete migration selection installs the
assertion before runtime use. Historical inventories and old reader bytes remain
unchanged.

Managed divergence design: a twin uses the same `catalog_products`, `catalog_skus`,
`catalog_publications`, `catalog_publication_heads`, `catalog_sku_revisions`,
`catalog_type_versions`, `price_lists`, `price_entries`,
`subscription_price_policy_revisions`, `subscriptions`,
`subscription_lines`, `subscription_renewal_terms`, `subscription_events` and
`commerce_orders` facts. RLS-preserving trusted wrappers must derive actor/client
ownership from the authenticated session before the assertion, with complete
unfiltered catalogue evidence. `anon` and `authenticated` receive no direct
assertion authority; a trusted `service_role` wrapper retains its existing scope.
Advisory locks and the existing row modes have managed equivalents. This forward
relaxes no mandatory managed industry-specific column; any such relaxation remains
separately qualified;
the managed rail does not supply this feature.
