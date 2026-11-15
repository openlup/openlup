# Changelog

Notable changes to this public-source workspace package are recorded here.
“Unreleased” means no npm version carries the change yet; immutable OpenLup
source previews may already ship some changes, and their release notes say
which. Declaration snapshots track candidate drift, not a stable API or
SemVer promise. This file keeps the current release and the two previous ones;
earlier releases are recorded verbatim in `packages/platform/CHANGELOG-HISTORY.md`
in the source repository.

## [Unreleased]

## [0.43.0]

- Publishable on the npm `latest` dist-tag as `0.43.0`, from tag
  `openlup-platform-v0.43.0`.

- Fix concurrent ecommerce-event projection and personal-data erasure by taking the receipts relation lock before subject row locks through a restricted preparation function. Recipient erasure, export, retained source facts and replay fences keep their existing behavior.

Migration: install the complete selected native chain through `20261119200000_communication_event_prepare_erasure.sql` before using the updated privacy contributor.

- Add optional neutral fulfillment capability declarations, readiness refusals and native execution probes. Existing adapter operation flags and outputs remain unchanged; no unsupported native lifecycle operation becomes implemented.
- Add selected-intake dispatch ACK composition, snapshot-only stock synchronization and compatible receipt/observation aliases.

Migration: install the complete selected SQL catalogue through `20261120100000_fulfillment_intake_channel.sql` before using the updated native dispatch store. Polling hosts pass the selected intake declaration to native ACK composition; omitted intake remains push and existing accepted receipts retain their channel.

Migration: omitted descriptor fields preserve existing behavior. Provider-owned reservations and provider-managed consumption now have explicit readiness refusals. Explicit `stockMovements: false` selects snapshots with a separate movement refusal and preserves the movement watermark; absent retains movement reads. Pass the declaration to the stock worker.

Migration: `transportSelection: "provider"` admits nullable native parcel carrier/service; saved customer preferences still require strings. PDF remains the sole supported label document format. Independent split, standalone pickup/locker, native label create/void and remote cancel requests remain named limits.

Migration: optional `receiptKey` must equal required legacy `labelKey` byte-for-byte. Neutral observation status aliases `code`/`detailCode` coexist with required legacy `primary`/`subStatus`; neutral shipment event kinds coexist with legacy order event kinds. Preserve event keys, occurrence identity and historical acceptance JSON; no backfill or receipt rewrite is supplied.

- Add native order delivery-contact resolution, latest-shipment contact comparison and fenced operator correction with exact retained replay, creation capture, privacy export/erasure and finite native transfer. Operator creation validates the resolved contact, with pre-parcel correction taking precedence over the original destination.
- Add source-specific delivery selection with injected normalized options and canonical point evidence. Provider-selected checkout/preferences remain constrained by their existing contracts.

Migration: install the complete selected catalogue through `20261121100000_order_delivery_contact_correction.sql`. Native response schemas accept older inputs without `deliveryContact` and normalize its absence to null. Select the native response schemas and authorize the OMS correction handler. Submit both the PostgreSQL digest and revision; register the updated parcel-contact privacy contributor for private order contacts and retained correction responses. Historical baselines stay null; no backfill or provider activation is performed.

- Compose replacement preparation and dispatch under the new parcel identity, retaining optional frozen line lot/expiry fields and adapter-owned sequence numbering.
- Bind retained and in-flight dispatch replay to parcel sequence and optional line lot/expiry, preserving omitted versus explicit-null metadata selection.
- Add the explicit native customer alignment row reader for the existing current-schedule mapper. Reduced list/detail retain their existing projection; overview requires host data.
- Process changed non-null arrival timestamps while preserving subscription-first locking, all-unsuperseded-arrivals admission and the monotonic once-only schedule clamp. No automatic replacement confirmation is added.

Migration: install the complete selected SQL catalogue through `20261120130000_fulfillment_alignment_arrival_chronology.sql`. Bind `createPostgresCustomerAlignmentRowsReader` from `@openlup/platform/fulfillment/native` to `readFulfillmentDelay`; authorize IDs and supply current schedules. Optional `parcelSequenceNo` is additive; adapters own any provider-facing format and existing callers default to the original parcel. Bind the selected adapter's order-identity codec to intake. Historical status alone supplies no arrival, reservation generation or inferred customer case. There is no backfill or hosted qualification.

