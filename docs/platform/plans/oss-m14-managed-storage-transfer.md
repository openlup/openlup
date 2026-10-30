# M14 D32 — managed Storage object projection

Status: focused witness repair before native review, 30 October 2026; no installation
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
`04cb1137dca571fe99d685bb6c645e9441407339`. It was integrated without a
rebase and is the current `OPENLUP_STACK_BASE`. A stabilized
transfer-contract maintainer read precedes DCO. Two new FULL native reviewers,
including a simplicity assessment, follow. Canonical verification waits for the
predecessor on main; applicable queue freezes still apply. No hosted account,
credential acquisition, settings, deployment, production or release act is granted.

Own only the managed Storage projection, its composition with existing transfer
and access reconciliation, focused witnesses and affected owner documentation.
Add no transport, transfer format, table, migration, dependency or abstraction.
Preserve the predecessor's typed business/state rules and operator-source-archive
boundary. The finite positive cohort is nonpublic Standard buckets, including
empty buckets, with no policies except those naming exactly `{service_role}`: only the operator can read their objects at either end.
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
| `buckets.public`; source policy/grant facts | Admit `false` only, with row security enabled on both Storage relations and no policies except exact `{service_role}`; probe anonymous, mapped customer and operator reads on source and target. | Disabled row security on either relation, public bucket, a policy naming PUBLIC (OID 0) or any role set other than exactly `{service_role}`, unknown or changed effective grants. |
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

Required root discovery uses the stock PostgreSQL managed-compatibility adapter
and local Versity S3 for row projection, refusals, target access and copy proof.
The opt-in `runM14ManagedSourceWitness.mjs` enables GoTrue and Storage API,
creates/deletes objects through authenticated S3 and probes real source sessions.
Its private source input selects the same projection/copy assertions; required
discovery clears that input and never starts a CLI or service stack.
CLI 2.122.0 selects Storage API v1.84.19; inspect its installed schema before
mapping. The application baseline SQL does not own the service's Storage schema.
The disposable installed schema uses `file_size_limit`; the archived upstream
migration text also names the older `max_file_size_kb`. Either populated form
refuses in this profile.
New nonempty relations refuse. Every column in the pinned Storage schema has a
disposition below. Columns added by a later Storage version are not detected;
this projection is qualified only for pinned Storage API v1.84.19. Requalify
its column dispositions and witnesses after a Storage upgrade.
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
`tests/postgres/runM14ManagedSourceWitness.mjs` and its contributor invocation;
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

## Accepted read and current carry

Maintainer read CD-M14-68 accepted staged tree
`9afc03ce9a50c02093c22353e43878a833b1b066` and binary diff SHA-256
`307fc600826e204c2c45bd24a0b062a764b77bac5569c9275a78f601ba1e6687`
against `5289e6e482c37043dedb1432f89c4b50ca96546c`; the coordinator recomputed
both identities and found them equal. Exact-tree DCO commit
`45959a4550851eda936eb2bdf4d068a2ef59675e` preserves that read. Destination
prose and read identities were recorded under CD-M14-31 in
`43f4fffc77a715ea53c79089be4a7f1fafd137b7`. The accepted destination is the
existing 8B private filesystem store. Local S3 corroborates bytes and actor
access only; no exact S3-target-metadata claim is made. An S3 destination store
is a separate contract and is unnecessary for this parcel.

The prior pending carry was preserved and aborted. The current pending merge
has parents `43f4fffc77a715ea53c79089be4a7f1fafd137b7` and
`7c909b0bc453f855fb9c96175249c7da5b926686`. The resolved pre-rework tree is
`f00ab41e61428d9e4f2a2b3f780fdec5ad0acc55`. Both zero-context parcel patch IDs
against the old and new predecessor equal
`81b7ec3759fbe581225b39be2135a383b22696a9` under CD-M14-70.
The two union hunks retain the parcel's `storageRelations` declaration beside
the predecessor's verbatim `attemptLinks` helper, and retain both parcel
managed-Storage catalogue rows after the predecessor's
`tests/postgres/managed-compat/supabase.sql` row in sorted order. Only the JSON separators needed
to retain all entries are present. Other predecessor hunks merged automatically.
This carry imports only the same predecessor's lineage; the following approved
rework is a distinct delta covered by the combined read.

