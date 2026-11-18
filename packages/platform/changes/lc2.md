For the next 1.x release. Adds an experimental, unbound native catalogue publication authority consuming immutable draft
v3 inputs. It retains complete product/SKU facts, ordered source-bound operations,
persisted approve/revoke decisions, exact historical reads, authorized recovery,
bounded history and one transactional outbox fact. Material or inconclusive
published SKU changes require successor identity so subscribers never silently
receive a different physical product. Compatible explicit derived cache effects
remain supported. No capability is activated and agreements are untouched. Until versioned quantity
readers arrive, net content must be positive integer grams in 1..2,147,483,647.
Fractional, zero, negative and out-of-range net content refuses with
`catalog_publication_integral_grams_required`. Gross mass uses exact scaled storage,
including fractional grams, and activation compares it with net content without
rounding. No compatibility value is replaced with zero or made nullable.

Publication preserves active-and-eligible primary admission, status-independent
physical identity uniqueness, retained source-head currentness and head-before-drift
refusal order. Explicit current-draft claims bind command/fingerprint, and explicit
media evidence requires a current open source even without activation. Structural and price readiness use the operations' affected sets;
withdrawal-only publication skips unrelated commercial and global readiness.
Compensation reapplies explicit product and SKU effects with unchanged retained
values, while unaddressed projection drift still refuses and rolls back.
Changed complete facts retain compatible attribute, axis, gross-mass and asset
updates without refreshing unrelated fields.

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
and agreed subscriber prices are unchanged. The new public publication symbols and
shared price transaction entry points carry `@experimental`; already published
readers retain their existing annotations. New product/SKU status and publication
outcome unions evolve by addition; removing, renaming or narrowing an existing
value requires a major version.

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
