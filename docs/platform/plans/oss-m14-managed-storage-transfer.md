# M14 D32 — managed Storage object projection

Status: maintainer read accepted, 30 October 2026; no installation
qualification. Audience: transfer implementers and reviewers. This parcel remains
in development preview and does not establish whole-M14 completion.

## Outcome, scope and authority

Transfer a nonempty, explicitly supported managed Storage cohort into a portable
installation through the existing [object path](oss-m14-object-access-transfer.md).
Project metadata into existing typed descriptors and owner provenance, copy and
read back bytes, preserve effective access, and exclude deleted objects at final
recapture. Unsupported semantics refuse before activation. The approved outcome
requires a positive managed-source witness; an all-refusal implementation is
insufficient.

The active supervisor is the single writer in the assigned task worktree, stacked
on the managed typed-transfer predecessor. The accountable maintainer's bounded
grant covers local implementation and synthetic proof, DCO, independent review
and gated submission/merge. The accepted predecessor head is
`5289e6e482c37043dedb1432f89c4b50ca96546c`, tree
`8c5383fd4b1adaade4002163170bde0385317a51`. It was integrated without a
rebase and is the `OPENLUP_STACK_BASE`. A stabilized
transfer-contract maintainer read precedes DCO. Two new FULL native reviewers,
including a simplicity assessment, follow. Canonical verification waits for the
predecessor on main; applicable queue freezes still apply. No hosted account,
credential acquisition, settings, deployment, production or release act is granted.

Own only the managed Storage projection, its composition with existing transfer
and access reconciliation, focused witnesses and affected owner documentation.
Add no transport, transfer format, table, migration, dependency or abstraction.
Preserve the predecessor's typed business/state rules and operator-source-archive
boundary. The finite positive cohort is nonpublic Standard buckets with no
Storage access policies: only the operator can read their objects at either end.
The pinned managed application baseline references no Storage object from a
platform table; customer-facing media transfer is outside this parcel. General
Storage-policy translation, version-history transfer, arbitrary bucket features,
hosted qualification and whole-store activation are excluded. A separate
managed-journey owner holds its fixture files; after its parcel lands, adding
this object leg requires a main merge and another read.

## Existing carriers and mapping proposal

[`TransferObject`](../../../packages/platform/src/portability/objects.ts) has
`key`, `version`, `bytes`, `sha256`, string-valued `metadata`, `access` and optional
`lineage`. It has **no owner or ACL field**. The
[S3 source](../../../server/adapters/s3/transferObjectSource.ts) supplies authenticated
listing/GET and reference reconciliation. The existing
[access reconciler](../../../server/adapters/filesystem/orderReviewMediaTransferAccess.ts)
checks typed order-review media references at customer/admin serving routes.
This managed cohort has no such reference. Its portable destination is the
existing private filesystem `TransferObjectStore`. Managed Storage API and local
S3 actor probes corroborate access and bytes; no customer route is added.
The existing S3 label is `authenticated-source-read` at
[`transferObjectSource.ts`](../../../server/adapters/s3/transferObjectSource.ts);
it records an authenticated GET, not an ACL. There is no existing anonymous-read
object access label in that source, the serving adapters, their tests or the
8B task record, so public buckets refuse. Owner IDs are provenance only and
are never written into target metadata.