CD-M14-69 moves service startup, GoTrue sign-in and source Storage API actor
probes to the existing opt-in runner. Required discovery retains one shared
plain-Node projection/copy proof using the managed-compatibility adapter and
local Versity. The runner supplies its owned real source to that proof after
its managed business assertions, preserving a single object assertion path.
The fixture adds only the finite fields consumed by this projection to its
disposable minimal Storage relations. The runner records the installed service
schema independently. The shared compatibility adapter is unchanged.
The business fixture's Storage refusal case removes adapter rows after assertion;
the opt-in runner retires its real-source fixture through the Storage API before
the service leg uses that same owned source.

CD-M14-71 admits policies whose role OID array is exactly `{service_role}` and
empty private Standard buckets. PUBLIC (OID 0), authenticated, mixed and other
role sets refuse. The focused proof exercises these policy distinctions, mapped
and null ownership, erased-owner refusal, public refusal, checkpoint replay,
metadata agreement, final changed/deleted-key readback and empty-bucket capture.
The S3-source suite explicitly accepts empty ContentRange but refuses a nonempty
range. No label, route, target format, production schema or dependency is added.

The initial real runner reached the business assertions but fixture cleanup did
not complete. The service cleanup now uses the Storage API and the repeat run
passes. On 30 October 2026 the opt-in runner completed its managed-business and
Storage legs with no skips; the ordered managed-business assertion names and
statuses equal those from the stock-PG17 adapter. The shared Storage proof passes
with each source. Anonymous and mapped-customer source reads are denied;
operator reads succeed. Exact descriptors and bytes reach the private filesystem
store; local S3 corroborates bytes and access. Policy-role distinctions, empty
bucket capture, owner/refusal cases, checkpoint replay and final deleted-key
absence pass. The empty-bucket probe precedes final recapture, and no source
mutation follows that recapture before target restore.

The real run used CLI 2.122.0, macOS arm64 archive SHA-256
`fe87a5f9781d5423dbd5ebba2d5a6e1a541d01754d14941c574952e5695eaab0`,
binary SHA-256 `89838b26049c0672f9609aaf46455c89a46d351f852e313c0c5ae6b3abcbdf9d`,
and database image `sha256:c141fd17ac6a76c4323e90b3aee8ff1a23d2e89e547c2b963cfadc309c079cc2`.
Observed Auth and Storage image digests were respectively
`sha256:1736a63078f5922b198c4cbe50f80ab9a2d3b54fe8b7b6cfb2e9dc5dbbc12c6b`
and `sha256:a0420573837ee08c0afdc9cd01f90b4b8027579da99e0b9a159fe912ef756c99`.
The unchanged managed baseline SHA-256 was
`fb4de62d4ccf30dca83075b41ea2769ddf74165ecd47d21875790ed5f397ccbe`;
runner and shared-proof SHA-256 values were
`750a895c2ab16c427f464d20852b449a6beb675814c1b91b4cb1926eb4c39772`
and `aff0607995247c72e44a50c5bf372db112135dbe2de6b234e4cce3763bff9305`.
This is disposable local evidence, with no hosted qualification claim.

Strict all-project typecheck and required lint pass on the cleanup correction;
the affected adapter suites pass without skips. The unchanged S3-source suite
passes, including explicit nonempty ContentRange refusal. Publication policy
components, generated context, navigation, inventory and stack-scoped ownership
checks pass. The full policy wrapper requires the pending predecessor merge to
be committed before its ancestry check can use that pin; it must be repeated
after DCO. No publication cap changes; inventory measurements stay private.
No DCO of this pending merge or rework, native prepare/review, canonical verify
or external delivery has run; no repair cycle has been consumed. Final read
evidence includes an exact staged-tree redacted secret scan and WIP snapshot.