- Add explicit native commerce creation and operator-attempt recording with cancellation composition. Local creation checks settled money, recorded order mode, contact, holds, cycle and reservations before committing a parcel; it makes no provider call.
- Fence selected native submission on succeeded same-provider operator attempts and full per-line held/committed reservation coverage. Admit initial `subscription` orders; retain the paid-cycle check only for recorded `subscription_cycle`. Replacement submission is supplied by the later native alignment composition; accepted-proof recovery remains available.
- Add selected native dispatch candidates and final admission, actual-command shadow fingerprint forwarding, draft promotion/refresh and durable neutral failed/uncertain diagnostics. Operator audit attempts remain separate from command proof attempts.

Migration: install the complete selected catalogue through `20261120110000_fulfillment_dispatch_outcomes.sql` before using these factories or the updated native dispatch store. Select `nativeDispatch: { portKey, providerRef }` or retain the existing host reader/list composition. Supply the adapter's pure `shadowCommandFingerprint` to preserve actual command identity across shadow and stage.

Migration: same-parcel/provider mapped-attempt replay returns the first attempt across draft refresh and promotion. Submitted references retain their mode and command identity. Existing dispatch outcomes stay NULL; no historical contacts, reservations, modes or acceptance proofs are reconstructed. Connected native transfers include the new private operator-attempt table.

Migration: the reference adapter preserves unreadable rejection bodies as network uncertainty, including HTTP 400. Readable definite rejections remain failed. Neither failed nor uncertain outcomes authorize automatic resubmission. No hosted provider qualification is implied.

Compose native provider ingress and leased reconciliation over the existing workers, recorded dispatch commitments, exact parcel reservations, shipment commands and job ledger. Retain first webhook envelopes, current polling tracking snapshots, closed occurrence/recovery facts and scoped holds without rewriting parcel status. Provider identity resolves first; all recorded fallback associations must agree on one order before ACK, and every match checks the adapter's outbound order identity. Delivered observations with no references retain the documented manual arrival path.

Migration: install the complete catalogue through `20261120120000_fulfillment_provider_intake.sql` before binding `createPostgresFulfillmentProviderIntake`. Adapters selecting native intake must add closed `intake` facts and retain original occurrence bytes in optional `intake.occurredAt`; missing original chronology uses receipt time. Supply the adapter-owned optional `orderIdentity` mapping when outbound merchant identity differs from the recorded order number; existing generic callers and unbound operator fallbacks remain compatible. The optional durable observation readback is additive. Historical rows are not inferred or backfilled.

Migration: typed consumers can now handle three native dispatch refusals that were already returned.

- Remove provider trace columns from the source status facade and generated JSON; adapter-owned dictionaries retain provider status translation.

Migration: shared status-map JSON carries only the neutral core map. Use adapter-owned dictionaries for provider trace requirements. Prefer canonical `packed`; historical display aliases remain accepted without changed customer-step results.

- Add the experimental `./fulfillment/testing` offline certification entry and scripted transport. Full qualification validates copied data with closed schemas and credits only independently compared invocations in one ledger. Evidence includes mode, derived profile, capability digest and port-less declarations. Host locking, durable deduplication, cancellation races, replacement and alignment remain real-PostgreSQL evidence.

- Keep executed refusal probes for non-PDF formats, label create/void, provider-side cancel, independent split, provider-owned reservations, snapshot-only movements and pickup-point/locker execution. The closed port-less list contains only courier pickup: unsupported records `probe: "no_port"`; supported fails with `capability_not_certifiable`. Callable unsupported operations need refusal witnesses. No provider behavior or SQL changes.

- Bind captured-adapter qualification to the deeply frozen original dispatch port and methods. Freeze scripted transport method slots. Derive refusal fixtures and the unchanged refusal type from the internal shared `FULFILLMENT_REFUSAL_REASONS` tuple.

