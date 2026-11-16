### Added

Versioned catalogue draft payload v2, resume and stateless candidate previews.

Migration: apply the complete native catalogue through position 147 before
using v2 commands. `CatalogDraftPayload`, `CatalogDraftCommand` and their existing
schemas retain v1 behavior. New `CatalogDraftPayloadV2` and command schemas carry
typed attribute data and complete immediate positive gross one-time base-price
commands at minimum quantity one, including the wholly-null or wholly-set
expected entry ID and amount. A zero new amount refuses. Unknown payload and
command versions refuse; later versions cannot reinterpret or rewrite v2 bytes.
There are no price writes in this change.

Opt in with `createPostgresCatalogDraftStoreV2` and `createCatalogDraftHandlerV2`;
the original factories retain v1 admission and result types. These new factories return
`CatalogDraftStoredRecord` / `CatalogDraftStoredApplyResult`, whose payload is the
explicit v1-or-v2 union. Version-specific schemas remain available. `draftsFor`
adds definition-typed v2 attributes and required-key checking; the wire schema
and handler still save incomplete drafts, reporting publication readiness issues.
The async `validateCatalogDraftV2` reuses the attribute owner and optional reference
resolver. Old v1 consumers keep their exact canonical command and receipt bytes.
Stop v2 authoring before rolling back readers; old latest-record readers refuse
v2 records. Retain schema and history, and keep a compatible reader to access v2.

The v2-only `resume` command copies an abandoned draft's payload into an open
revision under the same retained reservations. Original abandonment receipts
still replay exactly, and legacy revise on an abandoned head still refuses.
No backfill or history rewrite occurs. All four draft relations remain
authoritative retained transfer data in their existing order and privacy class;
the round-trip matrix now covers v2 price plans and resume history. No new
relation, client foreign key or absorption class is needed.

`createCatalogCandidateService` prepares read-only previews through explicitly
supplied authorized readers. Its reference encodes the immutable draft revision
and expected publication identity, or known unpublished state. Reconstructing
resolves and compares the whole head including documentDigest, compares installed
and composed definition digests, and hashes the parsed canonical payload,
definition evidence and expected head. The caller's head and candidate digest
are checked by `compareCandidate`; missing price validation leaves a blocking
issue for price-bearing drafts. Publication must run reconstruction and refusal
of all issues inside its own transaction. No candidate table/cache, publisher
constructor, publication binding or capability activation is added.

Managed divergence design: the managed rail does not supply this feature.
A future twin replaces the existing managed draft apply routine with the same
version discrimination, retained receipts and resume semantics on its four
existing draft relations. It derives the actor from verified session membership,
retains their RLS/default-deny browser access and operator-session checks for
drafts. Publication retains its separate human-admin boundary and excludes
service credentials. Native
owner/runtime invoker authorization maps to managed routine grants plus RLS;
no native-only authorization role semantics are introduced. No live product/SKU
column, including industry-specific nullable fields, is changed or relaxed here.