The managed-journey object leg follows separately owned 8D-2 after it lands,
with a main merge and another read. After this read's acceptance: DCO, prepare,
two new fresh full reviewers (one simplicity assessment, both checking nonempty
ContentRange refusal). Canonical verify waits for the predecessor on main.
Self-retro: retire service fixtures through their API and keep the empty-bucket
probe before final recapture, then hold quiescence through restore. One shared
projection/copy assertion path keeps adapter and real-source evidence comparable.

## Accepted rework and current predecessor carry

CD-M14-84 accepted tree `67cf06733c1e5b774105f82377c6cc12d43adbd4` and
binary delta SHA-256 `2035f7df3d49fefc9a6435055bb3c716fe8cd36c635c5199b8787eb011a2b1d7`
against `7c909b0bc453f855fb9c96175249c7da5b926686`. WIP commit
`11315a20f24e6f26e304937619aef1fb24080e78` preserves that source. The stopped
carry note was preserved separately before CD-M14-86 accepted its two owner-doc
splices: preserve the predecessor's typed-refusal prose, replace its superseded
Storage limitation with the accepted cohort sentences, and regenerate context.

The pending merge now has parents `43f4fffc77a715ea53c79089be4a7f1fafd137b7`
and `2c2ed7d94d4043963a7dfae23eb18fd3958b3fa2`; it imports only the same
predecessor's lineage, including its main merge. The resolved carry tree before
the new clause is `73fc3bf028bd7f5de332e3e5edab0cbb812d7248`. Outside the two
approved owner-doc hunks and generated context, both zero-context patch IDs
(excluding the separately parsed catalogue) equal
`85b875edc72bd676db133e3f4af79469f395f3ba`. Parsed catalogue additions,
removals and value changes are equal. The S3-source per-file patch IDs both equal
`9ff9e88d134fdb0473fb74103d9595eeab5fcf5d`; its nonempty ContentRange refusal
is unchanged. Policy freshness is main `18e1c9d3e1be45c6668923b71b21c7ef2317dc9a`,
separate from the predecessor review base.

Union resolutions retain the Storage inventory type import while honoring the
predecessor's removed invoice type; retain all new predecessor refusal tests
beside the accepted renamed Storage case and its API-owned cleanup; and retain
the runner's provider-role capture and current assertion pin beside the accepted
Storage service leg. The extension-point comment is replaced by that leg, as in
the accepted rework. No code or test predicate changes in the carry. The catalogue
and all other source paths merge automatically. Generated context is regenerated.

The new admission clause counts either Storage relation with disabled row
security as unsupported under the existing refusal code. Both relations must
have row security enabled beside the exact `{service_role}` policy rule. The
focused fixture enables it locally and independently disables each relation to
prove refusal; the shared managed-compatibility adapter SQL stays unchanged.
Storage capture now uses provider `postgres` rights, like the business capture;
the opt-in runner checks access to both Storage relations and policy facts before
running its assertions. The predecessor obligation table names MFA AMR claims,
the Storage cohort and the accepted renamed refusal case. The runner retains its
current managed-business assertion pin and no-skip check; Storage assertions
remain in its separate shared proof.

On the carried clause delta, strict all-project typecheck passes first; required
lint passes with zero errors and existing warnings. Focused managed-business,
Storage composition and S3-source suites all pass without skips, including the
nonempty ContentRange refusal. Documentation policy components, navigation and
stack-scoped ownership checks pass. The full policy wrapper still stops at the
uncommitted predecessor ancestry check; repeat it after the permitted DCO.

