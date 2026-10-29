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

Cycle 3 on merged tree `c61c9c9cca9eb4d3fa47206c8904f55ae7b1626b`
received one full PASS and one material FAIL. The managed settlement item has
independent intent, payment and nullable invoice foreign keys. Previously,
privacy ownership used the first available link, so an item for one customer's
payment could retain another customer's invoice reference after erasure. The
source capture now resolves every non-null link and refuses conflicting orders
before the item or batch can enter the retained sidecar. An unresolved non-null
link also refuses. A real managed Postgres witness assigns the item to a second
customer's invoice and expects refusal, then checks a same-order invoice and
intent-only and payment-only links remain capturable. With all three links null,
the pre-repair result remains `invalid_input` on the settlement batch: it has
an item with no subject owners, so the full retained capture cannot establish
privacy coverage. This all-null refusal is a known boundary owned by 8D-2:
that parcel will check the real managed source read-only and, if such items
exist, resolve their disposition under its own read (for example, retained
business history without a personal subject); if none exist, it will record
that observation and keep the refusal. The initial repair required both
intent and payment and was not accepted because all three links are nullable
in the managed baseline. The bounded correction was accepted in the
2026-10-29 settlement-privacy maintainer read and DCO committed at `967c4de`
with tree `78df4d1957bb56891fac077ebcbd049fcb784ca6`. CD-M14-34 authorizes
one native-review `continue` after that read and DCO. This remains a privacy
coverage correction within parcel 8A's existing outcome and does not extend
the hosted qualification boundary.

## Finite retained-row subject provenance audit (CD-M14-35)

This matrix was checked against `subjectOwners`, the frozen managed baseline's
nullable FK columns, and the finite `mapManagedRetainedBusiness` publication
profile. `U` means the union of every populated link's resolved subjects;
unresolved non-null links refuse `target_conflict` before publication. `R`
means the mapping already refuses the specified nonempty class or shape, so
no private sidecar can be published from it. `S` is the accepted settlement
same-order integrity rule. W0 is the original managed→PG16/erasure witness and
settlement-link test; W1 is the delivery client/contact/Auth readback witness;
W2 is the finite cross-subject source/readback witness; W3 is the mapped
consent/client managed→PG16 witness. Union and whole-row removal apply only to
private sidecar history. `H` means sidecar whole-row removal; `N(table)` means
the named native table keeps its own domain erasure/redaction or retained-duty
path; `H+N` means both, with the active row kept. `X` means no admitted row.
Native identity rows use `identityPersonalDataContributor`; subscription rows
use `subscriptionsPrivacyContributor`'s obligation veto/retention; commerce,
outbox, consent and invoicing rows remain in their named native stores under
their domain-owned retention/privacy path. This classification does not claim
that a sidecar redaction executes any native erasure operation. Redaction
witnesses serialize the sidecar and verify readback removes a cross-linked row.

