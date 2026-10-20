# Changelog

Notable changes to this public-source workspace package are recorded here.
“Unreleased” means no npm version carries the change yet; immutable OpenLup
source previews may already ship some changes, and their release notes say
which. Declaration snapshots track candidate drift, not a stable API or
SemVer promise.

## [Unreleased]

- Keep the subscription inventory forecast with required provider injection; add the separate dated forecast calculator.

- Extract unchanged reservation TTL policy and native renewal reserve/release/expiry.

- Extract admin/native inventory reads and injected new-purchase stock projection.

- Add inventory DTOs, ports and schemas with required injected forecast-provider validation; reference browser validation stays local.

- Add experimental opt-in Node `communications/resend` with exactly three
  functions for guarded transport, authenticated webhook handling and GET-only
  delivery reconciliation.
  Hosts supply policy, environment selection and neutral persistence ports;
  injectable fetch adds no SDK/dependency. Neutral entries and the maintained
  reference adapter are unchanged. Protocol-only evidence; account verification
  remains pending. No default sender, route, schedule or recovery send.
- Move unchanged fixed-bundle rules, availability, semantic ports and admin/feed
  application handlers into the existing catalog server entry. Reference bindings
  retain schemas, shared admin kit/spec/flags, stock/lifecycle helpers, responder,
  wire versions and RPC error identity. Catalog contracts add plain DTOs only;
  browser schemas stay local. Native stores and SQL remain outside this slice.

Migration: existing reference imports remain named compatibility exports.
Installed consumers bind the host dependencies explicitly. Bundle DTO additions
are additive. Generated pricing/promotions snapshots reorder the existing bundle
component enum member; communications snapshots reorder update/email_change; promotions also reorders
the existing all member in status/scope enums.
Members and runtime behavior are unchanged. No SQL, data or activation migration is introduced.

- Add 14 experimental provider-neutral marketing-sync types through the existing
  communications and communications/contracts entries: profile sync, negative
  consent readback and erasure request/status. Existing M04 providers remain
  assignable. Positive consent writes are deferred; no adapter, callback,
  activation or package subpath is added. Migration: none for existing callers.
- Move promotion admin handlers/ports/DTOs/server schemas and native evaluator
  read/sweep into promotions, preserving reference kit/error/currency bindings.
  Project unchanged canonical SQL units 47/48 with descriptor hashes and positions;
  no migration or claim writer. Prove the existing native lifecycle/read subset
  on real PostgreSQL; native code and mounted parity outcomes remain pending.

- Add experimental `./promotions` application, advisory read ports, preview,
  money binding, acceptance and passive telemetry with explicit host bindings;
  `./promotions/contracts` contains dependency-free preview DTOs. Core remains
  the evaluator; reference shims retain existing behavior and managed transport.
  Migration: reference imports remain named compatibility exports; installed
  callers supply floor, classifier, eligibility, request projection and recorder.
- Add server-resolved acquisition terms as the final optional argument to both
  experimental quote acceptance callbacks (issue and honor). This deliberately
  extends the unreleased opt-in signature; bind that argument in the acceptance
  helper. Migration: existing callbacks remain assignable; inactive token bytes
  and reference activation are unchanged.

- Add an experimental opt-in acquisition selection, offer v3 and promise-consent
  API with required host financial policy and no default. Reference activation
  remains off. Migration: none for existing callers.

- Move the existing quote computation, snapshot comparison, quote/batch handlers,
  v1/v2 offer projection/handler/cache and readiness into the pricing module.
  Reference bindings retain flat shipping, promotion application and rich policy.
  Migration: existing reference paths remain compatibility bindings; installed
  consumers use the pricing entries and inject schemas, responder and host policy.

- Move the existing neutral quote foundation into pricing: money/tax/quote contracts, injected server validation, provenance, bounded catalog facts and tax refusal. Preserve reference browser/context validation and existing quote equations; Computation and offer behavior are preserved.

- Add experimental `./pricing` and `./pricing/contracts` entries by moving the existing OpenLup authority, subscription policy, assignment token and refusal mapping unchanged. Named reference exports preserve identity; browser schemas and feature-flag/secret/readiness composition remain local. Acquisition selection was outside the initial authority move and is now available through the separately configured opt-in API.

- Add experimental `catalog` and dependency-free `catalog/contracts` entries by
  moving the existing public neutral foundation, product types, draft logic,
  read ports and projections unchanged. Reference paths delegate; browser
  sellable schemas and rich catalog interpretation remain application-owned.
  Add unchanged provider-free media validation/resolution and bounded source-pack
  transfer using the existing blob port. Add lifecycle/publication DTOs and ports
  only; publication read, publish and lifecycle writes remain unsupported, with
  no executor, upload route, activation, SQL or wire-status changes.

Migration: existing consumers need no source or schema changes. The identity
snapshot only reorders `inactive` in the emitted `customerLifecycleStageSchema`
and `customerMeResponseSchema` enum declarations; members and runtime behavior
are unchanged. Catalog adoption is opt-in through the new experimental entries.

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