The real managed runner passes on 30 October 2026, with exact managed-business
assertion parity against the compatibility adapter. Provider `postgres` reads
both Storage relations and policy facts with its existing rights; no grant is
added. Source anonymous/customer reads are denied and operator reads succeed.
The same shared proof passes the row-security refusals, policy-role distinctions,
owner cases, private-filesystem copy/readback, interrupted replay and final
changed/deleted-key absence. Local S3 remains byte/access corroboration only.
The CLI, baseline and service image pins above are unchanged. This run's runner
SHA-256 is `35ed897575c273f6ee9ea101f9a283491fd4d25fee38a860b1da13cda8825b3a`;
the shared proof SHA-256 is
`aef5ebbead98f7d149c18e47f7a9eeb12f0ab2a0bf30faa5666040298644817e`.
Exact reports and fingerprints remain in private scratch. The staged tree is
secret-scanned before its WIP ref and read packet.

No DCO, native prepare, reviewer, canonical verify or external delivery runs in
this continuation. Review cycles remain unchanged. The lead runs the two fresh
Opus 5.5 FULL reviews after the read. The managed-journey object leg remains a
follow-up after 8D-2 lands, with a main merge and another read.
Self-retro: compare the accepted snapshot before edits; an explicitly accepted
owner-doc splice preserves both parcels' claims without widening the code carry.

## Accepted clause and review continuation

CD-M14-92 releases the clause tree `18b846e87ef1c9de9e63e2dc664fbba34545a133`
for predecessor carry, gates, DCO and two fresh full reviews. The current stack
base is `04cb1137dca571fe99d685bb6c645e9441407339`. The carry preserves the
accepted Storage delta, the predecessor's renewal/product-content text and its
updated proving tables. Only generated context required regeneration; code and
tests merged automatically. Carry comparisons remain in private scratch.

The review route now uses two independent fresh Codex gpt-6.1-sol reviewers at
xhigh on the standard tier; this supersedes the earlier Opus route in this record.
Both check nonempty ContentRange refusal, and one also judges a simpler sufficient
solution. A material finding returns to the lead before repair or narrowing.
After recording the reports this continuation stops: no canonical verification,
push or PR while the predecessor is off main. The journey object leg remains a
follow-up after 8D-2 lands. Self-retro: preserve the accepted delta separately
from changing predecessor context and compare only the approved splice exceptions.

The current carry passes strict typecheck first, required lint, focused mapper/Storage/
S3 tests without skips, and one real pinned managed-source run. The real business
assertions match the adapter; provider-postgres Storage capture and the shared
object proof pass. Final exact-tree secret scanning precedes the WIP ref and DCO.
The remaining native-review results belong in private reports; no tracked edit
follows the final PASS. The policy freshness pin for this continuation is
`fee33275b625d207ade7a5e62167d1df239d5f9f`, separate from the stack base.

## Pinned Storage column dispositions

Measured from the disposable Storage API v1.84.19 schema selected by CLI 2.122.0,
Storage image `sha256:a0420573837ee08c0afdc9cd01f90b4b8027579da99e0b9a159fe912ef756c99`.
The recorded live schema and image fingerprint agree with the existing mapper;
no populated pinned column is left without a disposition. A later added column
is not detected automatically. This table describes the pinned version only.

