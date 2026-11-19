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
including fractional grams. Publication compares supplied gross mass with
net content without rounding. No compatibility value is replaced with zero or made nullable.

Publication preserves active-and-eligible primary admission, status-independent
physical identity uniqueness, retained source-head currentness and head-before-drift
refusal order. Explicit current-draft claims bind command/fingerprint, and explicit
media evidence requires a current open source even without activation. The
transaction-local structural check runs for presentation changes with or without
affected SKUs. Price readiness uses the operations' affected SKU sets.
Withdrawal-only publication skips unrelated commercial and global readiness.
Compensation reapplies explicit product and SKU effects with unchanged retained
values, while unaddressed projection drift still refuses and rolls back.
Changed complete facts retain compatible attribute, axis, gross-mass and asset
updates without refreshing unrelated fields. Creation binds the name to the sealed
document. The draft compiler represents authored absence with an empty
presentation object. The ordered null effect still clears the live presentation.
Positive eligibility generates required product and SKU promotions before sealing.
Moving to an off-head document requires its matching registration. Publication
and decision command keys preserve whitespace and accept up to 200 UTF-8 bytes.
A decision reason may be null. A supplied reason preserves whitespace, requires
text beyond ASCII spaces, and accepts up to 1,000 UTF-8 bytes. History,
replay and recovery verify the kinded receipt against its immutable publication
or decision. A ledger row with an inconsistent or missing companion fails closed.
Publication checks the immediate predecessor at the end of a bulk insert.
Reads verify the predecessor and the immutable SKU roster, including items
outside the requested page. Receipt changes must match the SKU versions issued
by that publication. A media evidence change requires its SKU in the
current authored revision. Publication verifies that revision's claim against
the applied presentation and SKU assets.

Migration: install the native forward and upgrade readers before composing the
new version 2 publication API. Existing publication ports retain their version 1
DTOs through adapters. Nullable projection/canonical-text columns preserve old
readers; unknown legacy lineage refuses rather than manufacturing retained
history. Managed-to-native ingress defaults only absent product/SKU publication
projections to NULL and never creates publication history. New uniqueness indexes
scope to published projections. Existing draft combinations and identifiers keep
their original admission rules, and publication checks new GTINs against legacy
and published identifiers. The native write fence serializes legacy catalogue
writes with publication and checks cross-format identity collisions. The managed
equivalent can use the same row triggers and transaction-local relation guards. Keep the new reader
while retained publications reference it. Publication
requires immutable draft v3 inputs; v1/v2 draft bytes and replay stay unchanged.
Registration checks each source against its immutable draft receipt. A new SKU
can be created and priced in the same issuance. Enabling sale requires a later
issuance with a current source that matches the materialized SKU. Installed
publication rules interpret document bytes and return typed metadata and
derived SKU facts. Legacy GTIN writes use Read Committed and check cross-issuer
collisions under one transaction lock. Successor manifests retain every
previously issued SKU, including unchanged and archived rows.
The price boundary uses the existing version 2 command through the price owner's
same-transaction writer. The shared price-owner phases reserve sorted receipt
keys before sorted contexts, verify every child belongs to the parent, and apply
the original commands on the publisher's executor. Standalone apply uses these
same phases in its single SQL transaction. It verifies the human actor before
reading the command, checks the raw fingerprint before parsing JSON, and admits
the target once before waiting for the price context.
Existing commands, receipts, refusals
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