| Managed field or fact | Existing carrier and rule | Refusal boundary |
| --- | --- | --- |
| `buckets.id`; `objects.bucket_id` | Select the same logical bucket for the existing S3 source; join every object to exactly one bucket. Bucket identity remains bound to the source inventory and selected destination namespace. | Missing/duplicate bucket, orphan, cross-bucket collision or ambiguous target namespace. |
| `buckets.name` | Require the selected API bucket name and ID to identify the same namespace; no native bucket table is created. | Distinct identities without an existing exact target representation. |
| `buckets.public`; source policy/grant facts | Admit `false` only, with no Storage policies; probe anonymous, mapped customer and operator reads on source and target. | Public bucket, any Storage policy, unknown or changed effective grants. |
| Bucket and object `owner_id`; deprecated `owner` | Each populated ID resolves through item 7's exact `subjects` mapping to one `principalId`; the result is provenance, not a grant. Null is admitted. If both columns are populated, require agreement. | Unmapped, conflicting or erased/ineligible owner. Never infer by email or encode an owner in target metadata. |
| `buckets.type` | Standard object bucket only; this selects the existing object profile. | Analytics/vector or unknown type. |
| `file_size_limit` (or older `max_file_size_kb`), `allowed_mime_types`, `avif_autodetection` | Admission constraints must match an already expressible target profile; they are not descriptor ACLs. | Any populated constraint/transformation without an exact existing target equivalent. |
| `versioning_status`, lifecycle configuration/generation | Require the existing finite no-history/no-lifecycle-dependency profile. | Enabled/suspended history, populated lifecycle dependency, missing authoritative feature facts. |
| `objects.name` | Exact `TransferObject.key` within one selected bucket; preserve spelling. | Invalid key, normalization/namespace collision or unsupported target key shape. |
| `objects.id` | Independent source-record identity binding the object/reference census. | Duplicate identity or missing authoritative source record. |
| `objects.version` | Source observation for consistency; retain the S3 source's computed `sha256:` logical descriptor version. | Source changes, unexplained version dependency or returned native S3 version history. Never use a provider version string as a content hash. |
| `metadata.size` and returned `Content-Length` | Exact byte count in `TransferObject.bytes`, validated against streamed bytes and source row. | Missing, malformed, contradictory or over-limit length; partial response. |
| Object bytes | `TransferObject.sha256`, computed from authenticated GET, then existing copy/readback/checkpoint checks. | Missing/denied/unavailable body, digest mismatch or divergent replay. ETag is not SHA-256. |
| `metadata.mimetype`, cache/header metadata | Corresponding observed `s3.content-type`, `s3.cache-control` and other existing S3 descriptor metadata, with exact row/response agreement for admitted fields. | Unexpressible or conflicting metadata. |
| `user_metadata` | Only exact string pairs returned by S3 and preserved as existing `s3.user.*` metadata. | Nested/nonstring or unreturned metadata, missing metadata or overflow. No new JSON encoding convention. |
| Timestamps, `path_tokens`, `level` | Source consistency/derived-path checks; not new target ownership or access fields. Installation bookkeeping stays in the operator archive. | Unsupported active dependency, inconsistent derived path or unknown semantic column. |
| `archived_at`, `is_delete_marker`, `is_versioned` | Admit only current ordinary objects under the no-history profile. Deleted ordinary objects are absent from final inventory. | Retained versions/delete markers or unexplained physical/logical absence. |
| Multipart records; pending/partial/cleanup records | Existing S3 feature facts and obligation entries, bound to source record IDs and retained typed duties. | Physical multipart state or a duty without an existing exact target representation; never assert absence from listing alone. |
| Source identity/snapshot | Existing `TransferObjectInventory.sourceId`, quiesced snapshot and copy-generated target `lineage`. | Missing writer exclusion, mismatched DB/object boundary or changed independent references. |
| Anonymous, mapped customer and operator observations | Source Storage API: anonymous/customer denied, operator allowed. Target S3: anonymous denied, customer has no serving route, operator allowed. | Access widening/loss, indistinguishable identities or missing actor observation. |

The table names existing carriers without adding generic bucket or ACL metadata.
The pinned managed application baseline has no `commerce_order_review_media`
table or other platform Storage reference. An unknown adopter-owned nonempty
reference relation already refuses at the managed database boundary. This
parcel carries only the unreferenced operator-only platform cohort and must
not fabricate media grants or customer routes.

## Byte path and source evidence

