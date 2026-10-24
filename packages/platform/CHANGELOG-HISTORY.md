# Changelog history

Releases moved verbatim out of the packed `CHANGELOG.md`, which keeps the current release and the two previous ones.

## [0.21.0]

- Publishable on the npm `latest` dist-tag as `0.21.0`, from tag
  `openlup-platform-v0.21.0`.
- Preview set: core/outbox unchanged, UI private `0.0.0`; published `0.20.0` size baselines, unchanged caps.

### Cumulative M07 status: payment truth and repair surfaces complete for this wave

- Experimental payments/contracts/runtime: unchanged prepared ordering; neutral execution/evidence/readback/conformance, verified truth, first-receipt ingress, method lifecycle/reconciliation; host-owned persistence, translation/failure policy.
- Native PostgreSQL truth/settlement/later-only alignment; three unchanged sparse SQL projections, not an install chain. Refunds never cancel subscriptions.
- Repair/recovery/buyer verify inject rail capabilities; unknown rails refuse. Reference BFF retains mapping/schemas/ownership/auth order/transient callbacks. Browser/verify outcomes never prove payment success.
- Reference-application source (no new export), opt-in repair view: `commerce/paymentStatusClient`, `commerce/paymentVerifyClient`, `payment/components/PaymentStatusPoller`; stored paid alone confirms, redirects require HTTPS, collection/confirmation stay injected, unsupported setup is visible. Exact file/specifier guards refuse broad commerce/operator clients; source-import proof keeps default view unmounted.
- Truth services/one optional named binder use the host executor, no new schedule/executor. Selectors default-off: nothing activates by default. First-insert adapter fingerprint excludes receipt time/audit.
- Two experimental example adapter subpaths under `./payments/`, named in the README. Card-processor example: three frozen exports, injected host client/neutral ports; refund creation, split authorization/capture and exact absence unavailable; cancellation needs host support.
- Regional-processor example: host I/O, Model O aliases, verified observations, purpose-sensitive readback; check certificate validity/notification freshness. Both examples have no import I/O/default binding and await account TEST evidence.
- Example adapter advisory: mismatched nonzero refusal money stays unknown/manual; trusted document refusals mean customer data correction; configuration mismatches throw before I/O. Unpaid/transient no-dispatch classifications unchanged.
- Settling money missing/invalid/non-positive or blank currency refuses as amount mismatch; conformance requires positive money. Empty optional transients stop false leak refusals; JSON-escaped transients in diagnostics/readbacks/stored payloads and payer contact in execution results now refuse.
- Private types reuse canonical money/attempts; unused imports removed, runtime/API unchanged.

Migration: upgrade all `@openlup/*` `0.20.0` → `0.21.0` for exact pins. No schema migration; install the canonical catalogue, not sparse projections. Attempts add optional method selection/transient payer contact; contact is dispatch-only, never persisted/audited/logged/diagnosed. Missing adapter-required input requires exact before-dispatch `notDispatched`. Registration refs/kind/status require host `resolveMethodOwner` client/subscription ownership or are omitted. Lifecycle/normalized nested audit copies typed fields only; conformance scans all for secrets/contact. Adapter-filtered redacted audit never stores raw bodies; typed evidence overrides reader facts, audit bag fills untyped facts; identity/fingerprint exclude bag/receipt time. Other changes need no migration, and nothing rewires a host automatically.

Migration: F2 replaces assumed full refund with `require-evidence`: missing/null kind/amount/operation identity is durably recorded/acknowledged, not applied. Supply original money, stable operation identity and cumulative snapshot, event delta or explicit full reversal (`refund`/`chargeback`); full evidence stays valid. Former default needs `refundEvidencePolicy: "legacy-assume-full"`, also in the reference handler; no native parity implied.

Migration: D11 changes every caller of the reference payment control port (the selected verified ingress, the existing provider webhook handler and the captured reference checkout): apply/post-process redelivery using the first stored receipt instant, not redelivery time, so it cannot shift the cycle again. Replay reads winning receipt evidence and refuses (503) when that instant is unavailable. A legacy pre-fingerprint row takes the later clock once. Retain receipt evidence on upgrade; provider routes are not switched to opt-in ingress.

