# Changelog history

Releases moved verbatim out of the packed `CHANGELOG.md`, which keeps the current release and the two previous ones.

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