| Retained relation / branch | Populated subject links | Resolution and conflict | Erasure path | Witness |
| --- | --- | --- | --- | --- |
| `clients` | own ID, `auth_user_id`, `marketing_contact_id` | U via Auth and contact→linked clients; absent FK refuses. Customer/contact coexistence is barred by source shape. | H+N(`clients`; identity contributor) | W0, W2 marketing lead, W3 |
| `admin_users` | own ID, `membership_revoked_by` | U via admin rows; missing revoker refuses. | H+N(`platform_human_principals`/`platform_human_memberships`; identity contributor) | W2 |
| `admin_audit_events` | actor, target admin, `customer_read.entity_id` | U via admin/client rows; missing populated link refuses. Other entity types are not customer links in the finite action set. | H+N(`platform_human_membership_audit_events`; revoke only); H otherwise | W0, W2 |
| `identity_privacy_erasures` | actor, erased principal, client | Existing union of pseudonymous keys; absent pinned baseline, but the finite profile recognizes a receipt-shaped forward source. | H+N(`identity_privacy_erasures`; immutable native receipt) when mapped | W4 capture |
| `subscriptions` | client; optional pet and addresses | Client owner; pet/address links must be null; nonempty parents refuse. | H+N(`subscriptions`/`subscription_renewal_terms`; subscription contributor) | W0; guards |
| `commerce_orders` | client; optional subscription/cycle/recovery/recreated order | Client owner; optional links must be null or R. Pet/address/session parents refuse. | H+N(`commerce_orders`; commerce retained obligation) | W0; guards |
| `commerce_payment_intents` | order, payment, active attempt; optional subscription/cycle | U for order/payment/attempt; missing link refuses. Subscription/cycle must be null (R). | H+N(`commerce_settlement_intents`; commerce settlement path) | W0, W2 |
| `commerce_payment_attempts` | intent, payment | U; missing populated link refuses. | H; terminal effect is in native `commerce_settlement_intents`/transitions | W0, W2 |
| `commerce_payment_state_transitions` | intent, attempt | U; missing populated link refuses. Provider event parent outside profile. | H+N(`commerce_settlement_transitions`; settlement path) | W0, W2 |
| `commerce_payment_method_refs` | client, subscription | U; missing populated link refuses. Active mismatch refuses; terminal rows history only. | H+N(`subscription_renewal_terms`; active); H terminal | W0, W2 |
| `commerce_payment_reconciliation_runs` | intent, attempt | Nonempty class R before publication. | X | map refusal |
| `subscription_cycles` | subscription, order, payment | U; missing populated link refuses. | H+N(`subscription_cycles`; subscription contributor) | W0, W2 |
| `subscription_events` | subscription, cycle | U; missing populated link refuses. | H+N(`subscription_events`; subscription contributor) | W0, W2 |
| `subscription_price_agreements` | subscription, line, event | U; missing populated link refuses; current and terminal rows covered. | H+N(`subscription_lines`/`subscription_renewal_term_lines`; current); H terminal | W0, W2 |
| `subscription_dunning_cases` / `subscription_dunning_notifications` | subscription, cycle, order, intent, client/case/recipient | Nonempty classes R; recipient refs are not inferred as clients. | X | map refusal |
| `accounting_invoices` | order, correction parent invoice | Order owner; correction rows cannot enter supported issue-outbox cohort (R). | H+N(`invoicing_fact_revisions`; invoicing duty path) | W0; guards |
| `communication_contacts` / `communication_contact_links` | contact→all client links and marketing leads; link's own source client | U for every resolved client link; non-client/unresolved source links refuse. | H | W0, W1, W2 |
| `communication_permissions` / `communication_permission_events` | contact→all linked clients | U via contact links; permission maps, nonempty events R. | H+N(`communication_recipient_consents`; consent state) / X for events | W0, W3; profile refusal |
| `communication_provider_events` | contact, normalized email | Nonempty class R before publication. | X | map refusal |
| `communication_delivery_events` | operator, command/recipient key | Parent command/operator tables outside profile; nonempty rows refuse. | X | capture refusal |
| `communication_email_deliveries` | client, contact, Auth, outbox, aggregate | U; missing populated link refuses. Other service parents require unknown nonempty tables and refuse. | H; mapped trigger stays in native `outbox_events` | W0, W1 |
| `outbox_events` | aggregate order/subscription; typed payload client/order/subscription keys | U; missing populated known link refuses. Pending payload checked in projection. | H+N(`outbox_events`; pending); H terminal | W0, W2 |
| `payment_provider_settlement_items` / `payment_provider_settlement_batches` | intent, payment, invoice; batch's items | S: populated item links must resolve to same order; cross-order is a money-integrity anomaly. Batch unions item owners; all-null item refuses for 8D-2. | H; native settlement/intents and invoicing duties remain | W0 |

W3 adds a second managed client B to A's contact, then maps and restores the
real pinned managed source into PG16. The consent and A's client history name B;
redacting B removes both source-keyed sidecar rows on serialized readback.
Target `communication_recipient_consents` still has the exact suppressed
fingerprint/purpose/state, and target A `clients` still has the exact ID/email.
`redactManagedRetainedHistory` changes only the sidecar object; it never edits
the canonical packet or runs native identity, commerce or consent erasure.
Self-retro: the first provenance packet left the native erasure boundary implicit;
the named path column and restored-row witness make that boundary reviewable.

W4 uses the pinned managed baseline with a temporary direct-format erasure
receipt relation in the disposable fixture; it does not claim that baseline
ships a managed erasure operation. Deleting a synthetic Auth user sets its
`clients.auth_user_id` to NULL (`clients_auth_user_id_fkey ON DELETE SET NULL`),
while `communication_email_deliveries.auth_user_id` retains the deleted UUID
because that column has no Auth FK. A completed receipt binds the erased
principal to the client, whose synthetic profile uses the reserved erased
address. The finite owner resolver now uses that exact receipt
to retain the erased principal in client, delivery and customer-read audit
provenance; the same real fixture first proves a dangling delivery Auth ID
without the receipt refuses `target_conflict`. The real
managed readback confirms no Auth row is recreated, and redacting the erased
principal removes every linked private row and the synthetic email. This is
a source-level privacy change and needs its own maintainer delta read before DCO.
Self-retro: the explicit no-receipt refusal guards against turning arbitrary
dangling Auth references into accepted erased-subject provenance.

Rows with one direct subject parent (`commerce_payments`, order items, invoice
outboxes, subscription lines, payment external refs) use
that parent; subject-free catalog/pricing and Storage buckets are explicit
exceptions. Nonempty unknown service/credential-bearing relations keep their
existing refusal/exclusion dispositions. This audit adds no general graph
importer or sidecar schema.

Regroup lesson: repeated first-populated owner selection across retained
relations → audit all finite subject links once and use direct per-relation
union/refusal with cross-subject readback proof. The prior settlement-only
repair closed its row's card but left the same pattern in delivery history;
the matrix and shared finite resolver cover the published cohort together.