### Known limitations

- Portable dunning repair has no managed twin: exhaustion still pauses active subscriptions there; retaining active status needs a managed forward.
- D8-1: native advisory v2 promo-code candidates/rejection details unavailable.
- D8-2: native mounted v2 issue/honor/fallback unavailable.
- D8-3: native acquisition-only mounted issuance/honor unavailable.
- D8-4: full native/managed eligibility equivalence unavailable.
- Bundle-1: independent DB human-only actor-kind enforcement absent natively; first in the native-backend parity round.
- Bundle-2: managed-equivalent actor-kind/email history absent natively.
- Bundle-3 closes injected-reader M05 mounted admin/feed readback only. Native new-purchase stock read absent despite P5a installed-store proof; deferred second after bundle-1 (owner 2026-10-21); readiness refuses.
- Bundle-4: incumbent real-PostgreSQL contention only; no exactly-once guarantee.
- Managed schema/pgTAP retain `44.404`; removal needs owner decision/forward; reference composition supplies it to app code.
- A1 offline only; account/hosted-time/owner TEST evidence unclaimed; `communications/klaviyo` verification-pending.
- M05 omitted opt-ins preserve defaults/outputs/read order/schedules/refusals/acceptance-token bytes/SQL.
- Native inventory adjustment unavailable; address writes refuse readiness. Flat-rate save needs selected port/Core readiness/applied-seed observation.
- Native shipping audit unavailable; handler swallows best-effort audit failure.
- Native flat-rate integer bounds (0 through host maximum; reference 100,000 minor units) use request schema, not DB CHECK.
- Managed ATP/forecast/dated-supply/pagination readback unproved/pending M06.
- Managed two-session locks/concurrency/uncovered compensation unproved/pending M06.
- Managed exact-prefix upgrade/ledger unproved/pending M06.
- Managed address idempotency/conflict/readback unproved/pending M06.
- Managed successful flat-rate read/save unproved/pending host authority.
- M06 stock-wait lifecycle/durable timing/staging controls retain C5/C6; busy/try-gate, continuity/flag/TTL transfers are dispositions, not PASS.
- Shipping national-registry fields/locale-specific `canonicalAddressKey` fold await M16 host market pack/key migration; reference shipping copy stays locale-specific until M16.
- Native durable prepared storage, method setup, absence reopen and cumulative refunds unavailable; no production installation parity claimed.
- Typed refusal-envelope forwarding unavailable (`failureReason` only); reusable registration needs host ownership resolution.
- Incomplete chargebacks stay refunds/unapplied: reclassification bypasses evidence validation into dispute apply; limited operator recovery.
- Audit compatibility still detects `chargeId`; refund operation identity/original money supply no typed charge identity.
- M07 follow-up: repair poll can clear host redirect; post-timeout verify never restarts polling; unlocalized poller; fixture builds/never calls handler.
- M07 follow-up: reference status route wrong-rail witness.
- M07 follow-up: explicit reference-route refusal for unsupported method setup.
- M07 follow-up: deployment-neutral disabled-verify reason.
- M07 follow-up: reference card normalizer missing-amount path; package settling evidence already requires positive money.

## [0.20.0]

- Publishable on the npm `latest` dist-tag as `0.20.0`, from tag
  `openlup-platform-v0.20.0`.

- Refresh release size-gate baselines from the published `0.19.0` tarballs; all caps remain unchanged.

- Keep active subscriptions active on portable dunning exhaustion (invariant repair).

Migration: apply the complete portable catalogue through
`20261021120000_dunning_lifecycle_active_repair.sql` at position 71. Previously,
NULL next retry expired the case and paused an active subscription; it now leaves
the case open and repairable, retains the final notice and exhaustion event, and
changes no subscription or cycle dates. Existing rows are not rewritten. Pass
NULL only when `isDunningLadderExhausted` holds; a class-terminated rung-one refusal
still must not be passed as NULL. There is no managed twin yet; the managed
baseline still needs a separate forward.

- Add the readiness-gated native flat-rate binding; the host supplies the named
  role-free lane and fixed-key rate port, as in the reference composition.