Use the existing S3 client's explicitly supplied authenticated connection against
the managed Storage **logical S3 endpoint**, one selected bucket at a time.
Supabase documents local `/storage/v1/s3` on the selected API port, region `local`,
and hosted `/storage/v1/s3` with the project's supplied endpoint/region in its
[S3 authentication guide](https://supabase.com/docs/guides/storage/s3/authentication).
Its [protocol endpoint](https://supabase.com/docs/guides/self-hosting/self-hosted-s3)
is distinct from its underlying physical backend. Do not read implementation
backend keys or translate REST responses into a new transport. Endpoint/credential
absence refuses; hosted setup remains an operator prerequisite, not work in this
parcel.

Feed that client to `createS3TransferObjectSource`; use existing
`captureAgainstReferences`, `copyTransferObjects`, exact target readback and
checkpoints. DB rows independently enumerate expected keys and obligations;
bounded authenticated GETs supply content hashes not stored in those rows.
Construct expected descriptors from each independently named row's GET, then
reconcile with full traversal and reread the held source references. Do not derive
the expected key set from S3 listing. Reconcile before and after under exclusion
of DB, object, policy and ingress writers; a repeatable-read transaction alone
does not freeze Storage.

The supplied managed fixture currently excludes Storage API and writes a metadata
row; its journey's separate filesystem bytes are not an authenticated managed
Storage witness. The later witness must start the pinned disposable Storage API,
create/delete objects through that API, and retain its metadata/API agreement.
CLI 2.122.0 selects Storage API v1.84.19; inspect its installed schema before
mapping. The application baseline SQL does not own the service's Storage schema.
The disposable installed schema uses `file_size_limit`; the archived upstream
migration text also names the older `max_file_size_kb`. Either populated form
refuses in this profile.
Schema drift, new nonempty relations or unknown object semantics refuse.
The pinned upstream schema and GET implementation have been inspected. The
disposable API witness confirms live SDK/header compatibility with the existing
strict reader while retaining partial-response and content-integrity refusals.

## Acceptance, sufficient evidence and proof plan

1. After the accepted predecessor merge, replace its nonempty-Storage refusal
   only with the complete supported projection. Reuse item 7 identity provenance
   and the existing object/reference/access receipts; retain unrelated refusals.
2. On the real pinned disposable managed source, use a mapped owner, null owner,
   unrelated customer and operator identities and at least two real API-created
   objects. Transfer to qualified PG16 plus the existing private filesystem store,
   with local S3 access/byte corroboration. A metadata-only seed or mocked byte source fails
   this acceptance.
3. Prove exact descriptors, streamed byte equality and counts/owner provenance;
   verify effective source/target access through the Storage API and S3 actor
   matrix. The mapped customer is denied; no customer route is installed.
4. Interrupt after a checkpoint and prove exact replay; change/delete an object
   before the final quiesced recapture, use a fresh inactive target generation,
   and prove old/deleted-key absence through storage and serving readback.
5. Execute focused discriminators for the table's refusal classes: unsupported
   bucket/policy/owner/metadata/features, including an erased owner and public
   bucket; filtered inventory; absent/drifting
   bytes or references; divergent replay; and changed effective access. A
   refused generation remains inactive. Existing 8B tests can supply unchanged
   byte/reconciliation boundary proof; new tests must exercise the changed
   managed translation and its real composition.
6. Before the implementation read, catalogue every new file, regenerate docs,
   run cheap policy/inventory/neutrality/structural/secret checks and focused
   witnesses, then strict `oss:published-tree -- --typecheck` and required lint
   under the applicable load rules. Freeze the packet before DCO. Obtain two
   fresh FULL reviews; reserve canonical verification for a landable tree after
   the predecessor lands. Preserve native findings, cycles and expiry.

Owned paths: this record and publication-catalogue row;
`server/adapters/postgres/connectedManagedRetained.ts`;
`tests/postgres/managedStorageTransfer.test.ts` and its plain-Node proof;
the existing S3 source and
adjacent test for pinned empty headers; and the existing transfer sections in
data and adapter documentation. The managed journey object leg follows the
separately owned fixture parcel after it lands.

## Risk, simplicity and handoff

The main risks are treating privileged GET as a domain grant, assuming an owner
field grants access, constructing a false independent census, and qualifying a
database/object boundary while Storage writers remain active. Another risk is
inventing a generic ACL carrier because a native descriptor lacks one.

Simplicity pre-check: a finite row-to-existing-carrier projection plus composition
of 8B source/copy/reconciliation is the smallest adequate solution. A new REST
reader, generic policy interpreter, metadata-only ACL or transfer framework adds
cost without satisfying the existing target's effective-access boundary.

Design source head: `3db2a2775f6ff3d9d689a636261c2e1eafa23fcc`.
Freshly fetched policy revision: `4fd84bfead64e11f76e0555117fe072d39807182`.
Pre-addition tracked inventory: 6,701 files / 50,868,648 bytes. No package file,
export or package budget changes are proposed. Dependencies were installed with
Node 24.21.0, npm 11.19.0 and the tree's CLI 2.122.0. The predecessor is merged
without DCO into this worktree. The focused real managed Storage API → qualified
PG16/8B filesystem proof passes (two objects, mapped/null ownership, access
probes, checkpoint replay, refusal probes and final change/delete absence).
The adjacent S3 source and managed mapper suites pass 35 tests. Strict
five-project typecheck has zero diagnostics; required lint has zero errors.
The catalogue, documentation ownership, inventory, structural scan, whitespace
and redacted staged-tree secret scan pass. A WIP snapshot preserves the candidate.
Maintainer read, DCO, native review, canonical verification and external
delivery have not run for this parcel; no repair cycle is consumed.

Maintainer read CD-M14-68 accepted staged tree
`9afc03ce9a50c02093c22353e43878a833b1b066` and binary diff SHA-256
`307fc600826e204c2c45bd24a0b062a764b77bac5569c9275a78f601ba1e6687`
against `5289e6e482c37043dedb1432f89c4b50ca96546c`; the coordinator recomputed
both identities and found them equal. DCO commit
`45959a4550851eda936eb2bdf4d068a2ef59675e` preserves that exact tree.
The accepted destination is the existing 8B private filesystem store. Local S3
corroborates bytes and actor access; its pinned gateway omits cache control on
returned GET after PUT, so no exact S3-target-metadata claim is made. An S3
destination store is a separate contract and is unnecessary for this parcel.
This prose-only correction narrows the documentation to that evidence under
CD-M14-31; it changes no implementation, test, catalogue or refusal.

Next: carry the accepted predecessor lineage and obtain full native review. The managed-journey
object leg follows its separately owned fixture parcel after that lands.
Self-retro: direct pinned-service proof caught an older migration column name,
an optional empty response header and the local S3 metadata gap. Keep exact
row/header agreement and report the destination limit instead of weakening it.