- Apply readback capability and observation checks to paged rows; bind scenario aliases to their operation's existing capability guard. Snapshot and validate closed scripted outcomes once at enqueue. Refuse shared-memory buffers and views with `validation:shared_memory`.

- Check unmapped poll evidence, observation replays, provider references and diagnostics through the shared projections before qualification credit. Snapshot asynchronous outcomes once; copy synchronous throws separately.

Migration: the unreleased testing subject's label-void expectations require an exclusive `canProceed` branch; successful cleanup cannot carry a refusal. Production label-port types and baseline callers remain unchanged.

Migration: scripted fake outcomes now contain snapshot-compatible data; construct `Response` objects from copied body/status data at the injected fetch boundary. Unknown outcome fields refuse before invocation; descriptor and buffer checks mitigate accidental accessor/proxy and shared-memory misuse. Paging evidence is recorded under `readback`.

Migration: captured adapters and their nested capabilities/ports are immutable; compose a separate adapter for custom behavior. The unreleased testing subject requires an expected dispatch after prepared results and forbids dispatch/replay keys after refused preparation. Existing baseline subject types remain accepted. Baseline host-storage label reads remain available when adapter label reading is unsupported; full mode still requires an explicit refusal. The internal shared `FULFILLMENT_REFUSAL_REASONS` tuple preserves every existing reason.

Migration: existing imports and one-argument calls retain baseline mode with shared data validation. Full mode requires independent expectations for every slot and mutually exclusive sync `{ input, expected }` / `{ input, throws }` roles. Refused preparations omit dispatch/replay keys; scenario indices are distinct integers in range. Supply read-only `fake.calls` handles backed by the private log, not caller arrays. Replace snapshot worker callbacks with `snapshotOnly: true`; the runner executes the real worker with its own isolated provider/store. Profile is derived: only the captured adapter factory brand permits dispatch-only qualification, which earns no other capability certification. Supported operations need contract-positive success and typed failure; unsupported cannot stand in for the failure of a supported operation. Missing expectations and malformed branches fail validation; descriptor-based snapshots mitigate accidental proxy, accessor and hidden-property misuse. Executable methods are captured once and invoked through a captured intrinsic. Return native promises without constructor/species overrides; native-promise checks and captured `then` handling mitigate accidental redirection. Policy callbacks and optional host-store methods use the same capture boundary; their returned and thrown data is copied before use. Inputs and outcomes are copied before use and compared by kind and deep strict equality. The kit certifies adapter behaviour against honestly built data fixtures and rejects missing, malformed or contradictory fixtures and contract-violating adapter results. Deliberate accessor, proxy or overridden-intrinsic manipulation to defeat the caller's own certification is outside the threat model. These mitigations reduce accidental misuse; they are not an attestation.

Migration: existing `./fulfillment` and `./fulfillment/testing` imports, signatures and behavior stay unchanged. Shared conformance support now belongs to fulfillment internals; the testing entry re-exports the same scenario types and scripted transport.

- Replace native provider identity predicates with immutable declarative profiles, retaining existing evidence, refusal codes, validation order and replay behavior. Reference adapters carry typed profile declarations; SQL/TypeScript parity and a declaration-only third-provider witness exercise both policy variants.
- Add optional host-selected execution flow labels to the portable payment rail; omission preserves the existing composition. The second reference provider's portable composition remains unsupported.

Migration: apply the complete selected catalogue through `20261121090000_payment_provider_profiles.sql`. It replaces exactly ten functions and retains their existing privileges, including the sealed interactive body. Historical slots, witnesses, stored identities and receipts are unchanged. Arbitrary admitted providers retain their generic fallback; claims and reopening remain opt-in by profile. No mutable registry, provider activation or live qualification is introduced.

Known limits for the complete set: Provider and carrier proof is limited to fake clients, scripted adapters and offline fixtures; no live provider or carrier qualification is claimed. The starter still selects sandbox payments. The native payment rail supports the two reference providers through declarative profiles; a third provider needs a declaration plus its adapter. The supplied portable payment composition covers the reference card provider only; the second reference provider has no supplied portable composition. The included warehouse adapter is a reference example. Imports, declarations, package installation and offline certification activate no integration.