- Require the native port and Core readiness for the shipping seed migration.
- Refuse missing-row saves; native audit remains explicitly unsupported and best effort.

Migration:
Apply the complete portable chain through 20261021200000_shipping_flat_rate_seed.
The seed preserves an existing rate and inserts zero only when absent; no ACL or
role changes are made. New code on an unmigrated schema keeps refusing. Older code
reads the seeded zero as it read an absent row. An application rollback does not reverse either forward
(positions 71 and 72), and older runners refuse the extended ledger.
Managed host-save authority remains pending.

- Add the shipping `SHIPPING_MIGRATIONS` export and the optional
  `nativeRateReadiness` / `nativeRateSchema` binding dependencies.

Migration: upgrade the complete `@openlup/*` set from `0.19.0` to `0.20.0`
for exact internal pins. Native rate bindings require the selected port plus
Core readiness and a same-database schema observation of the applied seed.
Install the complete canonical migration catalogue, never sparse package
projections as an installation chain.

### Cumulative M06 status

- M06 remains incomplete: inventory and shipping are development-preview
  surfaces, with managed-host proof classes pending.
- Inventory and shipping contracts, stock/ATP reads, reserve/release/expire
  operations, subscription forecasts, delivery selection, address and flat-rate
  handlers first shipped in `0.18.0`. Opt-in inventory/shipping/composition
  bindings (P5a/P5b) first shipped in `0.19.0`. M06's only new behaviour in
  `0.20.0` is native flat-rate save behind readiness; the portable dunning
  invariant repair is separate from M06. Host-owned policy and unsupported
  operations retain their explicit boundaries.

### Known limitations

- The portable dunning invariant repair has no managed twin in this set. The
  managed baseline pauses active subscriptions on exhaustion; keeping them active
  requires a separate managed forward. Portable proof does not establish managed parity.

- D8-1: native advisory v2 promo-code candidates and rejection details are not supported on the native backend.
- D8-2: native mounted v2 code issue/honor/fallback is not supported on the native backend.
- D8-3: acquisition-only mounted issuance/honor is not supported on the native backend.
- D8-4: full native/managed eligibility equivalence is not supported on the native backend.
- Bundle-1: independent database human-only actor-kind enforcement is not supported on the native backend and is the first item of a future native-backend parity round.
- Bundle-2: managed-equivalent actor-kind/email history is not supported on the native backend.
- Bundle-3 remains closed for M05 mounted admin/feed readback with an injected stock reader, while native new-purchase stock reads remain unsupported despite P5a's installed native inventory-store read proof.
- Bundle-4 establishes only incumbent real-PostgreSQL contention characterization and provides no exactly-once guarantee.
- The managed baseline schema and its pgTAP tests retain the incumbent legacy value `44.404`; removing it needs a forward migration and an owner decision, while reference composition supplies that value to application code.
- A1 evidence is offline only: account verification, hosted-time behaviour and owner TEST certification are not claimed, and the `communications/klaviyo` adapter's capabilities stay verification-pending.
- M05 parity seams are opt-in and omitted bindings preserve incumbent defaults, outputs, read order, scheduling, refusals, acceptance-token bytes and exported SQL.
- Native inventory adjustment remains unsupported; native address writes refuse
  required-capability readiness. Native flat-rate save is supported only behind
  the selected port, Core readiness and applied-seed schema observation.
- Native new-purchase stock read is deferred to the native-backend parity round
  (owner 2026-10-21), second after M05 bundle-1; required readiness still refuses
  honestly.
- Native shipping-rate save has no durable audit: audit is explicitly unsupported,
  and the incumbent handler swallows the best-effort audit failure.
- Native flat-rate value bounds (integer, 0 <= value <= the host request schema's
  maximum) are enforced by that schema, not a database CHECK; the reference
  maximum is 100,000 minor units.
- Managed host ATP/forecast/dated-supply/pagination readback is not proved and
  remains pending in the M06 ledger; no managed-host parity is claimed.
- Managed two-session lock order/concurrency and uncovered compensation paths
  are not proved on a managed host and remain pending; no equivalence is claimed.
