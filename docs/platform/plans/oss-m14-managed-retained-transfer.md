# M14 D32 — managed retained transfer

Status: development-preview task record; implementation and proof in progress. This record
is not a transfer qualification.

## Outcome, scope and authority

Capture one disposable managed installation with synthetic data, actual Auth and
Storage metadata, explicit issuer/subject mapping, and its complete retained
business graph. Map active obligations into canonical target stores; retain full
source history that has no native representation in a finite private sidecar.
Every source relation and row class needs an explicit disposition. Unknown
nonempty data, conflicting mapped fields, missing retention or missing privacy
coverage must refuse publication.

The active supervisor is the single writer in the assigned task worktree. The
maintainer's bounded programme grant covers local implementation and synthetic
proof, DCO, independent native review, submission and queue merge after required
gates. API/security-control changes require the stabilized maintainer read before
DCO. There is no release, hosted-resource, credential, deployment or production
authority. The [contribution rules](../../../CONTRIBUTING.md#deliver-a-change)
own delivery and [native review](../../../CONTRIBUTING.md#native-review-and-accountability).

This parcel owns business extraction/mapping, contributors, the sidecar and the
finite admission of four existing canonical communications tables in connected
restore. The qualified installer and capture's cluster-identity check belong to
a separate writer. Object
source/serving adapters and the recipe runner are also separately owned.
Catch-up/final recapture, the second transfer leg, complete object ACLs,
restricted restore and measured recovery are excluded.

Code base: `15a708a6b5b34f8a6d27b25f4867787425084bf7`.
Fetched instruction revision: `ef99742de560bb88865794a8a1694884d65d06ea`.
Canonical owners: [compatible transfer](../DATA_AND_MIGRATIONS.md#compatible-data-transfer),
[identity mapping](oss-m14-managed-identity-mapping.md) and
[existing transfer](oss-m14-existing-store-transfer.md).

## Acceptance and proof plan

Use the existing managed installation fixture or pinned local stack and a fresh
qualified PG16 target. Replace the temporary identity-projection witness with
actual extraction. Compare complete source/target rows, outstanding obligations,
source-keyed receipts and sidecar records by source/table/row identity. Preserve
the independent target installation key and the existing acquisition drain;
source-keyed history must never enter active target-key lookup tables.

Exercise sidecar export/readback and erasure/redaction, proving erased personal
data absent from readback. Prove unknown nonempty-table, missing-coverage and
mapped-field-conflict refusals before publication. Complete affected real-PG
proof, cheap gates, required read, two fresh full reviews and canonical verification
before delivery. Local PG evidence cannot establish hosted-provider acceptance.

The smallest adequate route is fixed domain mapping into the existing atomic
restore and an object-boundary sidecar. A generic importer, post-commit inserts
or treating active obligations as archive-only history would add risk or fail
the accepted outcome.

## Finite communications admission

The fixed native capture/restore profile omits the canonical communications
stores used by the native runtime: `communication_recipient_consents`,
`communication_native_sends`, `communication_native_observations` and
`communication_native_sync_state`. The latter references retained `outbox_events`.
Existing runtime reconciliation and sync read those stores, not a history sidecar.
An outbox row without its sync state is not a complete retained obligation.

Adding these tables to capture alone cannot work: restore's fixed insertion
order does not visit them, and its complete final census would reject their
missing rows. Inserting them before restore also fails its outside-profile
emptiness check; inserting after commit loses atomicity and exact replay proof.

The lead expanded this parcel's ownership to admit these four fixed canonical
tables into the existing transaction, schema/column checks, insertion order and
exact replay/final census, with sends before observations and outbox before sync
state. Catalogue checks, unknown-table refusal, pristine-target checks and
installation-key preservation remain binding. No arbitrary SQL callback, schema
migration or grant is included. This change enters the required API/control read
packet before DCO. Source-graph inspection also found five existing canonical
tables needed to serve a mapped subscription's catalog and frozen line price:
`catalog_products`, `catalog_skus`, `price_lists`, `price_entries` and
`subscription_lines`. Their finite capture/admission and FK order use the same
transaction, checks and replay census. These five names also enter the read packet.

The managed source has further active classes without a matching portable
canonical representation (notably `addresses`, `pets`, payment attempts and
provider-backed invoice issue state). A source row in an unsupported class must
refuse activation unless a verified mapping preserves its obligation; retaining
the row as history alone is insufficient. The source fixture and mapping proof
must establish which finite cohort can pass and which rows refuse.

## Hosted handoff limit

The disposable local managed fixture does not establish hosted service-relation
dispositions. Hosted managed projects may have nonempty `realtime`, `net`,
`cron`, `supabase_functions` and `vault` relations, which this capture currently
refuses if they are outside its finite profile. The hosted leg needs explicit,
read-approved dispositions before admission. Vault and other secret-bearing
relations must remain disposition-only; their rows must never enter the
business capture or retained sidecar.

## Evidence and handoff

After a host reboot removed the original temporary worktree, the assigned
worktree was recreated under the durable repository worktree directory.
`npm ci` was rerun, the staged candidate was recovered from Git objects, and
private WIP refs now protect the subsequent edits. The pinned Supabase CLI
2.98.2 disposable installation supplies actual Auth, Storage and service
metadata; its business fixtures contain only synthetic values. The target is
a separately installed qualified PG16 container. The finite native-profile
transfer suite passed 5/5 after the catalog and communications additions.
The managed test's actual extraction exposed a pending subscription welcome
outbox item and its source email timeline. The pending item now projects to the
canonical outbox, with its complete source timeline retained privately. The
final post-reboot focused evidence is managed source→qualified PG16 4/4 and
native connected transfer 5/5, including exact source/sidecar row identities,
target rows and obligations, erasure readback, unknown nonempty relation,
missing privacy coverage and mapped-field conflict refusals. `ast-grep`, lint
(zero errors), publication inventory, neutrality and redacted Gitleaks passed
on the original staged candidate. The maintainer read accepted tree
`47442a0429655c7eda34c1ee507bd8e1ea626b75`; the DCO commit is `df90117` and
includes the test-guidance no-impact trailer. `origin/main` later included the
object-transfer and restricted-restore parcels. Their overlapping capture,
restore, documentation, catalogue and witness hunks were merged manually,
with managed capture aligned to the ordinary-session cluster identity SQL.
The three focused real-PG suites passed 17/17 on that staged merge candidate.
The maintainer accepted the merge read; merge commit `ecdb6b6` has parents
`df90117` and `c31cc19`, with the accepted tree
`8fa143f6b5c9d9ca885f2af4a4b0081df2c49334`. A following DCO metadata
commit records the merged documentation-impact digest because the policy reader
excludes merge-commit trailers. The public policy and documentation check passes
against the new main base. Full canonical verification, native review, PR and
receipt are not yet claimed.

Native review cycle 0 of tree `dd98de8cfa964412381e576b73ea8398245db0dd`
returned one PASS and one material FAIL: the admission route checked only
caller-held sidecar bytes, allowing restore when the private object was absent.
The proposed repair requires a versioned object reader, checks its descriptor
and complete bytes before database mutation, and exercises absence and actual
private-store readback in the managed PG16 witness. This material repair awaits
a new maintainer read before DCO and fresh full review; cycle 0 evidence and
the open finding remain in the native session history.

After the accepted repair commit, native `prepare` refused source-review
carry-over because main advanced to `d1800393caad3b101173f8c100625d1c974c451f`.
The forced main merge was conflict-free; its exact mechanical `merge-tree`
result is `3f81a34eca5df4820bf5148f9c641ddfa2d4eed1`, with parents
`9fc0d5702679153bdc47254dd1f8a166f86d6779` and `d1800393caad3b101173f8c100625d1c974c451f`.
Excluding this task record, the stable parcel patch ID is
`1700f302b525e44c3edcc5c9abb1921ac825c329` against both the old
`c31cc19` base and new main. The only extra parcel edit in the merge is this
lineage note. Full native review remains required on the merged tree.

Cycle 1 obtained two fresh full PASS reports and closed the stored-object
readback finding. Canonical verification passed policy, inventory, DCO,
Gitleaks, install and lint, then stopped at typecheck: 54 errors, all in this
parcel's managed adapter. A function declaration for the existing `never`
failure helper restores TypeScript control-flow narrowing. An equivalent null
comparison and numeric checks for settlement cents close the remaining three
errors; malformed nonnumeric money now refuses before projection. All five raw
TypeScript projects pass on this repair. Because the numeric check tightens a
runtime refusal, the exact repair awaits a maintainer read before DCO and fresh
full review; the prior review and failed canonical result remain in evidence.

The accepted typecheck repair was DCO committed as `3fc2d640` (tree
`2d388f7527c3c1196dc317ff3b2b07cbc8cfda74`). Two new full cycle-2
reviews passed and native verification reported `reviewed`. During the
load-gated canonical run, main advanced to `b5451b24c2dbb753f54965226d9c40972d70f356`;
the policy phase refused review carry-over before running its command. The
forced main merge was conflict-free with mechanical `merge-tree` result
`2942225dea774d5f7ab0ab1a1e1f5d896f177eb2`, parents `3fc2d640` and
`b5451b24`. Excluding this task record, the stable parcel patch ID is
`346bd3775510776ca657fd34e7c650c7d7e321cd` against both the old
`d1800393` base and new main. This lineage note is the only parcel edit.
Full native review and canonical verification remain required on the merge.

Self-retro at this stop: the first actual managed extraction revealed a pending
welcome outbox item and email timeline that synthetic projection alone missed;
using the pinned local stack made the missing duty observable. A short finite
relation-name census resolved the service-table dispositions in one run, and
was removed from the final test.
The first native review found that checking assembled bytes did not prove stored
retention; requiring the existing object-reader port and a missing-object witness
is the smaller repair than adding another object adapter or transfer runner.
The canonical gate exposed strict TypeScript errors that focused PG execution
did not; running the existing public typecheck before a sensitive read would
have found them without another control or test harness.