| Relation | Column | Disposition | Rule or bookkeeping reason |
| --- | --- | --- | --- |
| `storage.buckets` | `id` | Compared | Nonempty logical bucket identity; selects the existing S3 source and binds objects to its inventory. |
| `storage.buckets` | `name` | Compared | Must equal id; no separate target bucket record. |
| `storage.buckets` | `owner` | Compared | Deprecated owner provenance; if populated must agree with owner_id and resolve to an eligible item-7 subject. |
| `storage.buckets` | `created_at` | Bookkeeping | Source bucket creation time; no target bucket row or access grant depends on it. |
| `storage.buckets` | `updated_at` | Bookkeeping | Source bucket update time; target descriptors describe objects, not bucket history. |
| `storage.buckets` | `public` | Compared | Must be false; public buckets refuse. |
| `storage.buckets` | `avif_autodetection` | Compared | Must be false; enabled transformation refuses. |
| `storage.buckets` | `file_size_limit` | Refuses when populated | No exact target admission-constraint equivalent. |
| `storage.buckets` | `allowed_mime_types` | Refuses when populated | No exact target admission-constraint equivalent. |
| `storage.buckets` | `owner_id` | Compared | Eligible item-7 provenance only; not target metadata or a grant. |
| `storage.buckets` | `type` | Compared | Must be STANDARD; other bucket types refuse. |
| `storage.buckets` | `versioning_status` | Compared | Must be DISABLED; history dependencies refuse. |
| `storage.buckets` | `lifecycle_configuration` | Refuses when populated | No lifecycle carrier in the selected profile. |
| `storage.buckets` | `lifecycle_configuration_generation` | Refuses when populated | No lifecycle generation carrier in the selected profile. |
| `storage.objects` | `id` | Compared | Required independent source record identity; database primary key supplies uniqueness. |
| `storage.objects` | `bucket_id` | Compared | Must name an admitted bucket in the independently captured rows. |
| `storage.objects` | `name` | Mapped | Exact existing descriptor key; duplicate keys refuse. |
| `storage.objects` | `owner` | Compared | Deprecated owner provenance; agreement and eligible item-7 resolution required if populated. |
| `storage.objects` | `created_at` | Bookkeeping | Source creation time; the existing descriptor has no creation-time contract. |
| `storage.objects` | `updated_at` | Bookkeeping | Source metadata update time; byte/hash/descriptor agreement supplies the carried object state. |
| `storage.objects` | `last_accessed_at` | Bookkeeping | Source read telemetry; no portable object or effective grant depends on it. |
| `storage.objects` | `metadata` | Compared | Size, MIME type, cache control and content encoding must agree with GET; expiry refuses. Other source observation keys do not become target metadata or grants. |
| `storage.objects` | `path_tokens` | Compared | If present, must equal name split on slash; no alternate path is carried. |
| `storage.objects` | `version` | Compared | Null or nonempty managed generation string; the descriptor version comes from the existing S3 reader and digest, not this opaque generation. |
| `storage.objects` | `owner_id` | Compared | Eligible item-7 provenance only; no target metadata or grant. |
| `storage.objects` | `user_metadata` | Mapped | Exact returned string pairs through existing s3.user.* descriptor fields; malformed or unreturned values refuse. |
| `storage.objects` | `archived_at` | Refuses when populated | Only current ordinary objects are admitted. |
| `storage.objects` | `is_delete_marker` | Compared | Must be false; retained delete markers refuse. |
| `storage.objects` | `is_versioned` | Compared | Must be false; retained version state refuses. |

## Storage acceptance checklist before review

This list fixes the review obligations; a state marked pending is not proof.
The last executed full candidate is the committed predecessor carry.