- Managed exact-prefix upgrade/ledger is not proved on a managed host and remains
  pending; no managed installation equivalence is claimed.
- Managed address adapter idempotency/conflict/readback is not proved on a managed
  host and remains pending; no fixture-to-host equivalence is claimed.
- Managed successful flat-rate read/save remains pending host authority and is
  not proved on a managed host; no successful managed host-save claim is made.
- M06 adopter stock-wait lifecycle, durable subscription timing and staging
  control observations retain their separate C5/C6 evidence gates. Busy/try-gate
  protocol, durable stock-wait continuity and staging flag/TTL rows transferred
  to C5 adopter evidence are dispositions, not PASS.
- Shipping contracts retain national-registry address fields and
  `canonicalAddressKey` retains a locale-specific character fold. M16 owns their
  move behind a host-supplied market pack with a canonical-key migration plan.
- Reference shipping UI copy remains locale-specific until M16.
## [0.19.0]

- Publishable on the npm `latest` dist-tag as `0.19.0`, from tag
  `openlup-platform-v0.19.0`.

### 0.18.0 → 0.19.0 set scope

- Prepare the complete development-preview minor set at `0.19.0`, including everything on main since `0.18.0`; core and outbox are unchanged republications, and UI stays private `0.0.0`.
- M05 parity adds opt-in shipping-promise consent, post-discount threshold shipping and acquisition orchestration to the experimental pricing, promotions and shipping entries; financial policy and acquisition capability remain host supplied.
- M05 parity adds effective native bundle selection and an authoritative preview hook, optional resolved-target/detail/feed context fields and `selectEffectiveBundleTargetPrice`; effective feeds require unambiguous gross unit anchors and whole-BOM readiness.
- Add `createConcurrentCommercePriceAuthorityPort` with concurrent history scheduling, selected-list identity and base-refusal precedence; browser additions are type-only.
- Catalog/contracts draft canonical JSON detects lone surrogates without regex lookbehind so it loads in Safari before 16.4, with unchanged behavior.
- M06 P5a adds explicit inventory store/provider bindings and structural inventory contribution, keeping reference catalog-stock composition inert and managed authorization intact; native new-purchase stock reads remain unsupported pending an owner decision and native adjustment still refuses.
- M06 P5a retains focused installed-consumer, runtime-role, managed FEFO/adjustment and consume/refund replay evidence with unproved parity gates retained in the M06 ledger.
- M06 P5b adds opt-in shipping selection, address and flat-rate bindings with injected validation and authority; native address writes remain unsupported and refuse required readiness.
- M06 P5b adds the final isolated installed inventory/shipping consumer, preserving incumbent selection errors and flat-rate behavior.
- M06 in progress: inventory and shipping entries are early surfaces; module not complete
- Supporting main changes sort platform registration lists one item per line and use the database clock in the M05 P7 quote witness; neither adds runtime behavior.

Migration: upgrade the complete `@openlup/*` set from `0.18.0` to `0.19.0` for exact internal pins; existing bindings need no change and new module adoption remains explicit and experimental. Hosts selecting shipping promises must forward `shippingTerms` through both acceptance callbacks and use a context schema that preserves the selected terms. Bind `resolveQuoteShippingPromotions` to the promotions factory to select the bounded two-pass threshold path; financial policy and acquisition capability remain host supplied. The additive APIs require a minor set and introduce no activation. For both M05 24b and M06 P5b, the pricing and promotions API reports reorder existing enum/union members because declaration emit order changed (24b follows the catalog-to-pricing import); no member is added, removed or changed and callers need no migration for that reorder. Install the complete canonical migration catalogue, never sparse package projections as an installation chain; this preparation adds no SQL migration.

### Known limitations

