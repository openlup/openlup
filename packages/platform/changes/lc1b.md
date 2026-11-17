- Add draft payload v3 for ordered publication operations, explicit eligibility,
  immutable provenance/media claims and explicit document-derived SKU cache
  effects. Freeze the shared-content extraction envelope and include every new
  field and operation order in candidate reconstruction/digests. Saving a draft
  executes no operation; publication and runtime capabilities remain unbound.

Migration: upgrade to the explicit `createPostgresCatalogDraftStoreV3` and
`createCatalogDraftHandlerV3` readers before authoring payload/commands v3.
`CatalogDraftPublicationStored*` is the additive v1/v2/v3 union; existing v1 and
v2 DTOs, parsers, handlers and adapters retain their version boundaries and exact
canonical bytes, fingerprints and original receipt replay. Unknown versions
refuse. The self-contained candidate-reference format remains v1 and resolves
immutable v3 data without an additional candidate table. V3 prices use the
unchanged positive gross one-time/minimum-one command; no scheduling, tier,
context-version or zero-price extensions are added.

The native forward expands only draft apply admission on the four existing
retained draft relations. Abandon/resume retains reservations and payloads;
there is no backfill, new relation or change to transfer order, privacy or
absorption classes. Stop v3 authoring before rolling readers back; retain a
compatible reader for v3 history. No live catalogue, price, subscription, order
or delivery fact is changed.

`sharedContent` has a closed versioned envelope for action, document,
presentation, memberships, requested modes and complete authored SKU facts;
installed validators own the opaque data within it. Provenance for the current
draft resolves from its persisted receipt rather than recursively embedding its
own fingerprint. Retained provenance uses an explicit immutable tuple and a
matching evidence claim. The publisher still verifies every claim and operation;
these input contracts provide no authorization or external readiness guarantee.

Managed divergence design: the managed rail does not supply this feature.
A future twin expands the managed draft apply routine on its existing heads,
revisions, receipts and reservations, deriving the actor from verified session
membership and preserving RLS, operator access and default-deny browser writes.
The native invoker's owner/runtime grants have an equivalent managed routine
and RLS expression; no native-only authorization semantics are introduced.
No product/SKU column is changed; industry-specific food-column relaxation
remains with the later reader/adoption boundary.