Fulfillment retains local reservations and local finished-picking consumption; provider-held reservations, provider-managed consumption, independent splits, standalone pickup-point/locker execution, native label create/void and provider-side cancellation remain unsupported. Labels are PDF only; reference-adapter label reads remain host-owned. Courier pickup has no provider-reaching port and declared support cannot earn full certification. Snapshot-only stock has no movements. Saved preferences require carrier/service strings even when native provider-selected parcels allow nulls. Native overview data requires a host reader.

Historical contacts, reservations, modes, acceptance proofs and arrival facts are not backfilled. Failed or uncertain dispatch and a lost replacement acknowledgement never authorize blind resubmission. Fulfilled parents need an authorized host workflow for replacement dispatch. Replacement creation/dispatch never confirm arrival: record actual delivery; an undelivered replacement remains outstanding. Delivered observations without admitted tracking references retain status evidence but cannot record arrival or alignment. The monotonic clamp never moves a cycle earlier or stacks deliveries.

Intake uses sequential page numbers, not opaque cursors; polling-only providers refuse webhook intake. Empty collections prove no absence. Human holds, terminal provider exceptions and evidence without usable chronology require manual handling. Native reads refuse missing destination/line snapshots. Replaying incomplete webhook transport metadata may replace polling-enriched nullable reference fields. Resolve missing or conflicting historical associations and evidence through authorized recovery; no inferred parcel, chronology or stock is supplied.

Offline certification checks honestly built fixtures and contract results; deliberate accessor, proxy or overridden-intrinsic manipulation to defeat the caller's own certification is outside its threat model. It is not an attestation of durable host behavior. Absence auto-reopen stays off by default and later dispatch requires explicit due-reopen consumption. Refund creation remains separate; refund evidence does not pause or cancel subscription service. Experimental services remain inert until explicitly composed.

## [0.42.0]

- Publishable on the npm `latest` dist-tag as `0.42.0`, from tag
  `openlup-platform-v0.42.0`.

- Add explicit native payment-method collection, reusable-reference storage, lifecycle delivery and recorded health, with scoped repair and recovery authority that freezes at dispatch. Historical mirrors are never promoted to charging evidence automatically. Retry admission and dispatch freeze bind the exact provider-method row and lock its recovery token through commit. Retry selection and preparation respect quarantine; real renewal/provider history cannot fall back to sandbox compatibility. Completed sandbox attachments with current sandbox terms preserve their lane when only the initial paid checkout used another channel; recorded references, including inactive rows, still select strict authority. Reminder production reads bounded method facts under runtime privileges; spent repair authority does not block later automatic rungs, and active expiring methods remain eligible for renewal reminders.

Migration: install the complete selected native chain through `20261114110000_payment_method_refs.sql` before composing collection or recorded-method readers. For host-composed native subscriptions without recorded refs and with real-provider history, retry, recovery, reactivation, auto-resume and upcoming reminders refuse or remain ineligible until the host records refs with `payment_method_ref_upsert` from verified evidence. Original renewal charging retains its previous method and mandate evidence behavior when no recorded reference exists, even with real-provider history. Once any reference row exists, every reader uses strict recorded authority, regardless of its status or active state. Account-support health follows the lifecycle classification even without a reference. Explicit sandbox subscriptions retain their behavior. Existing labels and token rows are not backfilled; obtain a new authorized token when recovery context is absent, select a host-authenticated setup lane and preserve outstanding retry authority. Setup callers must retain one trimmed 8–180 character idempotency key; formerly accepted short or oversized keys now refuse before ownership lookup or provider I/O.

- Correlate initial-order provider history before selecting sandbox compatibility; account health and lifecycle admission select strict authority for that history even without a reference. Original renewal evidence reads preserve their previous behavior until a reference is recorded; recorded rows in any state prevent fallback in every reader. Setup requests trim the key and enforce its 8–180 character contract before ownership lookup or provider I/O.