- D8-1: native advisory v2 promo-code candidates and rejection details are not supported on the native backend.
- D8-2: native mounted v2 code issue/honor/fallback is not supported on the native backend.
- D8-3: acquisition-only mounted issuance/honor is not supported on the native backend.
- D8-4: full native/managed eligibility equivalence is not supported on the native backend.
- Bundle-1: independent database human-only actor-kind enforcement is not supported on the native backend and is the first item of a future native-backend parity round.
- Bundle-2: managed-equivalent actor-kind/email history is not supported on the native backend.
- Bundle-3 remains closed for M05 mounted admin/feed readback with an injected stock reader, while native new-purchase stock reads remain unsupported despite P5a's installed native inventory-store read proof.
- Bundle-4 establishes only incumbent real-PostgreSQL contention characterization and provides no exactly-once guarantee.
- The managed baseline schema and its pgTAP tests retain the incumbent legacy value `44.404`; removing it needs a forward migration and an owner decision, while reference composition supplies that value to application code.
- A1 evidence is offline only: account verification, hosted-time behaviour and owner TEST certification are not claimed, and the `communications/klaviyo` adapter's capabilities stay verification-pending.
- M05 parity seams are opt-in and omitted bindings preserve incumbent defaults, outputs, read order, scheduling, refusals, acceptance-token bytes and exported SQL.
- Native inventory adjustment remains unsupported; native address writes and flat-rate saves refuse required-capability readiness.
- M06 managed host ATP/forecast/supply/pagination, remaining compensation/concurrency/lock-order, exact-prefix upgrade/ledger, address idempotency/conflict/readback and runtime rate authority remain pending in the M06 ledger.
- M06 adopter stock-wait lifecycle, durable subscription timing and staging control observations retain their separate C5/C6 evidence gates.

### Size note

Only platform `pack.docs.maxPackedBytes` rises from 40,960 to 49,152 B; all other caps and budgets remain unchanged. All three baselines use integrity-verified published `0.18.0` tarballs.

Question (2026-10-21): "The platform package's root docs (README + CHANGELOG) will exceed their 40,960 B gzip cap at the next release. What should we do?"
Owner's answer: "Raise to 49,152 B (Recommended)"
Option description shown to the owner: "Same figure as core. Unblocks the next few releases; the CHANGELOG grows every release, so this cap would otherwise block each one."
Recorded as an owner decision taken through the coordinator's question on 2026-10-21.
## [0.18.0]

- Publishable on the npm `latest` dist-tag as `0.18.0`, from tag
  `openlup-platform-v0.18.0`.

- M06 P4: retain named compatibility shims, restrict inventory smoke evidence to package-owned tests, neutralize synthetic transport fixtures and clarify inventory documentation; no runtime or API change.

### 0.17.0 → 0.18.0 set scope

- Prepare the complete development-preview set at `0.18.0`: core and outbox are
  unchanged republications; platform includes every change on main in this set.
- M05 adds catalog foundation/contracts, draft validation, product/lifecycle DTOs,
  authority/GTIN/quantity helpers, media and source-pack operations,
  fixed-bundle read/admin/feed logic, native envelope/draft stores and an inert
  catalog contribution; pricing adds the neutral quote foundation, authority,
  subscription policy and assignment token, quote/offer projection, opt-in
  acquisition terms and promise consent; promotions includes advisory, preview, acceptance,
  admin/native reads and sweep with explicit host bindings; lifecycle/publication
  contracts alone do not provide a publisher or native lifecycle writes.
- M05 P6: pricing and bundle comments are corrected, VAT arithmetic delegates to the
  existing helper and moved test fixtures are neutral with assertions unchanged;
  no API change.
- Reference-application source: opt-in catalog, product, basket, builder and admin UI consumes explicit
  data/locale/media/lifecycle inputs; basket edits invalidate promise consent and
  minor-money display uses the currency exponent.
- Shipped catalog SQL projects unchanged canonical positions 1/8/16/19/58/59/61,
  promotions projects 47/48 and inventory projects 27/33; native catalog factories
  retain the existing store bodies and references preserve their named exports.
- A1 adds 17 neutral marketing/consent declarations, the three-function `communications/resend`
  entry, the `communications/klaviyo` marketing adapter and lazy opt-in reference bindings with
  invocation-time admission; default routes, schedules and handlers stay empty.
  Existing providers remain assignable; existing neutral entries keep their runtime
  behaviour (the declarations above are additive), and the maintained reference
  adapter and default wiring are unchanged.
  Authenticated raw webhooks and GET-only delivery reconciliation retain host
  ownership of persistence and admission; no SDK or default sender is added.
  `communications/klaviyo` profile projection, negative consent readback,
  account-wide deletion acknowledgement and authoritative consent push stay
  verification-pending until the host supplies owner TEST verification.
  Audience-scoped deletion and deletion status are unsupported; newsletter sync
  refuses. No flow control, historical import, suppression edits or automatic
  mutation retry is added.