| Dimension | What must be true | Proof and current state |
| --- | --- | --- |
| Relations | Storage buckets/objects project through the existing path; other nonempty unknown relations refuse. | Existing focused managed capture and Storage composition tests pass. The column table above is measured; no new relation census is claimed. |
| Row classes | Only private Standard current objects, including empty buckets, with enabled RLS and exact service-role-only or absent policies admit. Unsupported bucket/owner/metadata/history/partial state refuses. | Focused and real proofs exercise public, constraint, policy-role, RLS, conflicting/unmapped/erased-owner and metadata cases; unchanged S3 source tests own protocol/history/partial-response refusal. Not every possible schema-permitted value is executed. |
| Hand-built fields | Bucket/key/reference construction uses captured rows, exact GET descriptors and existing reconciliation. Source owner is not a grant or target field. | Composition verifies independently listed keys, GET bytes and final changed/deleted-key readback; no exhaustive per-field mutation measurement is claimed. |
| Copied fields | Existing descriptor metadata/access/hash/size are preserved in the private filesystem store. | Executed readback compares descriptor metadata/access and streamed digest/size. Local S3 proves bytes/access only; exact S3 destination metadata is not proved. |
| Capture authority | Provider postgres reads Storage rows and policy facts without a new grant. | Real runner checks both Storage relations and pg_policy under provider postgres; executed PASS. |
| Snapshot consistency | Capture uses repeatable-read/read-only and fails on filtering; operator excludes DB/object/policy writers through final recapture and restore. | Existing capture boundary tests, reconciliation/replay and final changed/delete proof pass. Hosted writer exclusion and whole-store activation are not proved. |
| Privacy: erased owners | Valid completed-erasure subject provenance may map for item 7, but its retained Storage owner must refuse at Storage; sole unmapped owners must also refuse there. | The old malformed-erasure case remains separate. The approved receipt fixture now proves item-7 mapping retains a valid erased subject and Storage refuses its owner; sole-unmapped-owner refusal also passes. Removing the guard makes both discriminators fail. Focused and real-source runs pass. Fresh reviewer closure remains pending. |
| Documentation claims | Claims match pinned behavior, destination and preview scope. | Schema-drift wording is narrowed here under the prose rule; policy checks pass and fresh review is pending. No hosted qualification, customer-facing media route or journey-object proof is claimed. |
| Schema drift | Every pinned column has a stated disposition; new nonempty relations refuse. Upgrade-added columns are not detected. | Measured table above; requalification after a Storage upgrade is required. Automatic unknown-column refusal is not implemented or claimed. |

## Owner-witness fixture setup read

The pinned managed baseline and compatibility setup do not define
`public.identity_privacy_erasures`. The existing identity-mapping test stores
representative erasure records in a temporary JSON projection and passes them
directly to the identity mapper. The Storage boundary is reached only through
the [managed database capture](../../../server/adapters/postgres/connectedManagedRetained.ts)
and its privately held relation rows, so those direct
identity inputs cannot populate its erasure set.

CD-M14-97 approves a test-only receipt relation in the disposable managed source,
using the proposed existing item-7 row shape and constraints, dropped in cleanup.
A conditional SELECT grant to provider postgres is permitted on that fixture-owned
relation only. Capture continues under the provider role; no production schema,
migration, exported seam or guard changes. Both owner discriminators and their
guard-removal check use the same shared proof. All four native cards remain open
until fresh reviewers close them; no closure is claimed here.
Self-retro: a malformed identity rejection is not evidence for the later Storage
owner gate; state the missing valid receipt carrier before extending the fixture.

## Approved owner-witness repair

The proof creates its scratch parent before allocating a private directory. Its
disposable receipt relation uses the approved row shape and is dropped in cleanup,
including failed assertions. The sole-unmapped-owner case uses one populated owner
field. The completed-erasure case retains the managed subject through its receipt
and separately proves item-7 identity mapping succeeds before requiring a
Storage-specific refusal. Both checks collect failures so removing the existing
guard must expose both mistakenly admitted owners in one run. The earlier malformed
identity rejection remains as a separate discriminator. No production guard changes.
Strict typecheck passes first; required lint passes with no errors. The focused
mapper/Storage/S3 suites pass without skips. With the existing owner guard removed,
both sole-unmapped-owner and valid completed-erasure-owner assertions fail; the
production file is restored byte-for-byte. One real pinned managed-service run
passes the same shared proof, with unchanged Storage schema and business-assertion
parity against the adapter. The fixture receipt relation is removed in cleanup.
The current proof SHA-256 is
`0463480406e5a00ec8c2fe77b765aa404c2618e52256e04cb8917244d8667e8f`. All four cards remain open
until fresh native review closes them. Self-retro: distinguish valid identity provenance from
Storage-owner eligibility, and require the same witness to reject guard removal.
