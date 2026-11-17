Adds an unbound native catalogue publication authority consuming immutable draft
v3 inputs. It retains complete product/SKU facts, ordered source-bound operations,
persisted approve/revoke decisions, exact historical reads, authorized recovery,
bounded history and one transactional outbox fact. Material or inconclusive
published SKU changes require successor identity so subscribers never silently
receive a different physical product. Compatible explicit derived cache effects
remain supported. No capability is activated and agreements are untouched. Until versioned quantity
readers arrive, mass must be positive integer grams: net 1..2,147,483,647 and gross
1..10^40−1. Fractional, zero, negative and out-of-range mass refuses with the stable
`catalog_publication_integral_grams_required` code. No compatibility value is
rounded, replaced with zero or made nullable.

Migration: install the native forward and upgrade readers before composing the
new version 2 publication API. Existing publication ports retain their version 1
DTOs through adapters. Nullable projection/canonical-text columns preserve old
readers; unknown legacy lineage refuses rather than manufacturing retained
history. Managed-to-native ingress defaults only absent product/SKU publication
projections to NULL and never creates publication history. Keep the new reader
while retained publications reference it. Publication
requires immutable draft v3 inputs; v1/v2 draft bytes and replay stay unchanged.
The price boundary uses the existing version 2 command through the price owner's
same-transaction writer. The shared price-owner phases reserve sorted receipt
keys before sorted contexts, verify every child belongs to the parent, and apply
the original commands on the publisher's executor. Standalone apply uses these
same phases in its single SQL transaction. Existing commands, receipts, refusals
and agreed subscriber prices are unchanged.

Managed divergence design: equivalent managed tables would store publications,
heads, full SKU revisions, kinded receipts and immutable candidate decisions,
plus a transient pointer authorization relation. RLS would derive human identity
and active administrator membership from the managed session. Browser/service
roles receive no direct writes; a trusted wrapper can implement the same atomic
pointer consumption and membership checks without native-role authorization
semantics. Managed food-column relaxation remains necessary before neutral
nonmass writes; this native row admits mass only, with an exact legacy integer
gram projection. The managed rail does not supply this feature. Adoption and
enablement require separate evidence.
