Adds unbound catalogue lifecycle authoring through draft payload v4 and immutable
publication/product/SKU facts v3. Withdrawal clears both fresh-sale flags while
retaining native active status and exact servicing identity. Restoration is
explicit; parent restoration never restores children implicitly. Archive is
terminal, preserves the primary-SKU refusal, and refuses known obligations or
unknown evidence. The unpaginated native obligation query covers templates,
pending activation, frozen renewal work, outstanding orders, undelivered leaf
replacements, stock waits and retained graduation baskets. Archive remains
unavailable until the acceptance barrier is qualified.

Migration: apply the complete native forward, then upgrade governed consumers to
`readbackV3` and the explicit `createNativeCatalogRenewalCodecV2` before composing
new authoring or acceptance. The existing strict draft v1/v2/v3 codecs,
publication v2 reader and original successful receipt bytes remain unchanged;
old raw-status commands cannot modify governed rows. The five legacy lifecycle
entrypoints remain unconditional mutation refusals before state access. Existing ungoverned rows
are not adopted. Withdrawn raw-active projections do not qualify legacy listing
or fresh-sale readers. The existing mass-only publication boundary remains.

The nullable same-SKU revision FK preserves historical NULL subscription bindings.
Acceptance envelopes retain complete immutable references in orders, accepted
edit events, retained terms and newly frozen operations; SQL verifies their
publication/document/revision tuple. Legacy bindings are never inferred from
current documents. `subscription_renewal_purchase_terms_v2` renders retained
terms v2 alongside the unchanged v1 view. The new frozen dialect uses
`native.purchase-renewal.v3`; the original codec still reads only v1/v2, while
the opt-in codec preserves old replay and refuses new freezes without complete
references. The commerce-first acceptance fence owns capture and qualification;
these carriers install no application binding. Keep the newer readers while
retained rows reference these versions. No agreement, quantity, money or cycle
schedule is rewritten.

A completed purchase attachment reconciles the accepted purchase against
both subscription rosters through versioned edit and graduation results. Full
graduation records the add-ons it carried, including those without a stored
price. Missing or contradictory lineage leaves the obligation unknown.

Order evidence reconciles accepted quotes, item quantities and retained
references. Separate ordinals for the same SKU contribute to the same quantity.
Deferred checks reconcile supplied acceptance against the final item, receipt,
and linked quote rows. A header or subscription event may be written before its
companion rows in the same transaction. Governed renewal admission
checks the frozen wire before the native reader replays it, including the
native integer bounds for item quantities and ordinals. Publication and head
checks resolve complete immutable rosters at the end of the transaction.

Native transfer retains authoritative lifecycle and acceptance bytes through
existing row inventories and restores revisions before subscription bindings.
The connected restore writes captured orders and events once, then validates
accepted receipts and quote links before confirming the restored rows.
The generic row utility continues to refuse INSERT-guarded acceptance tables;
the connected native owner path verifies and restores them.
Transient lifecycle write capabilities are excluded and nonempty capabilities
refuse capture. Managed ingress supplies NULL for absent native acceptance
carriers and never manufactures lineage.

Managed divergence design: a twin would extend `catalog_products`, `catalog_skus`,
`catalog_publications`, `catalog_sku_revisions`, `subscription_lines`,
`commerce_orders`, `subscription_events`, `subscription_renewal_terms` and
`subscription_renewal_operations`, with the same nullable binding and immutable
facts/acceptance carriers. RLS and trusted wrappers must derive human authorization
from the session and provide complete unfiltered obligation reads. The
`authenticated` and `service_role` roles receive no direct lifecycle mutation
authority.
The transaction-scoped `catalog_lifecycle_write_capabilities` relation and guarded
non-key updates have managed
SQL equivalents; native ownership checks establish unfiltered visibility, not
business authorization. Mandatory managed industry-specific columns still need
their separately qualified relaxation before nonmass publication;
the managed rail does not supply this feature.

Draft v4 accepts explicit same-SKU enabling eligibility before or after
activation or restoration. A parent-only restore keeps children withdrawn.
Initial activation and a parent restore that also restores fresh sales require
an active, sellable primary after the authored effects. A withdrawal preserves
physical and merchandising facts and does not depend on unrelated sale readiness.

Fresh sale readiness uses the price owner's latest effective active list in
the configured settlement region and currency. It requires one positive
gross base price at quantity one and an eligible stored subscription price
on that list.

The optional experimental `demandPolicyRef` is sealed into governed SKU facts.
When the sealed revision includes the field, accepted references must carry the
same value. Frozen renewal v3 requires exactly one reference per distinct line
SKU and checks the persisted basket copies before accepting the carrier.

New lifecycle and acceptance exports are `@experimental`; the existing catalogue
readers retain their maturity. Future changes to lifecycle state,
obligation-family and refusal unions are addition-only.