- Consent push grants stay audience-scoped; only withdrawals may be account-wide.
  The capability declares `grantEffect`; accepted/acknowledged results require
  `reconcileRequired`. Conformance keeps grants unsettled until settlement and
  fresh readback. Withdrawals bypass grant-caused fences/quarantine but retain
  same-key withdrawal fences and account cooling. No push factory, activation,
  callback, retry or subpath is added.
- M06 in progress: inventory and shipping entries are early surfaces; module not complete
- The merged M06 surfaces include inventory contracts/admin/native reads, injected
  new-purchase availability, reservation policy/maintenance and dated forecast
  calculation with required provider injection, plus shipping selection, address
  and rate handlers with required host validation.
- @openlup/platform size growth: added M05 catalog, pricing and promotions implementations, native stores and SQL projections, A1 communications adapters and consent contracts, and the merged early M06 inventory/shipping surfaces with their declarations and documentation.

Migration: upgrade the entire `@openlup/*` set from `0.17.0` to `0.18.0` for exact
core peer pins; new module adoption remains explicit and experimental.
Catalog and promotions server entries are adapters: their declarations require
selected optional `pg` peers, while runtime imports and injected executors work
without them and their contracts entries remain non-adapters. Supply host schemas, authorization,
responders and policies through the documented bindings. Acquisition requires
an explicit `AcquisitionFinancialPolicy` with no default; absence refuses with
`acquisition_terms_policy_unconfigured`, and reference activation remains off.
Bind resolved terms from the final optional issue/honor callback argument for
acquisition-aware acceptance; existing callbacks remain assignable. Stop
assigning `NegativeFeedback.kind` or `.outcome`, now readonly. Reference-application
source threshold classifiers require the host's explicit threshold. Generated enum declaration
ordering changes preserve member values and runtime behavior. Catalog adds
`createPostgresBundleCatalogStore`, `createPostgresCatalogDraftStore` and
`createPostgresCatalogSkuEnvelopeReadPort`, plus `BUNDLE_MIGRATIONS` (16/19) and
`CATALOG_MIGRATIONS` (1/8/58/59/61); composition adds
`createCatalogContribution` and `CatalogContributionInput`, with no public export
removed or renamed. Existing named reference imports remain compatibility paths.
The native writer, pooled transaction binding and transport remain reference-owned;
browser schemas stay local. Core remains the promotions evaluator; no claim writer
is added, and claim writing and mounted acceptance retain their owners. Reference
shipping selection, pickup and stock UI mechanics and browser validation stay local.
Install the complete canonical migration manifest, never sparse package SQL
projections as an installation chain; this preparation adds no new SQL migration.
A1 hosts retain credentials, identity/authority, atomic storage, environment,
egress and schedule ownership; acknowledged/accepted does not establish remote
effect and local consent remains authoritative.

### Known limitations

- D8-1: native advisory v2 promo-code candidates and rejection details are not supported on the native backend.
- D8-2: native mounted v2 code issue/honor/fallback is not supported on the native backend.
- D8-3: acquisition-only mounted issuance/honor is not supported on the native backend.
- D8-4: full native/managed eligibility equivalence is not supported on the native backend.
- Bundle-1: independent database human-only actor-kind enforcement is not supported on the native backend and is the first item of a future native-backend parity round.
- Bundle-2: managed-equivalent actor-kind/email history is not supported on the native backend.
- Bundle-3 is closed for M05 mounted admin/feed readback through the merged availability builder with an injected stock reader; the real native stock read remains M06 P5a work.
- Bundle-4 establishes only incumbent real-PostgreSQL contention characterization and provides no exactly-once guarantee.
- The managed baseline schema and its pgTAP tests retain the incumbent legacy value `44.404`; removing it needs a forward migration and an owner decision, while reference composition supplies that value to application code.
- A1 evidence is offline only: account verification, hosted-time behaviour and owner TEST certification are not claimed, and the `communications/klaviyo` adapter's capabilities stay verification-pending.