- Add native durable provider attempts, immutable verified ingress, replay receipts and separate payment identities. Preparation commits before provider execution; acknowledgement finalizes the same row, and unresolved or superseded attribution refuses before settlement effects.
- Add PostgreSQL persistence, webhook and recovery evidence factories. Enable only the prepared durable store capability; method setup, absence reopening and cumulative refund retain their existing limits. Historical rows are never reconstructed automatically.
- Record correlated provider renewal failures as immutable attempt-bound retry receipts before financial truth ingestion. Reuse one settlement transition and retain native obligation scheduling; provider dunning case, notice, token handoff and real renewal binding await later composition.
- Record an expiry after a decline on the same renewal attempt as a replay-safe escalation, retaining the existing failure receipt, retry stage and schedule.

Migration: install the complete selected native chain through `20261114100000_payment_provider_attempt_store.sql` before composing the ports. Hosts provide recorded provider authority and verified adapters. A refund does not pause or cancel a subscription; offline evidence does not activate a provider or a hosted journey.

Unpaid-order cancellation terminalizes provider payment authority. Recoverable
one-time and initial-subscription declines include a live checkout recovery
token in the delayed payment-failed notice. Inline response-loss replay reads
the durable transition without fresh method or purchase context.

Add the native PostgreSQL reconciliation port, atomic exact-attempt application,
attributed failure handoff, proof-backed absence reopen receipts and cumulative
refund evidence. Install the complete migration chain; absence auto-reopen stays
off, and immutable prepared dispatch receipts still require explicit due-reopen
consumption before later host execution.

Refunds preserve original settlement money, subscription service and paid-cycle
history. The native `commerce.order.refunded` event remains status-only;
financial customer messaging uses `commerce.order.refund_processed`, gated by
accepted same-currency evidence. Historical unattributed attempts and dunning
cases retain named refusal paths. Refund creation and provider activation are
outside this change.

A correlated failed webhook hands off dunning independently of its financial
result kind. If the direct result committed first, the handoff uses its original
attempt-bound failure receipt; duplicate delivery does not repeat money, retry
stages, recovery authority or notices.

- Add explicit card provider composition over native PostgreSQL payment, method-reference, reconciliation and retry owners. Prepared requests commit before dispatch; uncertain/replayed requests never dispatch again. Customer, client, order and save-card inputs and redacted finalization facts pass through the neutral factory additively.
- Bind timestamped verified ingress, immutable failure rungs, attributed dunning, recorded method replacement and evidence-gated cumulative refunds. Preserve provider time separately from first receipt; untimestamped card provider readback remains ambiguous.
- Validate addressed recorded-method authority before renewal dispatch, keep untimestamped native source/return carriers absent, replay finalized SCA refusals through the durable refusal owner, and acknowledge exact-attempt refusals for superseded or unresolved success events using their durable attribution, including unresolved redelivery after finalization.
- Keep default sandbox bindings and existing managed exports. The native rail supports the two reference payment providers; a third provider needs the provider-profile refactor. The supplied portable composition selects card provider only; live activation and the second reference provider's portable composition remain separate.

Migration: Install the complete native catalogue through `20261114120000_payment_reconciliation_refund_evidence.sql`, then explicitly compose the payment rail and renewal webhook/lifecycle/retry ports together. Historical method refs require owner-authorized registration; no automatic backfill is supplied. No SQL migration is added.

Known limits for the complete set: The native rail supports the two reference payment providers; a third provider needs the provider-profile refactor. The second reference provider's portable composition and the provider-profile refactor are deferred to a later set. Provider qualification is limited to fake-client proof; no live provider qualification is claimed. The starter still selects sandbox payments by default.

## [0.41.0]

- Publishable on the npm `latest` dist-tag as `0.41.0`, from tag
  `openlup-platform-v0.41.0`.

- Add the experimental `payments/testing` subpath with the existing conformance runner and a provider-neutral scripted transport fake. Optional safety fixtures exercise capability/refusal parity, network ambiguity, signed webhook replay, invalid money, partial amounts and chargebacks without live access. Existing adapter behavior and imports remain unchanged.
- Reserve the measured platform artifact budget for the next payments implementation part; individual feature rows share these caps.
Migration: `runPaymentAdapterConformance` now takes `readonly PaymentAdapterTestSubject[]`. That named type is the previous subject with its `verification` fixtures plus an optional `safety` member, so existing callers compile and run unchanged and need no action.
