# M14 D32 — managed retained transfer

Status: development-preview task record; option C narrowing in progress. This record
is not a transfer qualification.

## Outcome, scope and authority

Capture one disposable managed installation with synthetic data, actual Auth
and Storage metadata interfaces, explicit issuer/subject mapping, and a finite
typed projection of retained obligations into canonical target stores. Full
managed audit and business history is not transferred. It remains in the
operator's source backup or snapshot, under the operator's access, retention
and erasure controls. Every admitted relation and row class has a disposition:
typed target state, history only with no D32-7 obligation, or refusal when the
typed path cannot carry required state. Unknown nonempty data and conflicting
mapped fields refuse publication. CD-M14-45 revises CD-M14-21(2)/25; the
earlier sidecar implementation and proof below remain historical evidence,
not current acceptance.

The active supervisor is the single writer in the assigned task worktree. The
maintainer's bounded programme grant covers local implementation and synthetic
proof, DCO, independent native review, submission and queue merge after required
gates. API/security-control changes require the stabilized maintainer read before
DCO. There is no release, hosted-resource, credential, deployment or production
authority. The [contribution rules](../../../CONTRIBUTING.md#deliver-a-change)
own delivery and [native review](../../../CONTRIBUTING.md#native-review-and-accountability).

This parcel owns business extraction/mapping, contributors and the
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

Use the pinned disposable managed stack and a fresh qualified PG16 target.
Compare projected typed target rows and outstanding obligations exactly.
Demonstrate that history-only rows create no target rows or history object, and
that every uncarried obligation refuses before restore. Preserve independent
target installation keys and the acquisition drain. Exercise unknown nonempty
relation, unsupported Storage metadata, unexpired idempotency windows and
non-reconciled provider ledgers,
and mapped-field-conflict refusals. Complete strict typecheck, lint, focused
real-PG proof, docs policy, redacted Gitleaks, maintainer read, fresh native
review and canonical verification before delivery. Local PG evidence does not
establish hosted-provider acceptance.

The smallest adequate route is to remove the full-row sidecar and retain only
the existing typed packet and refusal checks. No new transfer field, table,
manifest object, importer or dependency is needed.

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
business capture.

## Historical sidecar evidence and analysis (superseded by CD-M14-45)

The following observations document earlier candidates and reviewer decisions.
Their sidecar claims and tests are not current option C acceptance.

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
profile. `U` means the union of every populated retained typed link's resolved subjects;
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
| `communication_provider_events` | typed contact ID only; normalized email is not a link | Nonempty class R before publication. No email inference. | X | map refusal |
| `communication_delivery_events` | operator, command/recipient key | Parent command/operator tables outside profile; nonempty rows refuse. | X | capture refusal |
| `communication_email_deliveries` | client, contact, Auth, outbox, aggregate | U; missing populated link refuses. Other service parents require unknown nonempty tables and refuse. | H; mapped trigger stays in native `outbox_events` | W0, W1 |
| `outbox_events` | typed aggregate order/subscription only | U; missing populated aggregate refuses. Payload is minimised as a whole, so JSON IDs neither survive nor add sidecar subject tags; pending payload is checked in native projection. | H+N(`outbox_events`; pending); H terminal, except the CD-M14-78 checkout reminder key, carried without payload, error or metadata | W0, W2; CD-M14-43 JSON witness |
| `commerce_idempotency_keys` | none retained | Metadata JSON is minimised as a whole; its client ID is absent from the sidecar, so the structural receipt has no subject tag. | H (subject-free retained receipt) | W0; CD-M14-43 marker witness |
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
principal removes every linked private row and the synthetic email. This
source-level privacy change received its maintainer delta read before DCO.
Self-retro: the explicit no-receipt refusal guards against turning arbitrary
dangling Auth references into accepted erased-subject provenance.
Real managed sources lack `identity_privacy_erasures` in the pinned managed
schema. The 8D-2 read-only staging check owns counting dangling-Auth rows on
actual managed data alongside all-null settlement items and resolving their
disposition from actual source erasure evidence under its own read before
hosted acceptance; W4's temporary receipt relation does not qualify that leg.

Cycle-5 native prepare on `d0d48a05` refused because `origin/main` at
`9195f281` conflicts in `DATA_AND_MIGRATIONS.md`. A forced, uncommitted merge
has parents `d0d48a05` and `9195f281`. Its single manual resolution keeps
main's detailed native catch-up description and this parcel's separate finite
managed-profile paragraph. Excluding this task record, the old-base change
patch ID is `68ef72ee6c1607f8e4b909cee7984b0fe9ecbfcb` and the merged
change patch ID is `6bdddd77bba3607f694854f4334524b115b14f87`.
CD-M14-30 therefore requires a maintainer read before DCO of this merge.

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

## Retained field representation audit (CD-M14-37a)

Cycle 5's MRL-1 found B's email in an A audit row with no typed target ID.
CD-M14-37a narrows the prior candidate's minimisation: only fields that can
identify someone outside the row's typed subjects, personal-capable fields in
a row without a subject, and unknown JSON are replaced by the fixed marker.
The private fact records the field and one of these precise reasons. A zero-row
field is a no-op. The field disposition remains reversible if a later reviewed
typed binding proves its subject. The original source values stay transient for
native mapping; active obligations and domain erasure paths are unchanged.

The preceding subject-provenance matrix gives every typed UUID link and its
owner and erasure path. Those IDs remain verbatim as bound-own-subject fields;
unresolved non-null links still refuse. Numeric, boolean and temporal business
facts remain verbatim. The table below assigns each admitted finite-profile text/JSON
field once. B = bound-own-subject verbatim (the typed row subject removes its
sidecar row on erasure). S = subject-free verbatim (catalog, structural/status
code, order number or provider ID; no independent personal identity claim).
T = third-party-capable minimised (may name someone outside the typed subject
set). U = unbound-row minimised (personal-capable field without a typed row
subject). J = unknown-JSON minimised (arbitrary keys may name another person).
Known invoice, pricing/template, client and catalog JSON snapshots are B or S.
New JSON columns default to J; nonempty unknown relations still refuse.
No relation hashes a textual primary key in this cohort: Storage bucket IDs
remain their exact source keys because they are structural namespace IDs;
the present fixture shows no third-party personal content in that key.

| Admitted relation | B | S | T | U | J |
| --- | --- | --- | --- | --- | --- |
| auth.users | email | — | — | — | — |
| identity_privacy_erasures | contributor_versions, dispositions, retained_obligations | contract_version | — | — | — |
| customer_subject_lifecycle_events | — | from_stage, to_stage | — | — | — |
| admin_audit_events | entity_id only for a resolved `customer_read` client | action, source, entity_type, actor_kind, request_id, idempotency_key | entity_id for every other action, actor_email, target_email, old_value, new_value | — | — |
| clients | email, first_name, last_name, phone, external_ref, metadata, preferences | country, lifecycle_stage, acquisition_source, identity_kind | — | — | — |
| admin_users | email | role, membership_state, membership_provenance | membership_revocation_reason | — | — |
| subscriptions | size_constraint, payment_method_ref, starter_pack | currency, region_code, status, payment_method_kind, timezone, cancellation_source, offer_policy_version, promotion_engine_version, offer_policy_assignment_state | cancellation_reason | — | — |
| subscription_cycles | template_snapshot, pricing_snapshot, payment_method_ref | status, engine_idempotency_key, offer_policy_version, promotion_engine_version, offer_policy_assignment_state, renewal_row_error_key | failure_reason | — | — |
| subscription_events | — | event_type, idempotency_key, actor_kind | — | — | payload |
| subscription_lines | — | — | — | — | line_metadata |
| subscription_price_agreements | quote_line | agreement_kind, proration_policy, cycle_effect, currency, source_action, idempotency_key | — | — | — |
| commerce_orders | order_number, size_constraint, source_order_ref | status, currency, region_code, mode, source_kind | — | — | metadata |
| commerce_order_items | — | product_snapshot, mode_at_line, variant_snapshot | — | — | — |
| commerce_payments | — | provider, provider_payment_id, status, currency | — | — | metadata |
| commerce_payment_intents | — | target_kind, status, currency, provider_payment_id | failure_reason | — | metadata |
| commerce_payment_attempts | — | provider, provider_attempt_id, provider_session_id, idempotency_key, status, currency, next_action_kind, failure_class | failure_reason, request_payload, response_payload | — | metadata |
| commerce_payment_state_transitions | — | transition_kind, from_status, to_status, idempotency_key | reason, payload | — | — |
| commerce_payment_method_refs | consent_snapshot | provider_kind, method_kind, provider_customer_ref, provider_method_ref, provider_mandate_ref, status | raw_provider_payload | — | metadata |
| commerce_idempotency_keys | — | scope, idempotency_key, request_fingerprint, status | — | — | response_payload, metadata |
| payment_provider_settlement_batches | — | provider_kind, provider_batch_id, currency, status | — | — | evidence |
| payment_provider_settlement_items | — | provider_kind, provider_payment_id, currency, status | — | — | evidence |
| accounting_invoices | order_ref, invoice_ref, buyer_snapshot, order_snapshot, tax_snapshot, lines_snapshot | status, currency, provider_kind, provider_invoice_id, provider_invoice_number, ksef_number, ksef_status, correction_status, document_type, buyer_kind, ksef_requirement, policy_version, provider_pdf_ref, provider_xml_ref, document_kind, provider_payment_id, email_status, provider_upo_ref | blocked_reason | — | metadata |
| accounting_invoice_issue_outbox | — | provider_kind, status | — | — | last_error |
| communication_contacts | normalized_email, display_email, first_name, last_name | status | — | — | metadata |
| communication_contact_links | — | source_system, source_table | source_key | — | metadata |
| communication_permissions | — | channel, purpose, state, source | reason | — | source_ref, metadata |
| communication_email_deliveries | aggregate_id only for a resolved typed aggregate | purpose, template_slug, trigger_source, trigger_event, aggregate_type, dedupe_key, status, provider_kind, provider_message_id, last_error_code | aggregate_id otherwise, recipient_fingerprint | — | metadata |
| outbox_events | aggregate_id for a resolved typed aggregate | aggregate_type, event_type, idempotency_key, status | aggregate_id otherwise, payload, error, metadata | — | — |
| catalog_products | — | slug, status, name, description, metadata, ingredients, allergens, marketing_content | — | — | — |
| catalog_skus | — | sku, title, pet_type, status, metadata, format_code, unit_form_code, gtin, asset_ref | — | — | — |
| price_lists | — | name, region_code, currency, status | — | — | — |
| price_entries | — | mode, amount_kind | — | — | — |
| storage.buckets | — | id, name, allowed_mime_types, type | — | owner, owner_id and any other nonstructural text when populated | any other JSON |
| storage.objects | owner_id | bucket_id, version | name, path_tokens, owner | — | metadata, user_metadata and any other JSON |

W5 retains the real managed→PG16 MRL-1 witness: B's actual email is planted in
A's audit actor_email, target_email and old/new JSON with null target_admin_id.
Capture/readback retain markers and facts only; B redaction removes B's bound
history while A's active client, consent, settlement and duty rows remain exact.
A missing target_email fact refuses readback even after the capture digest is
recomputed. W6 compares the invoice buyer snapshot and the whole catalog
product row to the real managed source and serialized private-object readback
byte for byte. The catalog row and the invoice's own snapshot survive verbatim.

CD-M14-40 makes the field disposition a single source of truth for capture and
readback. Readback checks every present field against that same rule: a
populated T/U/J field requires the fixed marker and its exact reason fact;
B/S must retain the raw value. Null carries no personal value or fact. A
self-authored digest cannot authorize a missing marker. Audit `entity_id` is B
only when `action=customer_read` and its UUID resolved into the row's typed
subjects; otherwise it is T. The other conditional links are a contact link's
`source_id` (B only for `source_table=clients` and a resolved client UUID) and
delivery/outbox `aggregate_id` (B only for a recognized aggregate type and
resolved UUID); populated unsupported source links refuse during capture.
Unlisted free-form fields default to minimisation.
The real managed `invite` witness plants B's email in A's audit `entity_id`;
the sidecar keeps only the marker, and B redaction leaves no B email. A generic
mutation loop restores every non-null T/U/J field in turn, drops its fact and
recomputes the digest; readback refuses each mutation. Lesson: enforce the data
policy symmetrically at write and read; default-deny conditional fields.
CD-M14-40 focused proof on the pinned managed source and qualified PG16 target
passes 8/8, including the `invite`/B email and every populated minimised-field
mutation. Strict five-project typecheck and lint pass (zero errors, 33 existing
warnings). Self-retro: the earlier one-field fact test did not test the inverse
raw-value substitution; sharing one disposition function makes both directions
of that privacy rule observable without a new format or importer.
The accepted maintainer read added a test-only condition under CD-M14-39.
The existing fixture now asserts that audit action, contact-link source table
and delivery/outbox aggregate type are captured verbatim. For each, replacing
the discriminator with the fixed marker and any of the three fact reasons,
then recomputing the digest, must be refused by readback. This only adds
assertions within the existing real managed witness: no prior assertion was
removed or relaxed, and no fixture privilege, setup step or seam was added.
Native prepare refused carry-over after main moved. The forced DCO merge
`b321cfa791441903892c9d5d6729ce0d422dd89e` has parents `58f9d1d40bdbff4cf805ac9db9f0568473e3f416`
and `9b54219bb7fe4262e72c7581a478c9c381ef2ae7`, tree
`7a0c2f2c411ebc3571a5593a89a22e9ccd0bc526`. Its only conflict was the
compatible-data-transfer section: the managed paragraph and main's older-
snapshot paragraph were kept verbatim, in that order, with a blank separator;
stage-vs-main removed no main line. Under CD-M14-36, per-file stable patch IDs
for every non-doc path remained equal before and after: CONTRIBUTING
`095cdf33`, publication catalog `9426e400`, managed adapter `b647858f`,
connected capture `eb02aabb`, connected restore `9b73c961`, managed test
`e3ff71f7`, connected test `e4474696`. The server adapter README patch ID
also remained `5199d62e`; the docs patch ID differs only because the two
verbatim paragraphs share one hunk. No new claim or code/test resolution was
made in the merge.

The previous b88347f6 candidate over-minimised catalog content, invoice,
pricing/template snapshots, order numbers and operational codes. This correction
restores their exact source values in the sidecar. Self-retro: broad type-based
minimisation made privacy coverage simple but lost legitimate retained history;
the finite third-party-field list plus default for unknown JSON preserves both
the privacy control and own-subject evidence without email inference.
The corrected tree passes strict five-project typecheck, lint with zero errors
(33 existing warnings), and the pinned local managed→qualified PG16 focused
suite 8/8. The W6 invoice snapshot/catalog assertions and W5 privacy refusal
ran in that suite. This remains a local finite proof, not hosted qualification.

## CD-M14-42/43 canonical readback boundary

Readback admits only canonical retained artifacts: each derived subject, field
disposition, minimisation fact and row mapping must equal a recomputation from
the artifact's retained rows and typed links. Serialized derived metadata is
compared, not trusted. Changes to verbatim data content are an integrity
question anchored by the private object descriptor digest bound to the restore
manifest, rather than a privacy-policy exception. All admitted administrator
audit actions remain in the finite sidecar.

CD-M14-43 fixes the scope of sidecar provenance: subject tags derive only
from typed identifiers that remain verbatim in retained rows. An identifier
only inside minimised metadata or payload is absent from the sidecar, so that
row holds none of that subject's data and receives no tag. This narrows the
earlier CD-M14-35 JSON-derived union after CD-M14-37a. The native packet keeps
its own domain erasure and retention path. Mapped target-principal aliases are
not serialized in the sidecar; the item-7 identity mapping resolves a target
principal to a source identifier before sidecar redaction. No issuer or alias
is added to the artifact. If a co-owned parent is removed, sidecar redaction
also removes dependent history whose typed links would otherwise lose their
source row; native active obligations are untouched.

Field disposition is a pure function of relation, field and typed
discriminators, with a finite scalar-column list; a B/S raw value equal to the
fixed marker remains valid. Readback recomputes field facts, subject tags,
row target tables and relation dispositions, accepting only a consistent
source or mapped artifact. The pinned managed→PG16 suite checks every subject
tag mutation, populated T/U/J field, policy-changing discriminator mutation,
marker-equal catalog readback, source-only JSON links, target-principal-to-
source redaction and the earlier W6 exact invoice/catalog rows.
Strict five-project typecheck and lint pass (zero errors, 33 existing
warnings); the pinned disposable managed→qualified PG16 suite passes 8/8.
Self-retro: deriving tags after minimisation removed the raw-JSON provenance
gap; closing dependent sidecar rows during redaction kept readback independent
of already removed parents without changing native obligations.

CD-M14-44 recorded the coordinator's acceptance of the exact control tree
`c2bd75d573ef5bb7322337e1cfdbb95a988317a1` against base
`e13f78d432414999ca9acdbf341d556898370641`; the binary patch SHA-256
was `bb29a66d93b533a77c7258d9f5e4b65b1f7aedae3a0a1031f887ce5dda7df5ec`.
The accepted bytes were DCO-committed as `08d0335f10380c312e87325b2e220ea33b726f2e`.
The owner-delegated continuation permits one final native review cycle.

Before cycle 9, native prepare refused carry-over against main
`6700bcfe7cc63eca7d2bbbd466ebf1daa364ef88`. The forced main merge has
parents `2ab5d1236f9f875e720b6c05541556905645b4c5` and
`6700bcfe7cc63eca7d2bbbd466ebf1daa364ef88`; it merged without manual
resolution. Its pre-note staged tree was
`c9b1d501d22f62f45a607edabdf9f221eab030a6`. The stable patch ID of
this parcel excluding this task record is `8b411ea83efe90cad17abfd3c54b5c9dc1ff8be6`
both against the former `9b54219bb7fe4262e72c7581a478c9c381ef2ae7`
base and against new main. CD-M14-30 therefore permits DCO of the clean
two-parent merge without a new control read.

## CD-M14-45 option C disposition and current evidence

The full-row sidecar is removed from capture, export, manifest binding,
readback, redaction, restore admission, fixture and tests. Capture returns a
relation census; the full source rows live only in memory for immediate typed
projection. The operator retains its own managed-source backup or snapshot for
business and audit history, with its own access, retention and erasure controls.
The existing `retained-history` reason declares history-only rows; no new
disposition value or artifact format is introduced. Source rows in the archive
are not transferred by this parcel. The typed connected packet retains its
own ordinary restore admission.

| Source relation or row class | Disposition | Reason |
| --- | --- | --- |
| `auth.users`, `public.clients`, `public.admin_users` | a | item-7 principals and clients; credentials excluded |
| `public.admin_audit_events`: revoke / other action | a / b | typed membership audit / operator archive |
| `public.customer_subject_lifecycle_events`, `public.identity_privacy_erasures` | a | typed lifecycle and erasure receipts |
| `public.catalog_products`, `public.catalog_skus`, `public.price_lists`, `public.price_entries` | a | canonical catalog and prices |
| `public.subscriptions`, `public.subscription_lines`, `public.subscription_cycles`, `public.subscription_events` | a | canonical subscription graph |
| `public.subscription_price_agreements`: current / ended | a / b | frozen renewal price / superseded history |
| `public.commerce_payment_method_refs`: active / inactive | a / b | frozen authorization / terminal history |
| `public.commerce_orders`, `public.commerce_order_items` | a | canonical order state |
| `public.commerce_payments`, `public.commerce_payment_intents`, `public.commerce_payment_state_transitions`: carried / checked cancelled or expired | a / b | native settlement state / terminal unpaid source history |
| `public.commerce_payment_attempts`: checked terminal / other | b / c | failed transition typed; checked cancelled/expired attempt archived; unresolved attempt refused |
| `public.outbox_events`: pending checked / terminal / other | a / b / c | pending native duty / archive, except the CD-M14-78 checkout reminder key / unsupported duty |
| `public.accounting_invoice_issue_outbox`, `public.accounting_invoices` | c | superseded by CD-M14-78: any invoice state refuses |
| `public.communication_permissions` | a | native recipient consent |
| `public.communication_contacts`, `public.communication_contact_links` | b | typed consent uses them; source rows stay archived |
| `public.communication_email_deliveries`: terminal failed / active or other | b / c | terminal history / uncarried send state |
| `public.commerce_idempotency_keys`: completed and expired / other | b / c | expired source receipt is archive-only; an outstanding window refuses |
| `public.payment_provider_settlement_batches`: reconciled / other; `public.payment_provider_settlement_items`: matched / other | b / c | settled money is typed; other provider states refuse |
| `public.payment_external_refs`: settled matching / checked terminal unpaid / other | b / b / c | settled provider ID is typed on the intent; source reference and payload stay archived; unsafe state refuses |
| `public.commerce_payment_reconciliation_runs`, `public.accounting_invoice_operations`, `public.accounting_invoice_correction_outbox`, `public.accounting_invoice_delivery_outbox` | c | nonempty rows fail existing finite check |
| `public.communication_delivery_events`, `public.communication_provider_events`, `public.communication_permission_events`, `public.subscription_dunning_cases`, `public.subscription_dunning_notifications` | c | nonempty rows fail existing finite check |
| `storage.buckets`, `storage.objects` | c | current limitation: nonempty managed Storage awaits the separate typed object path |
| Auth sessions/tokens and service installation records | b: excluded | target login/service owns new installation state |
| Any other nonempty relation | c | unknown table refusal; empty unknown is `unsupported-empty` |

The matrix is row-class sensitive for mixed relations: a pending outbox is
typed while a terminal one is history only. A revoke audit is typed while
other admin audit actions remain in the source archive. A delivery tied to
pending send state refuses; terminal failed delivery is archive only.
Reconciled/matched provider rows can remain in the source archive after settled
money is projected. The
existing owner-link resolver still rejects unresolved populated links and
cross-order settlement conflicts before publication. No credential row is
selected. Empty unknown relations are explicitly `unsupported-empty`.

The earlier full-row sidecar and its privacy reviews established a limit rather
than a transferable result. CD-M14-45 narrows the acceptance to typed target
state and explicit refusal. The snapshot and source archive remain operator
responsibilities; this parcel makes no hosted, complete migration or release
claim. Self-retro: removing the full-row archive avoids repeatedly expanding
field-level privacy policy for unbounded managed free text while preserving
the finite typed obligation checks.

Option C base proof before C+state on the pinned CLI 2.122.0 disposable stack and a fresh
qualified PG16 target: the focused managed suite passes 4/4. It compares the
complete emitted typed packet to target rows, checks replay and the independent
installation key, shows archive-only audit and terminal outbox rows absent
from the packet, and exercises unknown nonempty, uncarried Storage, completed
idempotency, provider ledger, active delivery, missing owner-link and mapped
money/identity conflict refusals. The disposable CLI seeds a nonempty service
feature-flags relation; the positive fixture clears that local service seed so
the finite admitted cohort can run. The unknown-nonempty refusal remains and
is exercised with a separate source relation. Strict all-project typecheck,
lint (zero errors), focused ast-grep, documentation policy with navigation
update, diff whitespace check and redacted Gitleaks pass. The PG log is in
the private task scratch directory. This proof does not establish a complete
managed installation or hosted transfer.

## CD-M14-49 C+state amendment

The coordinator read accepted the option C base tree
`4ff881236feaa077e5ab49ff997e28839d69b61c` and independently computed
its diff SHA-256 `82e07cf149d470ff96b8c6348e80526cfe5b48a152d45e4aada0148187f0596e`
against `3db2a277`. Those identities are evidence of the accepted base, not a
statement about the current amendment. Reconciled settlement batches and
matched items use the existing `retained-history` disposition; settled money
remains in typed target rows. Completed idempotency receipts use that same
archive disposition only when `expires_at` is no later than the source
transaction's capture time. The operator waits until outstanding idempotency
windows expire, then captures. Other statuses and unexpired windows refuse.
No sidecar or new disposition value is introduced.

Nonempty managed Storage remains a current refusal pending the separate 8E
typed managed-object projection through the existing object path. It is not a
final disposition for the connected managed journey. `payment_external_refs`
is named in the active profile and is absent from `uncarried`, but the current
business mapper has no corresponding target-row projection and omits it from
`mappedRelations`. A populated row therefore reaches `unsupported_table` for
`public.payment_external_refs`. Its disposition has not been changed in this
amendment; the bounded re-read packet reports the exact mismatch.

The C+state focused managed→qualified PG16 suite passes 5/5 on the pinned
CLI 2.122.0 source. Reconciled/matched settlement rows and an expired completed
idempotency receipt are declared `retained-history` and absent from the typed
packet; settled intent rows remain exact in the target. Unexpired completed
and expired but unfinished idempotency keys refuse; a non-reconciled batch
refuses; nonempty managed Storage still refuses. A populated
`payment_external_refs` fixture reaches the existing active-profile admission
check and refuses `unsupported_table`, precisely because the mapper has neither
a projected target row nor this relation in `mappedRelations`. That requested
positive witness is therefore not claimed. The separate 8E object path and
the payment-reference gap remain outside this bounded amendment.
Strict all-project typecheck, lint (zero errors), documentation policy with
navigation update, ast-grep, whitespace check and a redacted scan of the
tracked candidate tree pass. Canonical verification, native review and delivery
are pending the C+state re-read. Self-retro: a capture-time SQL spelling error
was found by the real managed fixture and fixed before the final 5/5 run; the
state rule stayed within the existing census and disposition values.

## CD-M14-51 external-reference projection precondition and schema blocker

The coordinator re-read accepted the C+state base tree
`a8c151e77a0c3fbd12d8d3c5d3495bfe35eca204` and independently computed
its diff SHA-256 `122d9f530334fc3dbd61eddadb5d43304fe46d7bd2c0f71c4470ed6a4cff840f`
against the accepted option C tree. These computed identities are the CD-M14-51
coordinator read evidence (2026-10-30).
The bounded typed projection remains conditional on the reader precondition
and a target representation, without a new table, migration or format.

The platform TS/JS read of `payment_external_refs` selects only `payment_id`,
`provider_kind`, `provider_payment_id` and `created_at`; no platform reader of
this table consumes `raw_payload`. The managed baseline creates the table with
`raw_payload DEFAULT '{}'::jsonb`. The qualified portable migration set has no
`payment_external_refs` table, and the finite connected capture/restore profile
has no such table. Its existing `commerce_settlement_intents.external_ref` is
one opaque text handle and cannot carry the six requested typed fields or a
target `raw_payload` default. The accepted `unsupported_table` refusal for a
populated managed reference therefore remains; no typed projection, source
change or positive PG witness is claimed. The coordinator must choose a
representable target contract or retain the refusal before this addition can
be implemented. The earlier 5/5 managed-to-PG16 proof still covers the accepted
C+state base, including the populated-reference refusal. Self-retro: checking
the target migration inventory before changing the mapper exposed the schema
mismatch without adding an unapproved storage surface.

## CD-M14-52 payment-reference state rule

The coordinator accepted the CD-M14-51 schema blocker and chose the existing
disposition channel instead of a target table. A reference to a carried
`succeeded` intent is archive-only only when its provider payment ID equals
the ID retained in the target settlement intent, and its kind agrees with the
linked payment provider. A reference for a terminal failed, unpaid payment is
also archive-only; provider IDs already recorded on the intent or payment must
agree with the reference. More than one reference for the same payment, a
missing payment or intent, an in-flight state, mismatched ID or kind refuses.
`provider_session_id` and `raw_payload` remain in the operator's source archive.
The current money mapper admits `failed` as its terminal unpaid state; managed
`cancelled` and `expired` intents still refuse at the existing target-money
check and are not newly admitted by this state rule. The operator quiesces
in-flight checkouts and waits for outstanding idempotency windows to expire
before capture. This supersedes the populated-reference refusal described in
the earlier CD-M14-49 and CD-M14-51 evidence, without changing that historical
evidence.

The pinned CLI 2.122.0 managed→qualified PG16 suite passes 5/5 after this
state rule. Its fixture carries a matching settled provider ID in the target
`commerce_settlement_intents.external_ref`, while settled and terminal failed
unpaid source reference rows, session IDs and raw payload markers are absent
from the exact target packet and row census. The same fixture refuses an
in-flight payment reference, mismatched and extra provider IDs, conflicting
provider kind and a reference on a payment without an intent. Earlier settlement,
idempotency, Storage, unknown-table and mapped-field refusal witnesses pass.
Strict all-project typecheck, lint (zero errors), documentation policy with
navigation update, ast-grep and redacted tracked-tree scan pass. No new
target table or payload carrier was introduced. Self-retro: the state rule
reuses the source census and existing typed settlement reference, avoiding a
new target schema for source-only provider history.

## CD-M14-55 checked terminal unpaid checkout extension

The coordinator accepted the CD-M14-52 base tree
`0564ae155decf7219e843310dce8d7051c2f9f28` and independently computed
its diff SHA-256 `cd27e1c2fb43c8efb0f771e89b0db819656f2012d105dd7ce68f0e75da4fae8c`
against `a8c151e7`. These identities are CD-M14-55 read evidence.

The checked terminal unpaid rule covers failed, cancelled and expired managed
intents. It requires one intent for the payment, one terminal attempt and
transition in the same state,
no active attempt, a pending unpaid order, no succeeded payment, and no linked
settlement item or invoice. Provider reference kind and any recorded provider
ID must still agree. Unsafe state refuses. Failed intents and transitions
remain carried as typed native failed settlement rows, as in the accepted
base; their source attempts and provider reference rows remain archive-only.
Checked cancelled and expired intent, payment, attempt, transition and
provider-reference rows remain in the operator's source archive; their pending
order and lines keep the existing native order projection. A mixed source
relation's census disposition names its active requirement; the row-class
rule excludes only the checked terminal rows from the typed packet. The
earlier CD-M14-52 statement that cancelled and expired always refuse is
superseded. No new target format, relation or disposition value is introduced.

The pinned disposable managed-source → qualified PG16 suite passes 6/6 with
expired and cancelled abandoned checkouts. Their typed pending orders remain,
while their intent, payment, attempt, transition and provider-reference IDs
are absent from the target packet and readback. A cancelled checkout with a
succeeded payment, active attempt or linked settlement item refuses; all prior
settled-reference, money, idempotency, Storage, unknown-table and conflict
witnesses pass. Strict all-project typecheck, lint (zero errors), docs policy
with navigation update, ast-grep and redacted tracked-tree scan pass. The
terminal rule shares one source-graph check between census and mapping, avoiding
an additional target representation. The final run follows the one-intent
conflict guard added after the first 6/6 run.

The coordinator's CD-M14-58 read accepted this candidate. The independently
computed tree was `8c5383fd4b1adaade4002163170bde0385317a51`, and
`git diff --binary 0564ae15 8c5383fd` had SHA-256
`cc608fb2ae6d2a5dc789ce2effa37f12cb2fce19dc3c79c31b3d5d659d57d015`.
The read accepted the deliberate distinction between typed failed intents and
archive-only checked cancelled or expired intents, as well as the aggregate
`requires-active-mapping` census for mixed source relations.

After native prepare refused clean-merge carry-over, the parcel merged
`origin/main` at `591a8ec46d3cd74f7047b2a44ea4a50649158690` into
`1b774c3e9ad444139aa56ca53705162ebfd33358`. Git's automatic merge had
no conflicts or manually resolved hunks. Its staged pre-note tree was
`ebef0f952cc4d65304fa6d6cfd753d3055630218`; the stable parcel patch ID,
excluding this task record, was
`8013f30cf60b56fc2589f89335bc8832e0e10da7` against both the old base
and the new main. This is the CD-M14-30 mechanical carry-over case; the
integrated tree requires fresh full native review.
Main's new generated agent-context check also required refreshing two line-span
metadata values after this parcel's `DATA_AND_MIGRATIONS.md` paragraph moved
the unchanged additive-migration excerpt. The excerpt bytes and SHA-256 did
not change; this is a docs-only generated-metadata correction.

## Native review cycle 10 payment-link repair

The first integrated review returned one PASS and one material card,
`MRL-CARRIED-PAYMENT-LINK`. Independent foreign keys in the managed baseline
allow an attempt linked to one intent to name another payment. The prior
carried failed/succeeded projection checked attempt status but could then emit
typed settlement state while omitting the contradictory source attempt. The
repair shares a finite attempt/transition link check across carried and checked
terminal states: payment identity, amount, currency, provider and optional
transition attempt ID must agree with the intent and payment. Any mismatch
in a carried intent refuses as `target_conflict` before restore; checked
archive-only terminal state continues through its existing refusal path. A pinned managed-source witness
mutates each field and both carried statuses, then restores the fixture. This
is a safety tightening within the accepted typed projection, with no new
archive class, target representation or public support claim. The earlier
sidecar privacy card closes because the sidecar was removed. A fresh
maintainer read is required before this source repair is DCO-committed.

The first managed PG run exposed a refusal-order difference: a source-only
provider reference refused before the carried intent's mapped conflict check.
The same shared link check now runs as a narrow preflight for carried intents,
ahead of relation-disposition refusal. The final pinned CLI 2.122.0 managed
source → qualified PG16 run passes 7/7, including mismatched payment, amount,
currency, provider and transition-attempt links in failed and succeeded cases.
Strict all-project typecheck, lint (zero errors), docs policy, ast-grep and
redacted Gitleaks scans of the staged tree and all refs pass. No public
capability wording changed. Self-retro: the first test failure showed that
early archive-state refusal can mask a more precise typed conflict; placing
the shared link check before that refusal preserved the existing error contract.

CD-M14-64 accepted the cycle-10 repair with independently recomputed tree
`2f0ca108a70a480b52ff7782da9eeb3870b5a4eb` and SHA-256
`b1546944ed4132ab2e5b02e7285fbb60830e71dd5d30dce5acab9fa51e32dde7`
for `git diff --binary 1af97f95 2f0ca108`. Both computed identities matched.
The exact accepted tree was DCO-committed as
`8011cd8d58e10962cdc437d317b8d036db4cb0e7`; fresh full native review follows.

Cycle-11 prepare refused carry-over after main's pgTAP workflow change. The
forced merge joins `5b0843e5f3e6543e16f63ce4c96da78fa9ac74fc` and
`8ae51d2923bcc13bb4a9a12da646bbeb8edeb684` without conflicts or manual
resolution. Its pre-note tree is `cd75fcd8da02d1b12a6a94d3fe83be06be1a2c3d`.
The stable parcel patch ID excluding this record is
`2c62af7c2a621620a7b48e78e4a7ac929b53b09c` against both old and new main.
This meets CD-M14-30; full native review covers the integrated candidate.

## Cycle-11 integration blocker

The integrated strict typecheck fails with one TS2305 diagnostic. Main's
stock-PostgreSQL pgTAP change removed `deriveCliImages` from
`scripts/ci-image-mirror.mjs` and its declaration, and `prePullCliImages` from
`scripts/public-ci-pgtap.mjs`; this parcel's real managed fixture imports both.
The required root-test shards include this fixture and no longer install the
Supabase CLI. Replacing the imports alone would therefore leave a second,
runtime prerequisite gap in hosted tests. No new source or test repair was
made, and no cycle-11 reviewer was launched while this mandatory gate fails.

The smallest proposed recovery is a test-owned direct launch through pinned
CLI 2.122.0, using the existing identity-conformance launch pattern, plus a
checksum-verified CLI prerequisite for the required root-test shards. That
workflow hook needs its owner; canonical stock-PG17 pgTAP can remain separate.
An alternative is an owner-approved existing managed fixture only if it proves
the same real Auth and Storage metadata interfaces. Neither option permits
skipping the managed witness or substituting the stock compatibility adapter
for its real source. The accepted payment-link repair remains committed and
its open native card awaits fresh review after integration is repaired.
Self-retro: main's removal of a shared runner helper exposed the fixture's
cross-module setup dependency; repair its explicit prerequisite and ownership
rather than hiding the failure with a test exclusion.

CD-M14-69 resolves this diagnosis by keeping the required mapper/refusal suite
on main's managed-compatibility helper and adding an explicit opt-in real
managed-source witness. The same assertions must run on both sources; any
unreproducible managed-only behavior stays in the real witness. This is adapter
migration and parity work before cycle 11, with no workflow change.
The prerequisite main merge joins `056b760097feb44c32aaf7cbf056835fad49b909`
and `78f340db40ee6abcdaa97c7f01ccd2a857403b8f` without conflict or manual
resolution. Pre-note tree: `e371546e5bf699befd05209cdedeada8a985cb0d`.
The stable parcel patch ID excluding this record is
`2c62af7c2a621620a7b48e78e4a7ac929b53b09c` on both bases (CD-M14-30).

## CD-M14-69 adapter migration and real-source parity

The required suite now starts `runManagedCompatPostgres` (stock PG17 plus the
shared adapter); only the opt-in runner supplies a port for its owned real
managed stack. The business fixture and all seven test bodies remain
byte-identical from `const sourceId` onward, SHA-256
`cda6e53fe52d20eac6ef317d257e31d04c4aa3936813ce0d46236199e2b6c39c`.
No assertion moved or was removed. Auth's existing four captured columns already
match the needed shapes. The shared adapter adds only Storage buckets
`id/name/public` and objects `id/bucket_id/name/metadata/owner_id`, with the
managed types, nullability, UUID/boolean defaults, primary keys and bucket FK
copied from a live pinned schema observation. It adds no service behavior,
trigger, production migration, grant or workflow change.

`node tests/postgres/runM14ManagedSourceWitness.mjs` verifies and extracts the
reviewed CLI archive, starts one owned real stack, runs these same tests once,
and uses the existing owned-stack cleanup on completion, failure and signals.
It refuses missing platform pins, checksum/version failures and non-passing
tests. The supported archive pins inherited from the installer are macOS arm64
asset `668849778`, SHA-256
`fe87a5f9781d5423dbd5ebba2d5a6e1a541d01754d14941c574952e5695eaab0`,
and Linux x64 asset `668850237`, SHA-256
`59ed066847b98d7461c60e9109d40cab6b9756177ce06ebb05b51338519f5136`,
both CLI `2.122.0`. The 2026-10-30 real run passed 7/7 with binary SHA-256
`89838b26049c0672f9609aaf46455c89a46d351f852e313c0c5ae6b3abcbdf9d`,
observed source image
`sha256:c141fd17ac6a76c4323e90b3aee8ff1a23d2e89e547c2b963cfadc309c079cc2`,
and unchanged managed baseline SHA-256
`fb4de62d4ccf30dca83075b41ea2769ddf74165ecd47d21875790ed5f397ccbe`.

Both sources' Vitest JSON reports have identical ordered names and `passed`
statuses for typed obligations, identity/idempotency conflicts, carried payment
links, settlement/delivery state, provider references, unsafe cancelled state,
and unknown/Storage refusal. The earlier real run remains recorded as 7/7;
the new real JSON report supplies the per-name comparison. Required discovery
includes the suite and excludes the opt-in script by the existing filename
patterns. The script documents the owned stack boundary for the later Storage
API, GoTrue and authenticated object-read proof; it does not implement that leg.

Before adding the runner, the tracked tree measured 6,705 files and 50,929,268
bytes. One public script was registered in the existing path and command
catalogues; no cap changed. Strict all-project typecheck, lint (zero errors),
policy (zero unanswered), ast-grep, the adapter 7/7 and real-source 7/7 pass.
Self-retro: retaining one assertion body avoided a second proof implementation;
schema reconnaissance (1,803 seconds waiting for the shared slot) limited the
adapter extension to observed columns. This root-cause migration consumes no
review cycle. Cycle 11 follows only after its required read and DCO; under the
owner's CD-M14-65 limit, a cycle-11 FAIL ends this Codex delivery without repair.

## CD-M14-72 shared-consumer condition

The CD-M14-69/72 read accepted tree
`4c7295eae56b4c4606258d44038e64b22719edce` and independently recomputed
SHA-256 `b3e0e71d6861090d4f2925795fd98dfb515513ba274516b528a5bc68fd06c6cc`
for `git diff --binary 9861f894 4c7295ea`; both computed identities matched.
Its remaining condition measured the adapter consumers and stock pgTAP on that
unchanged tree and detached main `78f340db40ee6abcdaa97c7f01ccd2a857403b8f`.
The baseline used its own locked install and was removed after measurement.

All nine existing consumer files (including the runner's synthetic adapter
unit tests and the indirect risk fixture consumer) have identical ordered
test names/statuses: 217 passed, zero failed or skipped on both trees.
Stock pgTAP is identical per file and assertion: 226 files, 5,199 assertions,
zero failures, directives or missing plans on both trees. The sole full-set
difference is the new `connectedManagedRetained.test.ts` consumer, absent from
main and passing all seven tests on the candidate. Under the read's explicit
any-difference condition, this addition is returned for read before DCO.
No source repair or cycle-11 review was started. Self-retro: measuring the
common consumers and reporting the added suite separately distinguishes a
suite-set addition from a shared-adapter regression without assuming a baseline.

The next native preparation required integration with main `1e8d8f3a`.
The merge parents are `7c909b0bc453f855fb9c96175249c7da5b926686`
and `1e8d8f3a27163c69ac14e6ff0c9744b2985fef39`; the resolved tree before
this evidence note is `9f35ea222c6e4a2836df8f649047a1bdcb4c9e14`.
The only conflict was the CONTRIBUTING proof-command prose: main's hosted-issuer
paragraph and the managed-source paragraph were both retained verbatim, with
main's paragraph remaining adjacent to its recipe antecedent. The resolved file
removes no main line. All non-doc per-file changes remain identical; the combined
stable patch ID excluding this record and CONTRIBUTING is
`8cabae1ce3987b458a9dfe76f1a2086d0c92d071` against both bases.
This is the approved prose-only verbatim union; no implementation claim changed.

## CD-M14-65/75 regroup and closed money-column matrix

Native cycle 11 failed with one mechanism reported independently by both fresh
reviewers (`MRL-CARRIED-PROVIDER-ID`, `MRL-CARRIED-PROVIDER-ID-CONFLICT`); both
closed `MRL-CARRIED-PAYMENT-LINK`. Under the owner's CD-M14-65 decision this
parcel continues without the previous Codex author. Implementation and supervisor
contexts in this task: the earlier Codex supervisor and, from this point, the
Claude Opus 5.5 lead session. Later reviewers are fresh Claude Opus 5.5 subagents.

Root-cause class: a redundant money fact in the four-relation source graph is
projected onto a smaller typed target, and a contradiction between redundant copies
can vanish because nothing compares them. Patching one field per review round does
not converge, so CD-M14-75 replaces it with this closed matrix. Every column of the
four relations has one disposition: **C** carried to the typed target, **E** compared
(a mismatch refuses before restore), or **A** archive-only, with the reason its loss
cannot change money truth in the target. A later material finding must show a wrong
row, a missed column or a mechanism outside the matrix.

| Column | Disposition | Rule or reason |
| --- | --- | --- |
| `commerce_payments.id`, `order_id` | E | Payment joins the intent; order must match. |
| `commerce_payments.provider` | C, E | Target `channel_key`; equals the attempt provider. |
| `commerce_payments.provider_payment_id` | E (new) | If both payment and intent copies are populated they must be equal. A settled intent must have its own copy, which the target carries. An empty intent copy on an unpaid intent contradicts nothing: no money moved. |
| `commerce_payments.status` | E | Pairs with the intent status on every admitted path. |
| `commerce_payments.amount_cents` | E | Equals the intent amount on every path, including terminal archive. |
| `commerce_payments.currency` | E | Equals the intent currency on every path, including terminal archive. |
| `commerce_payments.metadata` | A | Free-form provider context; target money state is derived from typed columns only. |
| `commerce_payments.created_at`, `updated_at` | A | Bookkeeping; the target carries the intent timestamps. |
| `commerce_payment_intents.id`, `order_id`, `payment_id` | C, E | Identity and links. |
| `commerce_payment_intents.target_kind`, `subscription_id`, `subscription_cycle_id` | E | Only `one_time_order` with empty subscription links is admitted. |
| `commerce_payment_intents.status` | C, E | Mapped to the target state; other states refuse. |
| `commerce_payment_intents.amount_cents`, `currency` | C, E | Target amount and currency; equal to the order and payment. |
| `commerce_payment_intents.provider_payment_id` | C | Target `external_ref`; required on a settled intent. |
| `commerce_payment_intents.active_attempt_id` | E (new) | Empty, or the intent's own attempt. An intent without attempts must leave it empty. |
| `commerce_payment_intents.failure_reason`, `created_at`, `updated_at` | C | Carried. `updated_at` is when the row was processed, so it does not set the settled time. |
| `commerce_payment_intents.metadata` | A | Free-form; no target money state reads it. |
| `commerce_payment_attempts.id`, `payment_intent_id`, `payment_id` | E | The attempt must belong to this intent and payment. |
| `commerce_payment_attempts.provider`, `amount_cents`, `currency`, `status` | E | Equal to the payment or intent, or to the terminal state. |
| `commerce_payment_attempts.provider_attempt_id`, `provider_session_id`, `next_action_kind` | A | Provider session detail of a finished attempt; the target has no attempt row and settlement identity is the intent's. |
| `commerce_payment_attempts.idempotency_key` | A | Source retry key of a finished attempt; the target derives its own transition key. |
| `commerce_payment_attempts.failure_reason`, `failure_class` | A | Attempt diagnostics; the carried failure state and reason are the intent's. |
| `commerce_payment_attempts.request_payload`, `response_payload`, `metadata` | A | Free-form provider traffic; no target money state reads it. |
| `commerce_payment_attempts.created_at`, `updated_at` | A | Bookkeeping of a finished attempt. |
| `commerce_payment_state_transitions.id`, `payment_intent_id`, `payment_attempt_id` | C, E | Identity and links. |
| `commerce_payment_state_transitions.to_status` | C, E | Must match the terminal intent state. |
| `commerce_payment_state_transitions.occurred_at` | C | Carried, and sets the target's `settled_at` and `paid_at`. |
| `commerce_payment_state_transitions.from_status` | A | The target rail is created-to-terminal; the source path does not change the terminal money state. |
| `commerce_payment_state_transitions.transition_kind`, `reason` | A | Descriptive path detail; the terminal state is compared and carried. |
| `commerce_payment_state_transitions.provider_event_id` | A | Provider event history; the settled identity is carried through the intent. |
| `commerce_payment_state_transitions.idempotency_key` | A | Replaced by a target-derived key bound to the source row. |
| `commerce_payment_state_transitions.payload`, `created_at` | A | Free-form or bookkeeping; no target money state reads them. |

Repair: the existing shared `attemptLinks` rule gains payment-to-intent amount and
currency, populated provider-identity equality and own-attempt checks. The carried
`created` guard gains the same identity and empty-attempt checks. No value, format,
table, migration, dependency or public claim changes. A read-only source census
showed unpaid intents with an empty provider identity whose payment has one, so the
check compares populated copies only; those shapes must stay admissible. Attempt and
transition cardinality on real sources is outside this repair and belongs to the
real-store transfer item (8H).

Evidence on this repair: the required suite on the managed-compatibility source and
the opt-in real pinned CLI 2.122.0 source (binary SHA-256
`89838b26049c0672f9609aaf46455c89a46d351f852e313c0c5ae6b3abcbdf9d`) both pass the
same seven ordered tests. Witnesses cover a contradictory provider identity with and
without a reference row, an empty payment copy, an empty unpaid intent copy, a
foreign active attempt on settled, failed and created intents, and contradictory
identity, amount and currency on a cancelled checkout. Strict typecheck, lint (0
errors, 33 existing warnings), structural checks and documentation policy pass.
Self-retro: checking the first wording against a read-only source count exposed a
rule that would have refused real unpaid intents; a closed matrix plus one count
replaced another review round spent on a single field.

The CD-M14-77 read covered tree `7daee22b09ff4ddc043d0d326e550e65fb5db281` and
SHA-256 `fe19117e178136a7c1192355cc9a402e9ba0b16e5a84e4f06a43512d7522698d` for
`git diff --binary 3f4e802e 7daee22b`; both computed identities matched. It was
DCO-committed exactly as `7f18855f`.

## CD-M14-78 obligation table and invoice narrowing

Native cycle 12 closed both provider-identity cards and confirmed the column matrix,
then raised non-privacy findings. Their common cause: the option C cut removed most of
the earlier witnesses, and earlier cycles concentrated on privacy. CD-M14-78 resolves
them in one bundle and extends the closed-list method from columns to obligations.

Decision (option R): the invoice-duty projection is removed. It was reachable only in a
synthetic state, because real issue requests also write `accounting_invoice_operations`,
which refuses. Any managed invoice row now refuses, including issued invoices, so a
source with invoice rows cannot transfer yet. Other repairs: carried settled transitions receive
`invoicing_cutover` rows, so restored history opens no new document duty; a method in
`pending_verification` refuses; a checked cancelled or expired checkout must also agree
with its order and name no subscription; a matched settlement item must agree with the
settled intent's currency and the payment's provider.

Every relation in the capture's finite lists has one row below. Tests are in
`tests/postgres/connectedManagedRetained.test.ts`, by title, unless named otherwise. A
later material finding must show a wrong row or a missing relation.

| Relation | Disposition | Proving test |
| --- | --- | --- |
| `auth.users` | Metadata; typed identity | projects typed managed obligations |
| `auth.identities`, `auth.sessions`, `auth.refresh_tokens`, `auth.flow_state`, `auth.one_time_tokens`, `auth.mfa_factors`, `auth.mfa_challenges`, `auth.audit_log_entries` | Credential-excluded; counted, never selected | projects typed managed obligations (`auth.identities`); the rest share the same list and branch |
| Service migration tables and `_realtime.*` in the installation list | Service installation history; counted | Same list and branch as above; `_realtime.feature_flags` handled by the real-source runner |
| `public.clients`, `public.admin_users` | Typed | projects typed managed obligations; refuses conflicting mapped fields |
| `public.identity_privacy_erasures`, `public.customer_subject_lifecycle_events` | Typed through the item 7 mapping | `tests/postgres/connectedStoreTransfer.test.ts` managed identity cases |
| `public.admin_audit_events` | Revoke typed through item 7; other actions archive-only | projects typed managed obligations; `connectedStoreTransfer.test.ts` |
| `public.catalog_products`, `catalog_skus`, `price_lists`, `price_entries` | Typed | projects typed managed obligations |
| `public.subscriptions`, `subscription_lines`, `subscription_cycles`, `subscription_events` | Typed; other row classes refuse | projects typed managed obligations (exact rows for subscriptions and lines, count for the others); refuses every row class with no typed path |
| `public.subscription_price_agreements` | Current typed; ended archive-only; contradiction refuses | projects typed managed obligations; keeps an ended price agreement; refuses every row class with no typed path |
| `public.commerce_payment_method_refs` | Active typed; ended archive-only; verification or contradiction refuses | projects typed managed obligations (exact renewal term and term line rows); refuses a method in verification; refuses every row class with no typed path |
| `public.commerce_orders`, `commerce_order_items` | Typed; other row classes refuse | projects typed managed obligations (exact rows); refuses every row class with no typed path |
| `public.commerce_payments`, `commerce_payment_intents`, `commerce_payment_attempts`, `commerce_payment_state_transitions` | Column matrix above | projects typed managed obligations (exact settlement intent and transition rows); refuses a carried payment attempt; both cancelled-checkout tests |
| `public.outbox_events` | Pending checked typed; terminal checkout reminder key typed without payload, error or metadata; other terminal archive-only; other refuses | projects typed managed obligations; keeps a paid order's checkout reminder; refuses every row class with no typed path |
| `public.communication_permissions`, `communication_contacts`, `communication_contact_links` | Consent typed; contact rows archive-only; other refuses | projects typed managed obligations (exact consent row); refuses every row class with no typed path |
| `public.communication_email_deliveries` | Terminal failed archive-only; active or mismatched refuses | refuses non-reconciled settlement and active delivery; refuses every row class with no typed path |
| `public.commerce_idempotency_keys` | Completed and expired archive-only; other refuses | projects typed managed obligations; refuses conflicting mapped fields |
| `public.payment_provider_settlement_batches`, `payment_provider_settlement_items` | Reconciled and matched archive-only; other or contradictory refuses | projects typed managed obligations; refuses non-reconciled settlement; refuses settlement rows that contradict; refuses every row class with no typed path |
| `public.payment_external_refs` | Matching settled or checked unpaid archive-only; other refuses | refuses in-flight, mismatched, extra and unmapped provider reference |
| `public.accounting_invoices`, `accounting_invoice_issue_outbox`, `accounting_invoice_operations`, `accounting_invoice_correction_outbox`, `accounting_invoice_delivery_outbox` | Refuses | refuses every invoice state and every uncarried obligation relation |
| `public.commerce_payment_reconciliation_runs`, `communication_delivery_events`, `communication_provider_events`, `communication_permission_events`, `subscription_dunning_cases`, `subscription_dunning_notifications` | Refuses | refuses every invoice state and every uncarried obligation relation |
| `storage.buckets`, `storage.objects` | Refuses when nonempty; current limitation | refuses unknown nonempty relations and uncarried Storage metadata |
| Any other relation | Refuses when nonempty; empty is `unsupported-empty` | refuses unknown nonempty relations and uncarried Storage metadata |

Carried settled history opening new work: `invoicing_due_sources` is empty after restore
(projects typed managed obligations). A static read of the platform's other due readers,
with no run against a restored store, found three that reach carried managed rows:

| Due reader | Carried rows | Result | Proof |
| --- | --- | --- | --- |
| Automatic renewal (`subscription_stock_wait_normal_due`) | Active subscription at or past `next_cycle_at` | Static admission `blocked` refuses before stock or payment, and a run records a terminal refusal for that schedule. Renewals of carried subscriptions stay unsupported until a later lifecycle carry, so the documented rule is to keep the renewal job off for them | projects typed managed obligations (due row and blocked reason); `tests/postgres/subscriptionComposition.test.ts` `static` scenario (refusal, no provider call) |
| Checkout reminder (`commerce_enqueue_checkout_recovery_reminders`) | Unpaid order with a failed intent, 1 to 24 hours old | A terminal source reminder keeps only its key, so no second reminder. An order the source never reminded gets its first one, as it would have on the source. Every source reminder also writes a `commerce_checkout_recovery_tokens` row, an unknown relation that refuses today, so the carried key applies once that relation is purged or admitted | projects typed managed obligations (with and without the key); keeps a paid order's checkout reminder |
| Renewal reminder (`dunning_lifecycle_renewal_reminder_scan`, `_enqueue`) | Active subscription | Writes only `subscription_reminder_ledger`, and no TypeScript caller exists, so nothing is sent. A recorded finding | Static read |

Carried pending paid-fulfilment and subscription-welcome rows continue their own work by
design. Two read models report carried paid orders as missing their paid event
(`order_paid_outbox_missing`); they write nothing and no native route composes them, so
this is a recorded finding only. The remaining readers need relations outside the managed
lists (shipments, pause windows, activations, retry obligations, draft receipts, wait
cases, promotion claims), so no carried row can qualify. Native restore is outside this
item.

## CD-M14-83 regroup, refusal table and source-only columns

Regroup after native cycles 12 and 13, which both left a material obstacle. The remaining
gap was unexecuted refusal proof, owned by the obligation table above and the
sufficient-evidence rule. The cause: that table closes the list per relation, but the
guards live per row class, so each review found the next guard with no test. Adding one
case per card would have repeated that. The next step was one coverage run over
`connectedManagedRetained.ts`, listing every refusal line no test reaches, then one table
of rows in `refuses every row class with no typed path`. Expected result: only the lines
listed below stay unreached. Lesson: reviewers each finding the next refusal with no
test → measure unreached refusal lines once and test them together.

Native cycle 14 closed that gap's refusal classes and left a smaller one. Open material
cards went from nine to three to two: a table row that did not isolate the settlement
status clause, and a source-only column whose stated comparison did not exist. The method
stays the same, because this cycle added new information rather than repeating a gap.
Each stated disposition is now checked against the code it names.

Native cycle 15 closed those and raised one new card with a new cause: the renewal term
values had no executed proof, because the comparison after restore reads the packet the
mapper itself produced. Relations and row classes were already measured, and field values
were not. So the third measured dimension is exact expected rows from fixtures whose values
differ, plus one mutation run over the mapper's hand-built fields, with each survivor given
an assertion or a reason. The run is a measurement, not a target:

it covered 58 hand-built target fields, each broken in turn against the positive test. The
first pass detected 51. The seven survivors were equal fixture values or unread fields:
created and updated times of renewal terms, term lines and settlement intents; the settled
time; the transition time; the consent times; and an empty order metadata. The fixture now
separates them and the exact rows read them, and a rerun detected all seven. It found no
mapping bug. Columns that `project` copies by name share one code path and were not
mutated field by field.

Each table row changes the source inside the transaction the capture reads, then rolls
back. The table is criteria for this item, not a target to extend.

Refusal lines still unreached, each with its reason:

| Refusal | Why no test reaches it |
| --- | --- |
| Relation count not an integer | The SQL returns an integer |
| Relation with no primary key; projected row missing a target column | Needs source schema drift; the baseline hash is pinned |
| Two completed erasures for one client | `identity_privacy_erasures` is absent from the pinned baseline; the identity mapping suite owns those cases |
| Capture with no held rows (`managedIdentityEvidence`, `mapManagedRetainedBusiness`) | The capture validation before it already proves this |
| Cycle number not a nonnegative integer | The source `NOT NULL` and `CHECK` forbid it |
| Product `allergens` not an array | The source column is `text[] NOT NULL` |
| Two consents for one recipient and purpose | The source unique constraints on email and on contact, channel and purpose forbid it |
| Target table missing or already populated | The identity mapping refuses a non-fresh target first; the target inventory is pinned |
| Projected keys differ from target columns; record cast returns no row | Needs target schema drift |
| A cast failure outside SQLSTATE classes 22 and 23 rethrows | Needs the database to fail during the cast; the run still stops |
| A JSON number with no source text | Node 24, the only supported engine, always supplies it |
| `quoted` on a name over 63 bytes or holding NUL | PostgreSQL names cannot be that long or hold NUL |
| Settlement item owner lookup (`byOrder(...) ?? fail`) | Orders and items sort before settlement, so their owner check refuses first with `invalid_input` |
| Final `return false` of `archiveState` | Its callers pass only relations with an earlier branch |
| Owner lookup with a dangling auth user or contact (`byClient`, `byContact`) | Source foreign keys forbid both; the erasure arm is the row above |

The capture also sets `row_security = off`, so a login that row security would filter
fails with 42501 rather than reading empty relations. `refuses a source login that row
security would silently filter` shows the same login reading no rows with no error
without the setting. The real-source runner captures with the provider `postgres` role's
rights and records its `rolsuper` and `rolbypassrls`; the required adapter suite uses a
superuser.

Source-only columns of the carried relations, measured against the target:

| Relation | Column | Disposition |
| --- | --- | --- |
| `subscriptions` | `currency`, `region_code` | Mapped; resolved into the price list |
| | `pet_id`, `shipping_address_id`, `billing_address_id`, `starter_pack`, `is_test_fixture` | Refuses when set |
| | `payment_method_ref`, `payment_method_kind` | Compared with the method; refuses otherwise |
| | `size_constraint` | Descriptor; lines carry the goods |
| | `timezone` | No renewal reader |
| | `cancellation_source` | Source history; only `status` decides whether a subscription carries |
| | `offer_policy_version`, `promotion_engine_version`, `offer_policy_assignment_state` | Acquisition only |
| `subscription_lines` | `qty` | Mapped |
| | `template_version` | Compared with the subscription and the agreement; refuses otherwise |
| | `line_metadata` | Quote line price and quantity compared with the agreement and line; refuses otherwise. Other metadata is source history |
| `subscription_cycles` | `cycle_number` | Sets the next cycle number |
| | `retry_attempt`, `next_retry_at`, `provider_attempt_sequence`, `renewal_row_error_count`, `renewal_quarantined_until` | Refuses when set |
| | `paid_at`, `order_id`, `payment_id`, `payment_method_ref`, `failure_reason`, `template_version`, `template_snapshot`, `pricing_snapshot`, `engine_idempotency_key`, `renewal_row_error_key`, `offer_policy_version`, `promotion_engine_version`, `offer_policy_assignment_state` | Source history; renewal prices come from the agreement |
| `commerce_orders` | `currency`, `total_cents` | Mapped |
| | `subtotal_cents` | Equals the total once the others are zero |
| | `discount_cents`, `shipping_cents`, `shipping_discount_cents`, `mode`, `subscription_id`, `shipping_address_id`, `pet_id`, `recovery_root_order_id`, `recreated_from_order_id` | Refuses when set |
| | `tax_cents`, `region_code`, `checkout_session_id`, `order_number`, `size_constraint` | Source history; `tax_cents` is included in the total |
| `commerce_order_items` | `unit_price_cents`, `total_cents`, `allocation_ordinal` | Mapped |
| | `discount_allocated_cents`, `effective_total_cents` | Compared; refuses otherwise |
| | `product_snapshot`, `variant_snapshot`, `mode_at_line`, `size_constraint_contribution`, `vat_rate_bps`, `effective_net_cents` | Source history; `sku_id` carries the goods and a null refuses |
| `subscription_events` | `cycle_id`, `updated_at`, `actor_kind` | Source history; the event's subscription and key carry |
| `catalog_products` | `allergens` | Refuses when set: the target catalogue has no allergen column, so carrying the product would serve an empty safety list. A later parcel carries it |
| | `metadata` | Source history; it stays in the operator's archive |
| `catalog_skus` | `pet_type`, `metadata`, `format_code`, `unit_form_code`, `gtin`, `kcal_per_unit`, `feeding_grams_per_unit`, `requires_pet_profile` | Product content; it stays in the operator's archive, and a later parcel maps it |
| `price_lists`, `price_entries`, `outbox_events` | None | Measured: every source column has a target column |
| `clients`, `admin_users` | Measured source-only columns | Owned by the item 7 identity mapping and its suite |

## CD-M14-92 acceptance checklist

Native cycle 16 closed the renewal-value card and raised one new card: numbers a double
cannot hold were rounded silently. The owner's regroup found the cause in the process.
Nothing listed what must be true before the first review, and advice was not triaged
against acceptance. The transfer acceptance names "exact numeric/time/ID values" and an
active subscription among its fixture, so both are required here. This list is that
statement. Each row names its proof, and a row with no proof says so.

The bundle after triage also changes these: `settled_at` and `paid_at` come from the
transition; discarded paid-fulfilment or welcome work refuses; a consent time needs an
explicit offset and at most six fractional digits; a contact email not in native normal
form refuses; a missing carried relation refuses; a product with allergens refuses; target
normalisation runs at UTC.

| Dimension | What must be true | Proof | State |
| --- | --- | --- | --- |
| Relations | Every relation in the capture's finite lists has one disposition; a nonempty unknown relation refuses | Obligation table in the CD-M14-78 section; `refuses unknown nonempty relations and uncarried Storage metadata` | Proved |
| Row classes | Every row class of a carried relation is typed, archive-only or refused | `refuses every row class with no typed path`; the unreached table in the CD-M14-83 section, measured by coverage. This reaches each refusal; it does not enumerate every admitted combination of status, links and counts | Proved for each refusal branch |
| Hand-built fields | Each target field built by hand holds the right source value | Exact expected rows in `projects typed managed obligations`; one mutation run over 58 fields, reported in the CD-M14-83 section | Proved |
| Copied fields: types | A same-name column has the same type on both sides | Measured over the nine copied relations: none differs | Measured once; no standing test |
| Copied fields: required columns | A column required only on the target refuses when the source holds null | Measured three: `edit_window_hours`, `scheduled_at`, `idempotency_key`, each with a refusal row | Proved |
| Copied fields: numeric | A carried value keeps its exact number, or the row refuses | Measured: no carried column is `numeric` or `bigint`; the two `numeric` columns on carried relations are source-only. A number whose exact decimal differs from the parsed double refuses on every carried relation. Three refusal rows; a largest-safe integer and a 16-digit decimal survive | Proved |
| Copied fields: JSON | Nested values, empty containers and JSON null inside a value survive | PostgreSQL comparison of copied columns on both sides, in `projects typed managed obligations` | Proved |
| Copied fields: JSON null as the whole value | A jsonb column holding the JSON value `null` | `to_jsonb` cannot tell it from SQL NULL, so the target holds SQL NULL, or restore refuses on a required column. No platform writer was found that produces it | Recorded limit |
| Copied fields: JSON number scale | A JSON number's value survives; its trailing zeros do not | `1.50` arrives as `1.5`; jsonb equality holds and no carried column is `numeric` | Recorded limit |
| Copied fields: time | Instants keep microseconds | Measured: every copied time is `timestamptz` on both sides. The capture and target normalisation set UTC, with a zoned-target assertion. The same comparison reads copied times as PostgreSQL text, and hand-built times have their own text comparison. Price-list eligibility and receipt expiry are decided by PostgreSQL inside the held snapshot, with cases on each side of a microsecond boundary. The one remaining `Date.parse` only rejects an unreadable consent time | Proved |
| Copied fields: text | Unicode, quotes, backslashes and arrays survive | The same comparison, with a `text[]` holding an empty string and a NULL element | Proved |
| Copied fields: bytea | None carried | Measured: no `bytea` on the carried relations | Proved |
| Copied fields: null against empty | SQL NULL and an empty string stay distinct | The same comparison, with an empty `description` and a NULL `asset_ref` | Proved |
| Capture authority | A login row security would filter refuses; credentials are never selected | `refuses a source login that row security would silently filter`; the real runner captures under the provider `postgres` role and records its attributes. One filtered role and one provider role, not a full grant matrix | Proved for those two |
| Snapshot consistency | The capture reads one read-only repeatable-read snapshot and refuses a changed census | `refuses an invalid capture boundary and a changed capture`. The digest covers the census, not the held rows, and the capture is trusted in-process input: this does not defend against a caller that changes rows or recomputes the digest | Proved here for that boundary; catch-up belongs to 8D |
| Target due readers | Restored rows open no new work beyond what the due-reader table states | Executed: `invoicing_due_sources` empty, renewal admission blocked, reminder key. The other readers in that table are a static read | Partly proved |
| Target read paths | A restored store reads correctly through the platform's own views | Not run against a restored store: customer preference view, public catalogue, SKU envelope, OMS list. This item proves storage, not those readers | Not proved |
| Privacy | Credentials, raw provider payloads and source-only rows stay out of the packet; erased identities do not return | Marker assertions in `projects typed managed obligations`; identity cases in `tests/postgres/connectedStoreTransfer.test.ts`. Carried order metadata and outbox and event payloads are copied as the source holds them, so source erasure must be complete first | Proved for named markers; free-form JSON is a recorded limit |
| Docs claims | Each claim about this transfer matches the code | `oss:published-tree --policy` proves ownership only; reviewers read the meaning | Review only |
| Source schema drift | A source that has moved past the pinned baseline does not transfer wrongly | At runtime a missing carried relation, a removed or renamed copied column and an unknown nonempty relation refuse. Nothing detects an added or retyped column, and the baseline and schema hashes are recorded only by the real runner | Documented limit |

The documented limit for source schema drift: the capture is qualified only for a source on
the pinned managed baseline. After a later source migration, requalify the transfer before
relying on it. Hosted managed sources are not qualified by this item.

Native cycle 17 closed the number cards and raised two more, both millisecond truncation in a time decision: the chosen price list and a receipt's expiry. One repair covers both (CD-M14-101): PostgreSQL makes both decisions inside the held snapshot, and the millisecond capture time is gone.

Decisions after one pre-mortem and one triage (CD-M14-94). A finding needs a reachable
precondition: a platform writer, a documented operator path, or a value class the acceptance
text names. A row only the schema allows is advice unless it moves money. Renewal's charge
instrument stays in the later lifecycle carry as a documented refusal, because addresses are
not carried either. Two intents on one order and a created intent with a payment-only provider
identity go to the later real-store transfer item (8H). The paid-order drain rule is in the docs. The census stays relation-level; per-table counts are in the
journey report.

Clauses of the same acceptance owned elsewhere: interruption, catch-up and source writes
during transfer, the second leg and refusal before takeover belong to 8D; objects and ACLs
belong to 8B and 8E; admission rules seen only on a real store belong to the later real-store transfer item (8H); hosted
receipts belong to item 10. "No missing history" is met through the operator's source
archive under CD-M14-45, not through target rows.