## [0.17.0]

- Publishable on the npm `latest` dist-tag as `0.17.0`, from tag
  `openlup-platform-v0.17.0`.

- Add experimental `./communications` and browser-safe
  `./communications/contracts`, plus generic capped raw-body, hex-HMAC and
  constant-time comparison helpers in the existing `./http` entry. Compose neutral
  transport/results/capture, rendering/content, independent Auth verification,
  receipt/observation, polling/reconciliation, consent and membership sync engines.
  Provider clients, protocol/key mapping, copy and activation remain host-owned.
- Require explicit egress admission for supported injected network senders.
  Guarded transports validate fresh host decisions, redirect sink sends and
  suppress drops before network entry; provider names grant no admission.
  Capture remains local acceptance. Preserve the maintained reference transport
  through its trusted composition bridge and keep Auth/provider verification separate.
- Add Polish/English invoice, role, opt-out and inquiry default-content factories
  with whole-copy injection. Preserve implicit Polish invoice and existing role
  expectations; EN invoice is construction-time opt-in. Reference opt-out page
  copy, EN legacy/error text, document language and escaping change deliberately.
  Pure inquiry rendering activates no sender. See the
  [B1/B2 expectation inventory](../../docs/platform/plans/oss-m04-communications-triggers.md#b1-egress-boundary).
- Add an opt-in immutable composition-time purpose registry with mandatory
  classification and finite legacy defaults. Registration grants no consent,
  provider activation or managed schema permission; custom-purpose persistence
  stays with the host. Add neutral newsletter processing and marketing ports
  without a runner or a new public purpose.
- Add four bounded native store groups: delivery observation/readback, existing-rail
  membership sync, operator notification recipients and durable consent decisions.
  Append CREATE-only direct catalogue position 70,
  `20261019200000_communications_native_operations.sql`, and its exact sparse
  projection. Standard factory lanes refuse unsafe effective privileges.
  Sync uses `public.outbox_events`; the sidecar is not another executor.
- Compose selected native readback and atomic signed-token preferences with Core
  readiness, explicit provider/binding identities and host-supplied clocks and
  schedules. Add distinct opt-in operator evidence and installed substitute-provider
  proof. Captured, network-accepted and membership-synced are not delivered.
  Native consent excludes managed 16-hour / 2-day / 4-week caps and legacy
  contact-touching, and is not a send-time fence. No default cadence, deployment
  activation, full native general sender or UI package capability is added.
  [T07 destinations](../../docs/platform/plans/oss-m04-communications-triggers.md#t07-destination-matrix)
  remain explicitly open with their owning modules.
- @openlup/platform size growth: added the reviewed neutral communications runtime and browser content contracts, bounded native stores and SQL projection, and their API/adoption documentation.

Migration: `0.16.0` did not export communications. Upgrade the complete package
set to `0.17.0` for the exact core peers, then explicitly select and bind the new
experimental capability. Existing non-communications entries retain their contracts.
The host retains renderer/copy, environment, origin, egress, provider protocol,
credentials and schedule ownership. The generic HTTP helpers do not replace the
independent Auth Standard Webhooks or provider-specific verification protocols.

Install the complete selected direct canonical catalogue through position 70
before selecting native stores. `COMMUNICATIONS_MIGRATIONS` projects positions
2, 9, 20 and 70; never reapply these sparse files over an existing canonical
history or treat them as a standalone chain. Preserve managed/private lineage
and custom-purpose persistence: registering a purpose does not expand managed
CHECKs. Thread the same registered purpose union and registry through selected
policy, token, newsletter and store bindings; omitted arguments retain finite
legacy defaults and existing signing bytes.

`registerNativeSyncWorkInTransaction` is a trusted host transaction seam. Its
caller-owned executor must already hold the lane's safe effective privileges;
this function does not check those privileges. The caller owns the transaction
and must commit or roll back permission, sidecar and existing-rail effects
atomically. Use a safely admitted lane; the helper grants no provider or claim
authority. Standard native sync factory transactions check
`public.communication_native_sync_state`, `public.outbox_events` and
`public.communication_recipient_consents`.

Custom native stores must provide binding-scoped `findByMessageId`, bounded
`listEvidence` (1–100) and atomic `registerPreference` as declared by the new
surface. Supply explicit provider/binding identities and full catalogue admission.
Hosts preserving older opt-out page bytes retain their own presentation binding;
token purposes, verification and existing HTTP status/header semantics remain.
See the [package composition guidance](README.md#communications-import).

Growth reading: +61.4% against the retained initial `0.16.0` baseline (256,973
packed bytes), measured before S1 notes at 414,808 bytes; final S1 measurements
are recorded in the programme evidence. No cap is changed. Baseline evidence
(2026-10-20): the published `0.16.0` tarball is 257,434 packed bytes, SHA256
`030756175d61279aab0ae7b26b27783e08467ec93673f5623d19d0b7fc436463`.
S1 option B retains the initial release-gates baseline rather than replacing it
with this observed registry identity.

## [0.16.0]

- Publishable on the npm `latest` dist-tag as `0.16.0`, from tag
  `openlup-platform-v0.16.0`.

- Add the experimental identity capability at `./identity` and browser-safe
  `./identity/contracts`: role-based authorization, actor-scoped profiles,
  bounded normalized contact matching, unconfirmed soft accounts with explicit
  email-trust policies, and configured-origin magic-link redirect resolution.
- Add operator invitations with transactional pending acceptance, expiry,
  cancellation and revoked re-invitation for direct stores, and immediate active
  membership with repeat/concurrent recovery for managed stores. Direct operator
  login uses single-use email challenges, operator-audience sessions, live
  membership authorization, explicit first-administrator bootstrap and bounded
  challenge pruning. An opt-in OIDC access-token verifier provides pinned issuer
  discovery, bounded rotating JWKS, strict claim validation and deterministic
  issuer/subject principals for direct composition.
- Add versioned personal-data contributors, identity export and transactional
  direct erasure with contributor vetoes, challenge/invitation cleanup,
  pseudonymization, guarded operator revocation and idempotent receipts. Managed
  export reports incomplete coverage; managed erasure refuses with
  `MANAGED_PRIVACY_ERASURE_UNAVAILABLE` without mutation. Issued tokens may remain
  valid until expiry.
- Add seven byte-identical identity SQL projections and host-selected module
  schema readiness. The projections retain canonical migration identities and
  positions; they are not a standalone installation chain.

Migration: identity adoption is opt-in; upgrade the complete package set together
for the exact `@openlup/core` `0.16.0` peer pin. Supply the selected bundle's schema
inventory, clients and delivery bindings, an explicit email-trust policy, exact
redirect origins, a distinct operator audience and a deployment policy for
admin, operator and privacy routes. Managed soft-account provisioning requires
an email-trust envelope with automatic confirmation disabled and all enabled
non-email providers declared email-verifying. Install the complete direct
catalogue through `20261018190000_identity_privacy_erasures` before enabling
identity; never reapply projections to an existing canonical history. Managed
adopters need their committed chain's
`20261018160000_identity_service_role_capabilities.sql` forward for contact linking
and operator membership capabilities, and must supply their own erasure path.

## [0.15.0]

- Publishable on the npm `latest` dist-tag as `0.15.0`, from tag
  `openlup-platform-v0.15.0`.

- First publication of `@openlup/platform`, the server substrate for an OpenLup application, with one module subpath each for `http`, `bff`, `scheduler`, `blob`, `data`, `migrations`, `job-ledger`, `kernel` and `composition`.
- Transport-neutral scheduled jobs: a `run(context)` contract, an empty job registry, a lease-aware runner and an authenticated HTTP cron entry, with a constant-time cron secret comparison.
- Per-capability bundle readiness that refuses an unknown bundle and reports every missing scheduler, lock and blob setting together.
- Blob capability selection with filesystem, Vercel Blob, Supabase Storage and S3 bindings; `pg`, `@types/pg` and `@aws-sdk/client-s3` are optional peers, and an adapter refuses a missing peer with `OPENLUP_E_PEER_MISSING`.
