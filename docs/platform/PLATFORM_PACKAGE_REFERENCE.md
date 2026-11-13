# Platform package reference

Status: maintainer page: how to change OpenLup. Reader guidance lives in the [OpenLup guide](../../packages/core/docs/guide/README.md); sections marked "Evidence" are frozen historical records.
Audience and purpose: adopters composing the identity and communications modules
from `@openlup/platform`.

This page holds the longer module recipes kept out of the packed README so the
package's documentation stays under its packed size cap. The
[package README](../../packages/platform/README.md) remains the package entry point.

The `/migrations` entry also provides the complete installed PostgreSQL catalogue
through `createPlatformPostgresMigrationRunner`. See the self-contained
[installation recipe](../../packages/platform/README.md#install-the-portable-postgresql-schema).
It reuses the existing runner and exact canonical SQL history; qualified host
profiles remain explicit. The package factory requires `installation`; only the
repository facade defaults to legacy. No checkout is required.

## PostgreSQL quote price reads

Moved to [Read prices for a quote](../../packages/core/docs/guide/how-to/build/quote-prices.md#compose-a-request-scope).

The four reads preserve complete list, exact base, exact legacy subscription and
policy histories.

Evidence (historical record, 2026-11-13):

The existing `createPostgresCommercePromoDataPort(runtimeExecutor)` from
`@openlup/platform/promotions` supplies five advisory evaluation methods. Two
named limits remain: device evidence is not persisted and the device routine
returns constant false; redemption counts do not aggregate mirror families.
Neither limit establishes eligibility or full parity. Hosts must not infer those
capabilities from the factory's presence. See
[native promotion evidence](../../packages/platform/README.md#promotions) and the
[restricted PostgreSQL characterization](../../tests/postgres/commercePriceAuthorityRead.test.ts).

## Application file upgrade

Moved to [Upgrade application files](../../packages/core/docs/guide/upgrade/application-files.md#prepare-snapshots).

The disposable example uses Node 24, predecessor/candidate schema ranges
`{ min: 1, max: 2 }` and caller-supplied `schemaVersion: 2`. Its managed
`generated/entry.mjs` changes from `export const revision = 1;` to
`export const revision = 2;`, each followed by a newline. These ordinals are
example evidence, not database observations or OpenLup schema versions.

## Legacy PostgreSQL role prerequisites

From an authorized disposable PostgreSQL 16+ session, pass its existing query
handle to the same experimental lifecycle entry:

```js
import { inspectLegacyPostgresInstallRoles } from "@openlup/platform/lifecycle";

const report = await inspectLegacyPostgresInstallRoles(db, {
  migrationLogin: "example_migration",
  runtimeLogin: "example_runtime",
  roleMode: "operator-provisioned",
});
console.log(report.scope, report.rolePrerequisitesMet, report.blockers);
```

This example reports the immutable legacy bootstrap's separate-login and
operator-provisioned-mode refusals; it provisions nothing. Both actual session
identities must match the declared migration login. Read the
[finite role-observation boundary](DATA_AND_MIGRATIONS.md#legacy-fresh-bootstrap-role-observation)
before interpreting any result. A true prerequisite report does not certify an
installed database, runtime ACLs or a qualified provider.

## Marketing server composition

Moved to [Compose marketing handlers](../../packages/core/docs/guide/how-to/build/marketing.md#choose-the-import-boundary).

Reference bindings load `@openlup/platform/marketing/server/postgres`
lazily after bundle and connection guards. The reference host owns observed-route
wrappers and admin auth binding. The manifest depends on identity's
`./identity/contracts` runtime obligation schema. The reference privacy graph
leaves marketing unselected; its marketing privacy coverage remains an open gap.

`createMarketingPrivacyBindings` selects three callables with complete enabled
owner ports; otherwise all three are null.

Evidence (historical record, 2026-11-13):

`createPostgresAcquisitionCasePort` and `createPostgresAcquisitionEvidencePort`
retain connection-string and optional pool-factory inputs. Each call uses the
existing transaction and `SET LOCAL ROLE platform_acquisition_runtime` sequence.
The real PostgreSQL witness applies the hash-checked manifest prefix through the
survey/newsletter evidence migration and invokes ports through a login granted
only runtime-role membership. The fixture owner serves setup, state inspection
and append-only trigger proof; separate runtime-role mutation assertions prove
privilege denial. Missing Docker fails that proof. No migration or
privilege change accompanies this package boundary.

The exported privacy ports and `MarketingPrivacyContributor` use local structural
types and identity's `./identity/contracts` types. Their compatibility with
identity's contributor is checked in the marketing compiler witness, keeping the
`./marketing/server` declaration closure free of identity's main entry and the
optional `pg` peer. Identity's public surface is unchanged.

## Identity import candidate

Moved to [Identity](../../packages/core/docs/guide/concepts/identity.md#contacts-principals-and-authority).

Identity depends on the declared foundation entries without changing the
artifact's rail kind. Its seven SQL files are verbatim projections at canonical
positions 11, 12, 29, 60, 67, 68 and 69. The reference dispatcher accepts a
session-binding factory for separate operator delivery; bounded browser builds
omit the admin shell. Its managed soft-account adapter binds settings assessment
regardless of bundle selection. Runtime-schema extraction retains the boundary
choice described in the [identity owner](IDENTITY.md).

For the repository OIDC recipe, run
`node tests/postgres/runOidcIdentityConformance.mjs` with the cached pinned issuer
and local prerequisites. The [recipe owner](IDENTITY.md#real-issuer-oidc-recipe)
owns invocation and teardown. The repository's
[bootstrap/prune commands](IDENTITY.md#direct-human-login) own maintenance wiring.
Callable inventories remain in the
[server API reference](../../packages/platform/api/identity.api.md) and
[browser API reference](../../packages/platform/api/identity-contracts.api.md).

Both managed contact lookups select email and fetch at most ten candidates.

Evidence (historical record, 2026-11-13):

Apply the complete direct catalogue through position 68 before enabling human
login; `sql/20261018180000_identity_operator_challenges.sql` is its exact projection.
Configure a distinct operator audience and an adopter deployment route policy:
the public policy refuses all mounted operator routes, including `me`, with
`adopter_policy_required` before input or authentication-binding construction. The reference dispatcher accepts a
session-binding factory through `createReferenceBffDispatch`; use it to compose
separate operator delivery. Caller-supplied operator handlers retain the same
policy boundary. The browser hook consumes guarded auth-port notifications rather
than signing out from a stale post-redemption check. Use the
explicit bootstrap/prune commands in the [identity guide](IDENTITY.md#direct-human-login).
The bounded reference browser builds do not mount the admin shell; application
composition must mount the provided pages and hook. First redemption activates the existing invitation and consumes the challenge in
one transaction. Live membership, not a JWT role, authorizes each request. The
cold consumer includes both identity entries and the new adapter's missing-peer
refusal; real concurrency and upgrade proof needs the complete PostgreSQL chain.

**Migration:** soft-account provisioning requires a trusted envelope: automatic
email confirmation disabled and every enabled non-email provider explicitly
declared email-verifying. Automatic signup can otherwise confirm an unconfirmed
user and issue a session to someone who merely knows the contact's address.
Pass the policy to `createSupabaseClientAuthLinkStore(client, emailTrustPolicy)`;
custom `ClientAuthLinkStore` implementations must expose `emailTrustPolicy`.
An adopter may explicitly bind `createVerifierResultOnlyEmailTrustPolicy()` when
its own trust boundary supplies the guarantee. Ensure the selected Auth installation can deliver and verify the
first-login link for an existing unconfirmed user. Run the documented joint local conformance
command after building core/platform. Existing identities, contact links,
subscription references and migration history are not rewritten.

Managed verification now requires the confirmation timestamp. Email-derived
reconcile requires an injected `emailTrustPolicy`. Managed hosts share
`createManagedEmailTrustPolicy` with `identityEmailTrustReadiness`; it reports
module `identity` using core's existing codes. Hosts retaining verifier-only
admission explicitly bind `createVerifierResultOnlyEmailTrustPolicy()`.
See the [identity policy and migration](IDENTITY.md#responsibility-and-composition)
for the empty provider allowlist, cache/deadline, 403/503 failures and the opt-in
`node tests/postgres/runIdentityEnvelopeConformance.mjs --phase email-trust` and
`node tests/postgres/runIdentityEnvelopeConformance.mjs --phase joint` prerequisites
and conformance scope. Both phases replay the committed managed chain, including
the identity capabilities forward, and prove association under the shipped managed
reference grants.
Construction and imports perform no settings read or SDK initialization.

Application composition supplies SDK clients/loaders, feature admission, redirect
policy, rate limiting, messages, sender and deployment URLs. Factories use the
foundation BFF envelope and accept the application's observed request-ID reader.
The module depends only on the declared foundation entries, without changing the
artifact's rail kind. Its schema contribution requires a host-selected inventory;
its seven SQL files are verbatim projections at canonical positions 11, 12, 29,
60, 67, 68 and 69, not an independent migration chain. The owner page maps the characterization
witnesses and records the remaining evidence.

### Operator invitations

Moved to [Identity](../../packages/core/docs/guide/concepts/identity.md#operator-invitations).

The direct pending lifecycle’s migration pin is
`20261018120000_identity_operator_invitations`, applied after the existing direct
catalogue.

The direct pending-invitation store retains the trusted PostgreSQL transaction
lane, ordered membership locks and atomic membership/audit writes. Principal
creation commits separately. Its package projection remains at canonical
position 67. The managed gateway's insert relies on the false `is_machine_actor`
default; managed pending/expiry requires a separate store and reviewed forward.

The managed identity-capabilities forward
`20261018160000_identity_service_role_capabilities.sql` grants `service_role`
SELECT(email) and INSERT(id, email, role, membership_state, membership_provenance,
membership_accepted_at) on `admin_users`. The opt-in conformance replays the
complete chain with ambient default ACLs removed and adds no fixture grant.
It does not establish managed/direct lifecycle parity.

With a fresh disposable local managed stack, set
`OPENLUP_MANAGED_CONFORMANCE_URL`, `OPENLUP_MANAGED_CONFORMANCE_SERVICE_KEY` and
`OPENLUP_MANAGED_CONFORMANCE_DATABASE_URL` (owner `supabase_admin`), then run:

```sh
npm --workspace @openlup/platform run build
node --import tsx tests/postgres/operatorInvitationManaged.conformance.ts
```

The runner refuses non-loopback endpoints, installed public schemas and existing
synthetic fixture identities. It retains fixtures; discard the stack afterwards.
Its owner connection must replay prerequisites, baseline and ordered forwards.
See the [identity lifecycle owner](IDENTITY.md#operator-invitation-lifecycle).

Evidence (historical record, 2026-11-13):

The managed chain's identity capabilities forward
`20261018160000_identity_service_role_capabilities.sql` grants `service_role`
SELECT(email) and INSERT(id, email, role, membership_state, membership_provenance,
membership_accepted_at) on `admin_users`.
The opt-in managed conformance replays the complete committed chain with ambient
default ACLs removed and adds no grant. It proves immediate activation,
repeat/concurrent recovery and revoked-member refusal under the shipped grants.
It does not establish managed/direct lifecycle parity.

## Personal data

Moved to [Personal data](../../packages/core/docs/guide/concepts/personal-data.md#personal-data-coverage).

Migration: apply the complete direct catalogue including
`20261018190000_identity_privacy_erasures` before using privacy or the updated
customer challenge store.

Reference identity and subscription-veto composition shares one direct executor
and a relation lock held through commit. Opaque retention declares lifecycle and
acquisition fields. The direct privacy receipt projection is at catalogue
position 69; it adds no grants or functions. Challenge and erasure adapters share
the transaction-held challenge relation lock. The managed capability forward
supplies existing client-link and operator permissions; conformance adds no
fixture grant or managed erasure forward.

The reference dispatcher wraps default and supplied privacy routes before
input reads and binding creation. Settings keeps exports and receipts in memory;
maintenance prunes separate operator/customer batches. Reference startup uses
`createReferenceIdentity` and `startPublicReferenceServer({ identity })` for
bundle-specific inventory and email-trust admission before listening. Direct
reconcile reads actor links; invite/remove select pending-invitation stores.
Default static/browser page sets are unchanged. See
[identity composition](IDENTITY.md#responsibility-and-composition) and
[privacy wiring](IDENTITY.md#identity-personal-data).

Evidence (historical record, 2026-11-13):

The complete direct conformance is included in
`npm test -- tests/postgres/operatorIdentityUpgrade.test.ts` from the repository
root after normal setup. A maintainer host resource broker is optional.
For managed conformance, supply the same three `OPENLUP_MANAGED_CONFORMANCE_*`
local disposable-stack settings described for operator invitations, with
`OPENLUP_MANAGED_CONFORMANCE_DATABASE_URL` set to the database owner
(`supabase_admin`) connection, then run
`node --experimental-strip-types tests/postgres/identityPrivacyManaged.conformance.ts`.
Use a fresh public schema and reset the disposable stack between proofs; the
managed privacy proof replays the committed chain without fixture erasure grants.
Replay through node-postgres omits only the psql-only pg_dump `\restrict` and
`\unrestrict` guard lines; all migration SQL remains unchanged.

Both identity entries already belong to the public export map and build output;
artifact availability does not imply registry publication or release activation.
The cold installed-artifact consumer imports both entries without optional peers,
compiles contracts without driver types, and invokes every driver-owning direct
identity adapter for its missing-peer refusal. Managed factories consume
structural clients. Server declarations compile after peer selection. Full
installed-artifact and database proof require the existing supervisor-run package
consumer command and an owned disposable database.

## Disposable identity composition

The reference application's opt-in identity shell consumes the existing
`./identity` and `./identity/contracts` exports without changing their maturity
or publishing a registry version. It reuses the customer/operator pages and
captured-delivery port, with a private local mailbox and administrator privacy
panel. Its explicit runtime must supply actual routes and readiness admission;
the shell refuses a missing composition. See the
[identity reference guide](IDENTITY.md#disposable-identity-reference)
for both-bundle commands, the committed managed grants and installation limits.

## Communications import

Reader guidance: [Compose a provider adapter](../../packages/core/docs/guide/how-to/extend/provider-adapters.md).

For adoption from `0.16.0`, follow the [0.17.0 Migration guidance](../../packages/platform/CHANGELOG-HISTORY.md#0170) (source repository)
for the complete package set, canonical SQL installation and host-owned bindings.

M04 P1 relocates the existing public implementation without changing its reference
outputs. The reference shims bind the existing renderer, egress resolver, origin
defaults, delivery-shaping policy and receipt transaction lane. The package does
not select a deployment, mount a route or schedule another executor.
`createCommunicationsContribution` requires the host's version and schema
inventory; supplied handlers, schedules, routes and ports describe only that
host's selection.

`COMMUNICATIONS_MIGRATIONS` projects the canonical units byte for byte:
comms outbox (position 2), transactional receipts (9) and communications control
plane (20), native operations (70) and account newsletter withdrawal (88). This sparse list is not a standalone migration chain. Apply the full
selected canonical prefix through its existing runner; importing the module does
not apply SQL or advertise missing managed/direct capabilities.

Browser previews retain their reference renderer, content defaults and template
policy. The Auth hook receives that same renderer through its reference shim.
The standard Auth webhook and the maintained HTTP mail provider verifiers keep their separate signature
formats and clocks; the generic helper added to `./http` replaces neither.
E2 is applied: the payment webhook module delegates these five generic helpers.
`readRawBody` is the same package function object with its original declared
`(req: VercelRequest) => Promise<string>` signature; the other four exports are
plain re-exports. The payment provider verification and its replay tolerance stay local.
The maintained mail transport, credentials, callback verification/mapping,
poll read/mapping, timeline and send-ledger adapters remain in reference source.
B1 changes only the four raw-injection guard sites in the reference delivery
adapters and the approved invoice test fixture; the concrete client and all
other vendor-directory files retain the comparison-base bytes. The neutral
`./communications` entry exposes transport/result contracts and capture without
concrete mail wiring. The platform ships opt-in vendor adapter subpaths;
default wiring includes none, and adopters choose or replace them.
The type-only `CommunicationProvider<Provider>` and `EmailMessageReadModel<Provider>`
accept host vocabulary; reference types retain their original literal.

`createGuardedEmailTransport({ providerKind, policy, send })` is the network
adapter constructor. At each send it awaits a fresh host policy, validates the
whole decision and enters the sender only for a coherent `production`,
`sandbox_direct` or `sandbox_sink` decision. The sender receives the effective
recipient and a frozen context with intended recipient, host-selected credential,
mode, reason and environment tag. It must consume that context when selecting
credentials and emitting provider metadata. The neutral entry reads no environment
and contains no provider client. Opt-in adapters consume this same guard and
host-selected context. Missing/throwing policy, unknown modes, mismatched
recipients/tags, blank credentials or unsupported fields fail with status zero,
no identifier and bounded error codes. Reasons are lower-case token codes up to
80 characters. One unadorned `local@domain.example` recipient mailbox is required;
whitespace, lists, display names and local-only domains are refused on this new
alternate-transport policy boundary.

A dropped send has no identifier or eligible sent timestamp. Package-created
capture retains ordered envelopes and synthetic identifiers; a copied capture
shape cannot establish transport admission.

`admitPolicyEnforcedEmailTransport` is the trusted host bridge for a transport
that already enforces egress internally, as the maintained reference client does.
The package registry owns its identity; this bridge performs no second routing
or credential decision. It is a composition trust boundary, not a sandbox for
host code: callers must not admit an unguarded network sender. New adapters should
use the validating constructor above. The reference default retains its original
sink/drop policy, key selection, optional payload fields, headers, signal and
result/error semantics. `createAuthEmailTransport` preserves the Auth envelope
mapping and admission; raw Auth closures are refused before their send method.
Admin/control and required-audit ordering stay at their existing callers.
No egress result authorizes a subscription-state or delivery-cycle mutation.

`processEmailObservation` accepts already authenticated, decoded and environment-admitted
input. It looks up a local send, constructs evidence only when found, applies one
observation and records best-effort telemetry. Lookup and apply failures propagate.
`runDeliveryReconciliation` polls candidates sequentially, rotates every non-404
read, and delegates consecutive failed-404 abandonment at threshold three to the
store. Rotation failure is counted without dropping delivery truth; apply failure
continues the batch. Candidate-query, read and not-found-store throws propagate.
The host classifies protocol snapshots after rotation and passes recipient/evidence
through unchanged. The existing reference domain entry points use both engines;
routes and schedules remain the same.

Neither engine writes suppression or subscription state. Both callback and poll
composition retain `communication_update_email_delivery_from_provider` as the
single durable convergence/suppression writer. These ports add no in-memory
replay authority, database store or second executor. Legacy transport identifier
fields remain compatibility residue; new ports use `messageId`.

`createCommunicationPurposeRegistry` composes immutable exact identifiers with a
mandatory `marketing` or `non-marketing` classification. Its built-ins cannot be
redeclared. Existing policy, token and newsletter schema calls keep their finite
defaults. Passing a registry to policy evaluation, token verification or
`createNewsletterIntegrationSchemas` recognizes its identifiers without granting
permission. Custom marketing purposes still require a grant and respect
suppression; built-in tester pause and permission rules stay in force.

`createRegisteredPublicPreferenceTokenPort` requires an explicit host persistence
function and passes the exact purpose and frozen classification to it. It creates
no sync event. Stock managed permission and newsletter-sync tables retain their
finite CHECKs; registering a purpose does not expand those stores. Additional
persistence and schema requirements belong to the adopter. No new purpose, table,
migration, preference UI, URL or default fan-out is installed.

`processNewsletterWebhookEvent` supplies the existing event → permission →
settlement sequence behind neutral ports. Reference HTTP admission and signature
mapping stay local. Explicit registered purposes survive permission writes;
purpose-less feedback still targets exactly the two existing marketing purposes.
Verified opt-in, suppression and replay rules are unchanged. Registered dispatch
checks the batch's purposes before provider effects and retains claim tokens,
echo and capability skips, retry behavior and counters. Sync-settled and accepted
receipts are distinct from delivered evidence. Existing job admission, binding,
leases, finish-run linkage and operator readback retain their host composition.
No shared sender pipeline is added: required audit and best-effort send paths
keep their distinct ordering and failure semantics.

`MarketingAutomationProviderPort` and `MarketingAutomationStorePort` describe
explicit scope, claim/generation fences, admission/deadlines, idempotency,
observations/history and ambiguity/backoff. The synthetic substitute-provider
conformance suite is an executable contract, not an installed worker or a remote
provider certification. Evidence carries opaque references; remote feedback does
not grant local consent. No trigger catalogue, schedule or provider activation
is supplied.

The required selection retains the moved-code witnesses and neutral package
characterization tests. The package W1 hook reader witnesses the Auth composition;
provider-specific reference test paths remain in the complete suite. The
[M04 ledger](plans/oss-m04-communications-triggers.md#verification-ledger)
records counted cases, separate boundary iterations and local timing provenance.
The clean-commit artifact gate enforces all merged caps, including the owner-read, measured limit on the complete contracts entry. Artifact admission still needs a
clean supervisor commit.
See the [M04 plan](plans/oss-m04-communications-triggers.md)
for scope, later waves and verification limits.

### Pure email content and browser rendering

`./communications/contracts` now exports `renderEmail`, the nine existing block
constructors, `guideCardBlock` and per-template content factories.
Each `create*ContentFactory` binds host-selected copy plus only the pure helpers
it uses: order-reference formatting, payment-cause wording or marketing footer.
Localized review routes remain in the reference helper.
In P3 no copy pack, brand, locale choice, environment reader, provider client or
sending policy moved into this entry. B2 adds the explicit neutral defaults below. The existing email DTOs remain its canonical types.
Reference `petName` compatibility inputs are translated to neutral `contextName`
by their existing facades. Complete subjects, preheaders, ordered blocks and
HTML/text remain byte-identical, including omitted and explicit optional fields.

Browser previews continue through those facades to contracts values only. Auth
uses its existing server hook factory with the same host renderer injection;
its inactive public content binding still refuses with 503. Standard Auth,
mail callback, integration-event and generic HTTP verification remain separate
policies with their existing raw-byte and replay behavior. No crypto refactor,
new entry, dependency or graph edge is part of P3.

The contracts conformance test compiles the complete entry with no Node types
and checks its value inventory and import closure. The cold consumer repeats the
exact inventory and renders with fetch forbidden and optional peers absent,
retaining all other consumer checks. Browser size measures every runtime export
of the built entry through `browserEntryBytes`; it never measures a tree-shaken
consumer subset. See the M04 ledger for the measured size, owner-read cap and
working-tree versus signed-candidate evidence limits.

P3's complete built contracts entry measures **5,992 B minified+gzip**;
the owner-read cap is **11,776 B**, rounded to the nearest 512 B at about
twice that measurement. Only this browser limit changes. Existing pack classes,
other browser limits and clean-candidate artifact checks remain binding.


M04 B2 adds four default factories in this same pure contracts entry:
`createInvoiceDocumentContentFactory`, `createRoleNotificationContentFactory`,
`createInquiryContentFactory` and `createOptOutContentFactory`. Each accepts an
optional complete bilingual copy replacement; each content call takes an explicit
`pl`/`en` locale. Invoice takes resolved order/document references, kind and account
URL; role takes role, operator URL and optional pending expiry. Inquiry builds
receipt/notice blocks from caller details, signoff and URL without sending or
promising a response time. Opt-out returns display strings for seven outcomes;
it verifies no token and writes no consent. Hosts own brand, locale selection,
URLs, policy and delivery.

The reference invoice adapter defaults to its byte-identical Polish output; explicit
construction locale EN maps to `/account?sekcja=orders`, while the production
composition still omits locale. All existing role outputs remain identical.
The reference opt-out page now selects Polish/EN throughout, escapes display values,
and uses neutral selected-communications/service-message wording. Its methods,
verification, purpose allowlist, durable RPC, headers and statuses are unchanged.
Generic inquiry is only a pure binding; the existing private-label sender stays
unchanged. Invoice/role gain Polish canon previews; no sender/registry activation.
See the [complete B2 expectation ledger](plans/oss-m04-communications-triggers.md#b2-changed-expectations-and-preservation)
and [default conformance tests](../../packages/platform/test/communications/contentDefaults.test.ts).
The measured B2 contracts entry is 8,210 B minified+gzip under the unchanged
11,776 B cap; this is a local built-entry measurement, not release admission.

### Native communications operations (development preview)

The server entry `@openlup/platform/communications` additionally exports
`createPostgresDeliveryReconciliationPort`, `createPostgresCommunicationSyncStore`,
`createPostgresNotificationRecipientsPort` and `createPostgresConsentEvaluator`.
Install the complete canonical manifest through position 70 before selecting
these factories. `COMMUNICATIONS_MIGRATIONS` now projects positions 2, 9, 20 and
70 plus account newsletter withdrawal at 88; it remains a sparse inventory, not an installer.
The latter changes future newsletter opt-outs only; see the
[operator upgrade statement](DATA_AND_MIGRATIONS.md#account-newsletter-withdrawal-upgrade)
for earlier opt-outs and provider/email-change limits. Missing schema/configuration
is an error, never an empty queue or an allow decision.

Each factory owns a capability-local, role-free transaction lane and lazy `pg`
pool, with `close()` for host cleanup. Only a trusted host may hold these owner
credentials. Effective PUBLIC/browser table, column and inherited privileges
cause refusal; the CREATE-only forward intentionally changes no old ACL or role.
Do not expose a factory or its database lane to browser callers. The directory
requires a verified active human operator, live communications authorization and
absence of machine authority in the same transaction as each operation.

A host registers `evidence: "network_accepted"` only after actual network
acceptance, with a unique source key and binding. Capture is never registered as
a network target. Polls and admitted callbacks call the same `applyObservation`
writer; observation-key replay must preserve the immutable fact. Readback keeps
acceptance, observed state, attempt/404 counts and abandonment separate. Only
three consecutive 404s abandon a candidate; abandonment is not failed/delivered.
Bounce/complaint writes the authoritative fingerprint's suppression atomically.
No subscription or renewal state is changed.

For newsletter sync, inject `rail: db => createPostgresOutboxStore(db)` from
`@openlup/outbox/postgres` in host composition. `db` is the current transaction,
so claim commits before I/O and rail ack and sidecar settlement commit together.
`registerWork` creates one existing-outbox identity for a source and target
binding. Successive preferences for one contact/target share the rail aggregate,
so newer work cannot overtake older unprocessed work. Configure a distinct
binding per target/provider, and exclude
`nativeSyncEventType(binding)` from generic dispatch registries. Invoke only
`runCommunicationSyncDispatch` with an explicit neutral membership provider.
The sidecar cannot claim work and has no lease or drainer. A membership settlement
records sync progress, never email delivery; remote exactly-once effects are not
promised across a process crash. There is no automatic backfill or activation.

Native consent evaluates registered P4 policy against the authoritative native
permission and persists the decision before returning its id. Admin notices need
an active source-bound notification recipient. Optional `testerPaused` reads
host-owned authoritative pause state inside that transaction; omitted means no
pause policy. The capability explicitly declares `managedFrequencyCaps: false`,
`legacyContactTouching: false`, `sendTimeFence: false`: managed 16-hour / 2-day /
4-week caps and legacy contact-touching are excluded. Evaluation does not fence a
later send against changed consent. Custom-purpose persistence remains host-owned.

The [callable reference binding](../../server/runtime/communications/communicationsLifecycleBinding.ts)
selects only `PLATFORM_BUNDLE=node-postgres` with `DATABASE_URL`; it closes pools
on success/failure and supplies no network/provider default. Existing managed
HTTP cron/UI routes retain their existing composition. See the
[B3 expectation inventory](plans/oss-m04-communications-triggers.md#b3-native-stores)
and [real-PG witnesses](../../tests/postgres/communicationsNative.test.ts).

C-compose extends the native delivery store with binding-scoped `findByMessageId`
and bounded `listEvidence({limit})` (1–100). Existing observation/replay and polling
methods retain their behavior. `registerPreference` on the native sync store
commits an authoritative denied/suppressed permission and default-purpose sync
work together; tester permission adds no marketing work. The trusted
`registerNativeSyncWorkInTransaction` helper contains the same registration SQL
used by `registerWork`; standalone input validation still precedes database entry.
This helper is a trusted host transaction seam: its caller-owned executor must
already hold the lane's safe effective privileges; the function does not check
them. Standard native sync factory transactions check
`public.communication_native_sync_state`, `public.outbox_events` and
`public.communication_recipient_consents`. The caller owns the transaction and
must commit or roll back permission, sidecar and existing-rail effects atomically.
Use a safely admitted lane; the helper grants no claim token or provider authority.

Reference composition remains outside the package: actual installed factories,
Core readiness, explicit provider ports and host-supplied schedules. Native
readback and signed-token bridges do not promise managed frequency caps, legacy
tester-source parity, a send-time fence or a full native network sender. The
opt-in browser profile adds no npm entry or UI package export.

Source contributors record notable changes in package changelog fragments;
release preparation assembles the shipped CHANGELOG. Follow the
[public contribution guide](https://github.com/openlup/openlup/blob/main/CONTRIBUTING.md#development-preview-checks).

## Invoicing contracts

Moved to [Compose invoicing](../../packages/core/docs/guide/how-to/build/invoicing.md#select-the-ports).

This extraction adds no npm package or dependency.

Eleven compatibility helpers serve host facades. `createInvoiceReversalHandlers`
retains the donor’s 10 s timeout. Native pre-send retry seconds are clamped to
60..86400, otherwise 900; `retryable:false` parks at infinity.

Evidence (historical record, 2026-11-13):

The seller read takes an order ID or null for an unscoped claim, including
corrections: it reads current host configuration before the next claim, never per
duty. The separate seller-forward SQL freezes first-claim seller using
`revisionRef` as the wrapper revision; P7 owns host composition under the
[invoicing phase obligations](plans/oss-m09-invoicing.md#phase-obligations).
Compatibility stores bind provider selection at construction. The structural
native store instead accepts provider selection per claim and persists the first
provider on the duty.

Seller, fiscal-verification, policy-decision, policy-receipt and download-ticket
reads distinguish transient `unknown`
from missing bindings, empty receipts and denied ownership. Artifact absence
retains exact scoped `evidence`. Unknown policy decisions record no receipt.
Artifacts retain opaque durable references and proof; URLs/download bytes remain
transient. Download authorization precedes fetch; PDF type/size/signature validation
precedes M04 send. Delivery retains local order/document and provider identities,
nullable client/source facts and any known receipt after a lost local acknowledgement.
Settlement retains the provider document reference and retry delay for managed
pre-send backoff. Native takes `p_evidence.retrySeconds`: a whole number of seconds
clamped to 60..86400, otherwise 900; `retryable:false` parks at infinity.
The structural store leaves delivery unsupported unless its optional host envelope projection is bound.
For uncertain sends, native passes
`p_receipt` NULL and retains a non-null receipt hint in `p_evidence`; managed
passes the hint as the provider message ID.
Provider acceptance does not prove inbox delivery. Uncertain send never authorizes
blind repeat send. Clearance is observation only, with
`not_submitted`, `pending`, `rejected`, `accepted`, `not_required` and `unsupported`
kept distinct; no submission or country-specific mapping is installed.

Inspect the [contract](../../packages/platform/test/invoicing/contracts.test.ts)
and [carrier fit](../../packages/platform/test/invoicing/portFit.test.ts) witnesses.
These declarations install no worker, native store, SQL, provider, scheduler or
subscription writer. Physical delivery and renewal money never depend on invoice
availability; the later durable-duty executor must preserve that independence.

`runInvoiceAdapterConformance(subjects)` is independent of a test runner. Each
subject supplies selected provider ports, a descriptor, offline fixtures and a
write counter over every injected transport. Supported issue and correction need
issued fixtures and, when recovery is declared, issued replay fixtures. Each
supported write also needs a recovery-required fixture that returns unknown
without a write, or unsupported when recovery is undeclared. When recovery and
readback are both declared, each unknown recovery fixture needs a readback
fixture expecting unknown for the same full identity. Correction additionally
needs a mismatched-parent recovery result of refused or unknown without a write.
For every issue or correction fixture with `recoveryLookupRequired === true`, a
write-counter increase or an issued result with `replayed === false` requires
`operations.recovery.supported`, `operations.readback.supported` and
`operations.exactAbsence.supported`, plus a readback fixture for the same full
identity expecting exact complete absence. Any readback fixture for that identity
expecting unknown or unsupported forbids that write or create, even if an absence
fixture also exists. When recovery is undeclared, every recovery-required fixture
must return a non-issued result without changing the write counter.
Declared readback needs found/unknown fixtures and, when exact absence is declared,
exact scoped absence. Unsupported methods and read-only operations must not write. Optional
artifact, clearance, settlement and registry support needs host-owned positive
fixtures. Declared settlement needs two recorded fixtures with distinct itemRef
and equal providerRef, batchRef and providerPaymentRef; they must return distinct
settlementItemRefs. Distinct payout items cannot reuse one receipt. Results and proofs are
checked for identity, scoped absence, closed fields and synthetic sensitive
sentinels; adapter exceptions become a fixed failure code. Returned evidence
contains only subject/provider references and case names, never result payloads.
Use [the conformance witnesses](../../packages/platform/test/invoicing/adapterConformance.test.ts)
for offline examples. Fixtures and counters are adapter-owned assertions, not
remote attestation, PostgreSQL atomicity proof or fiscal certification.

### Invoicing read helpers

Moved to [Compose invoicing](../../packages/core/docs/guide/how-to/build/invoicing.md#deliver-documents).

The delivery-settlement behavior is carried by CTL-M09-3's 191000 pin. The
managed facade retains its existing key and diagnostic bytes. The reference
history shim translates legacy columns without changing its public DTO.
Reference operator HTTP/UI diagnostics use closed codes and omit provider free
text; runbook URLs remain host inputs.

Pre-send settlement validates whole-number retry seconds clamped to 60..86400;
absent/invalid seconds use 900. Projection or document-read exceptions use the
same generation-based backoff as the job: 300 seconds per attempt, capped at 3600.

Evidence (historical record, 2026-11-13):

The reference payout facade uses the injected item-capable port when supplied;
otherwise its accounting control port preserves donor calls and aggregate counts.
The package returns an `items` receipt list: a legacy batch/payment receipt reused
across item scopes becomes `conflict` / `identity_mismatch`; processing continues
with no extra write. Package counts accept only item-level receipts, so they may
differ from legacy host counts. An item-capable recorder/resolver produces distinct
`recorded` receipts. Neither count establishes payment success. The
[native delivery contract](../../tests/postgres/invoicingDelivery.test.ts) exercises
store/job results and durable state against the pinned SQL, including retry and
terminal outcomes; it makes no live transport or inbox-delivery claim.

### Captured native invoices

Moved to [Compose invoicing](../../packages/core/docs/guide/how-to/build/invoicing.md#capture-sandbox-invoices).

Captured native invoice composition uses the existing native accounting/invoicing
tables on the qualified-v2 chain.

Evidence (historical record, 2026-11-13):

No managed adapter behaviour, database object or grant is changed. The existing
qualified runtime table permissions suffice; the host owns the driver,
authentication, route for the email's account-documents URL and schedules.
The [installed/native witness](../../tests/postgres/invoicingCaptured.test.ts)
exercises the packed entry through a restricted login; it is local sandbox proof,
not live-provider or hosted qualification.

## OMS composition

Moved to [Compose order management stores](../../packages/core/docs/guide/how-to/build/oms-stores.md#choose-the-imports).

### Native OMS and support stores

Moved to [Compose order management stores](../../packages/core/docs/guide/how-to/build/oms-stores.md#choose-the-imports).

Reference facades re-export the package's account/support error constructors.

Evidence (historical record, 2026-11-13):

The [installed-store witness](../../tests/postgres/m19StorePromotion.test.ts)
selects compiled tarball exports and the complete `qualified-v2` chain with a
restricted runtime login; [identity assertions](../../tests/postgres/m19StorePromotionIdentity.test.ts)
cover reference facades and refusal constructors. Their presence is not a passing
qualification result; the [task record](plans/oss-m19-g12.md) carries executed proof.

## Account and support contracts

Moved to [Compose account and support services](../../packages/core/docs/guide/how-to/build/account-and-support.md#choose-the-imports).

The reference recipe rejects a route whose callable is not selected with
`account_support_entry_operation_required`; service, port and route aliases
return the same guarded function.

The reference-only `commerceOwner` option accepts the host-built M11 result
over bound checkout/recovery and ATP callables through a local structural type.
R5b does not construct M11 or import its adapters. The reference host includes
account/ATP requirements in the M11 schema, matches enablement/readiness and
supplies the existing registry as `commerceRegistry`. It forwards
`commerceOwner.services` directly, avoiding a second M11 binding and duplicate
native operations. No package export, contract, ATP allocator or effect installer
changes; see the [runtime recipe](RUNTIME_AND_SELF_HOSTING.md#opt-in-disposable-subscription-reference).

The reference `createM12AccountReadBinding` specializes the facade to existing
customer ports; it registers no route or default selection. The
[bounded task record](plans/oss-m19-g11.md) retains proof and the remaining
delivery boundary.

The [native persistence owner](../../packages/platform/README.md#native-account-persistence-reads)
owns host inputs and section refusals. The
[billing recipe](../../packages/platform/README.md#customer-billing-profiles-and-frozen-invoice-buyers)
owns the invoice freeze point and privacy contributor.

Evidence (historical record, 2026-11-13):

Import types from `@openlup/platform/account-support/contracts`. The five envelopes
are `AccountReadPort`, `Customer360ReadPort`, `SelfServiceCommandFacade`,
`OperatorRecoveryCommandEnvelope` and `InvoiceAccessPort`.
`InvoiceAccessPort` matches M09's order-scoped `InvoiceHostPorts['accountHistory']`
read and download-authorization seam. It adds no invoice archive, PDF transport
or storage. Owner refusal unions, optional fields, readonly fields and nullability
are preserved by local structural declarations with executed owner-equality tests.
Command declarations and capability flags are proposed composition boundaries;
R1 implements account-read delegation and diagnostics; R4 adds the explicit operator selection below. Hosts supply trusted
context and selected owner implementations. A capability declaration never grants
authority or establishes managed/native parity.

The [module design](plans/oss-m12-account-support.md) records R1's unchanged slice,
verification boundary and unimplemented later phases. It grants no activation,
release or adopter cutover authority.

### Bounded account and support reads

Moved to [Compose account and support services](../../packages/core/docs/guide/how-to/build/account-and-support.md#bind-reads-to-the-customer).

Current-parcel and commerce recovery rules retain their existing owners.
M09 owns signed correction totals, document/parent lineage and PDF access.

`readAccountSnapshot` requests 50 subscription rows before visibility filtering
and exactly 20 recent orders at the store. `projectCustomer360Snapshot` keeps
the newest 80 audit events in chronological order.

Evidence (historical record, 2026-11-13):

`createM12AccountReadSelection` and `createM12SupportReadBinding` are separate,
explicit-host, default-off reference factories. Missing account/history/invoice
and managed support selections refuse with `host_binding_required`. Selected
native support reads use the existing scoped PostgreSQL driver; authorization
is the facade authorization, runs once before scope entry, retains real machine
governance, and scopes close after
success, null and failure. The read views accept typed strings and data from a
host. Inline order expansion reads its summary only. No route is mounted; source
route adoption remains pending P7, and no archive, detail/activity panel,
subscription/recovery/contact/link controls or activation is supplied by R2.
The support binding's independent diagnostic selection exposes `searchDiagnostics`,
`history` (segment read) and `overview` with the existing typed versions, filters
and cursors. Authorization and machine-read governance precede diagnostic scope
entry; the trusted actor supplies `operatorId`. No journey scope is required.

`createPaymentMethodComposition(port)` adapts the generic `MethodSetupPort<Handoff>`
from M07 setupMethod to paymentMethod.execute(userId, request); its principal guard
is supplied by the facade. Ready/unsupported/replayed values remain unchanged.
Collection never redeems or charges. A45/A46 token handlers remain in reference
source. Native repair authorization/scheduling is a
[registered follow-up](plans/oss-m12-account-support.md#follow-up-register).
The [default-off recipe](RUNTIME_AND_SELF_HOSTING.md#opt-in-disposable-subscription-reference)
selects no browser route; native start and browser key retention remain
R5 limits.

### Operator recovery selection

Moved to [Compose account and support services](../../packages/core/docs/guide/how-to/build/account-and-support.md#select-operator-recovery).

`createM12OperatorRecoveryBinding` selects the package exports only with
`enabled: true` and complete ports. The reference
`AccountSupportRecoveryStatus` displays partial results and capability refusals;
neither reference file mounts a route.

Evidence (historical record, 2026-11-13):

`createPostgresOperatorAuthority` takes an injected transaction executor. Pause,
ordinary paid-up resume and 3–60-day slide delegate to M10 in the support SQL
transaction. On the qualified runtime they take the term-line row lock through
the shared lock and conflict completion forward, which admits no actual update.
`NativeOperatorSubscriptionResult` carries the optional actual
`OperatorOwnerReceipt` and capability refusal
`operator_subscription_authority_unavailable`; the managed result stays unchanged.
Native email, phone and account link refuse before opening SQL. A subscription
`change_shipping_address` command with `newAddress` calls the bounded
`customer_support_change_shipping_destination` routine. Select it explicitly with
host authorization and the complete native catalogue installed; construction
mounts no route. The command checks its idempotency key and expected version,
updates the future destination and records its audit and confirmation effects
atomically. That destination command provides no saved address book; the separate
[`shipping` port](../../packages/platform/README.md#saved-customer-address-book) supplies owned address-book storage. Its saved IDs can be selected for future
subscription delivery through `createPostgresDestinationPort(...).selectSavedShippingAddress`.
That owned selection retains subscription-event replay precedence; new typed
commands retain their existing fingerprint rule and clear a saved selection on
success. See [saved subscription selection](../../packages/platform/README.md#saved-subscription-shipping-selection).

## Marketing SEO and content slots

Moved to [Compose SEO and content slots](../../packages/core/docs/guide/how-to/build/seo-and-content-slots.md#choose-the-imports).

Evidence (historical record, 2026-11-13):

`ContactContent`, `LegalDocumentContent` and `PrivacyProcessorDisclosure` are
application-supplied content contracts exported as types by both entries.
The contact contract reuses `OrganizationFacts`.
`contactContent` produces the support email and company lines in legal-name,
address, registration-identifier and optional registration-authority order.
Identifier label/value pairs retain their supplied order and use ` · ` between
entries; supplied blank lines are retained. `legalDocumentContent` preserves
the document title, introduction, ordered title/body sections and optional
last-updated text. Processor disclosures are types only. The package supplies
no document wording or processor inventory and does not validate content or
imply any legal outcome. The cold installed consumer exercises the runtime
entry and compiles its content types.

## Native bundle admin writes

Moved to [Compose native bundle writes](../../packages/core/docs/guide/how-to/build/bundles.md#choose-the-imports).

Reference error paths re-export the same constructors, preserving `instanceof`
and the existing SQLSTATE mapper.

Evidence (historical record, 2026-11-13):

The source witness `tests/postgres/m19BundleWriteExport.test.ts` exercises the
installed tarball on qualified-v2 through a restricted runtime login. Its local
result is recorded in the task record, not a hosted or provider qualification.
The identity witness is `tests/postgres/m19BundleWriteIdentity.test.ts`.

## Native fulfillment preparation and captured dispatch

Moved to [Compose native fulfillment](../../packages/core/docs/guide/how-to/build/fulfillment.md#choose-the-imports).

The reference host facade keeps its prior result shape and delegates services
and methods to the package binding.

Evidence (historical record, 2026-11-13):

Use only synthetic data in captures. This factory has no transport, provider
credentials or durable ledger. Its accepted outcome asserts no physical packing,
label creation, handoff or arrival. It exposes dispatch only; label operations,
observation verification, readback, stock/product synchronization, cancellation
and pickup operations remain unavailable. The existing conformance runner checks
these declared capabilities using host-owned offline fixtures. Restricted-role
PostgreSQL evidence is separate from offline conformance and installed-tarball
proof. Native list/detail reads still return `host_binding_required`; they wait
for destination and reservation facts in a separate change.

## Native operator shipment commands

Moved to [Compose native fulfillment](../../packages/core/docs/guide/how-to/build/fulfillment.md#bind-operator-commands-and-reads).

Install the complete selected catalogue through
`20261110230000_operator_shipment_commands.sql`.

## PostgreSQL checkout recovery tokens

Moved to [Recover abandoned checkouts and payments](../../packages/core/docs/guide/how-to/build/checkout-recovery.md#issue-a-recovery-token-for-an-admitted-checkout).

PostgreSQL computes and stores exactly `order.created_at + 24 hours`, retaining
sub-millisecond precision and refusing an elapsed deadline. Only the SHA-256
hash reaches storage.

## Checkout recovery waves and expiry

Moved to [Recover abandoned checkouts and payments](../../packages/core/docs/guide/how-to/build/checkout-recovery.md#schedule-reminders-and-expire-abandoned-checkouts).

The legacy integer SQL entry retains defaults of 3600/72000 seconds for
first/final offsets, 86400 checkout seconds, 2592000 recovery seconds and 900
activity seconds.

The [forward](../../db/platform/migrations/20261110100000_checkout_recovery_waves.sql)
retains existing function headers/ACLs. New routines revoke PUBLIC/browser
execution; only selected entry points grant service-role execution. The scoped
`commerce_checkout_recovery_wave_delivery_authorize` wrapper preserves the
automatic-reminder ACL without admitting operator/buyer flows. No raw table grant
is added.

Existing payload wave labels `1` and `20` identify first/final content; offsets
remain separate scheduling inputs.

Evidence (historical record, 2026-11-13):

The [PostgreSQL witness](../../tests/postgres/checkoutRecoveryWaves.test.ts)
exercises legacy and both qualified runtime profiles. It does not establish a
running scheduler, browser journey, network delivery, real-provider prepared
storage or expired-order recreation. At that historical checkpoint, the native payment attempt store
was sandbox-only; the appended prepared provider store now supplies durable preparation. Starter bindings and recreation consumers are separate
obligations.

## Operator order payment links

Moved to [Recover abandoned checkouts and payments](../../packages/core/docs/guide/how-to/build/checkout-recovery.md#give-an-operator-a-payment-link).

Use the complete native migration chain, including
[`20261110110000_operator_checkout_links.sql`](../../db/platform/migrations/20261110110000_operator_checkout_links.sql).

For a neutral demonstration use `operatorLifetimeMs: 3600000` and
`recoveryWindowMs: 86400000`; bind the same recovery window at redemption.

Evidence (historical record, 2026-11-13):

The [PostgreSQL witnesses](../../tests/postgres/operatorCheckoutPaymentLink.test.ts)
exercise legacy and both qualified runtimes; the [command characterization](../../packages/platform/test/commerce/operatorCheckoutPaymentLink.test.ts)
retains bounded failures and effect ordering. These sources do not establish
hosted, browser or provider qualification.

## Customer checkout recovery entry points

Moved to [Recover abandoned checkouts and payments](../../packages/core/docs/guide/how-to/build/checkout-recovery.md#add-customer-recovery-entry-points).

Apply the complete native chain through
[`20261110115000_customer_checkout_links.sql`](../../db/platform/migrations/20261110115000_customer_checkout_links.sql).

Supply `lifetimeMs` explicitly (a neutral example is `86400000`, the maximum).
Expiry is order creation plus that lifetime. Configure the buyer port’s
`lifetimeMs` and `sendBucketMs` with neutral examples `86400000` and `600000`.
Within a bucket, outbox uniqueness admits one event and its token atomically.

Evidence (historical record, 2026-11-13):

Route buyer events (`buyerRequested: true`, source `buyer_payment_link`) through
the port's scoped `authorize(eventId, claimToken)` and the existing checkout
recovery email handler. The gate binds the active claim, order, client and exact
live bearer. Buyer-requested mail bypasses the fresh-payment-session courtesy
deferral; missing/paid orders still refuse. Automatic waves retain their own
authorizer and activity rule. Recipient resolution, localization, transactional
transport, HTTP registration, account navigation and the embedded-browser control
remain host bindings. The [PostgreSQL witnesses](../../tests/postgres/customerCheckoutLinks.test.ts)
cover legacy and both qualified runtime generations; they establish no hosted,
browser or real-provider qualification.

## Checkout recovery inspection

Moved to [Recover abandoned checkouts and payments](../../packages/core/docs/guide/how-to/build/checkout-recovery.md#inspect-a-link-before-showing-recovery-controls).

Evidence (historical record, 2026-11-13):

The additive migration introduces nullable recovery-root and immediate-predecessor
order links, restrictive unvalidated self-FKs and a unique non-null predecessor
index. Historical links stay null. No backfill, writer or new traversal/tie-break
policy is included. See the [PostgreSQL witness](../../tests/postgres/checkoutRecoveryInspection.test.ts)
and [composition characterizations](../../packages/platform/test/commerce/checkoutRecoveryInspection.test.ts).

## Expired checkout recreation

Moved to [Recover abandoned checkouts and payments](../../packages/core/docs/guide/how-to/build/checkout-recovery.md#recreate-a-technically-expired-checkout).

The buyer-snapshot preparation change is carried by
`20261110280000_checkout_recovery_buyer_snapshot.sql`. It backfills no existing
order.

Evidence (historical record, 2026-11-13):

On a downstream failure the service attempts abandoned-checkout cancellation,
then unstarted-promotion cleanup. `createPostgresExpiredCheckoutCompensation`
uses the existing guarded native cancellation and promotion-release owners; its
unstarted check shares the order lock and transaction with cancellation. It
never cancels through dispatched or uncertain payment evidence. A stock refusal
returns `order_changed`; a compensated replacement retains its lineage and does
not permit a sibling. The [PostgreSQL witnesses](../../tests/postgres/checkoutRecoveryRecreation.test.ts)
cover legacy and both qualified runtimes.

| Profile limit | Current refusal | Closure |
| --- | --- | --- |
| Native provider attempt persistence and recovery evidence | Available after installing the complete chain through `20261114100000_payment_provider_attempt_store.sql` and explicitly recording the provider lifecycle; missing local evidence remains unavailable | Use the provider persistence and evidence readers described in [the data owner](DATA_AND_MIGRATIONS.md#module-catalogues-and-installed-histories). Provider journey activation and method authority require their own composition. |

## Atomic checkout payment guidance

Moved to [Recover abandoned checkouts and payments](../../packages/core/docs/guide/how-to/build/checkout-recovery.md#show-payment-recovery-guidance-from-one-snapshot).

The read probes 101 attempts and returns at most 100. It probes 33
evidence members per attempt and admits at most 32. Native observation records
and truth/readback source envelopes have an 8,192-byte bound.

Evidence (historical record, 2026-11-13):

Raw `activationState`, `subscriptionStatus`, `paidAt` and `hasExactGap` come from
the same statement. The native activation owner stores exactly `provisional`,
`active` and `compensated`; the reader accepts those states. Handler-level
PostgreSQL witnesses cover opt-in, legacy responses, read failure, revocation and
an activated checkout without falling back from the atomic read. A provisional declaration is not relabelled as a subscription
or mandate state. Its raw paid gap remains available without fabricating a
mandate-wait display. Guidance is inspection only and authorizes no new payment.
The host owns rendering and route mounting. See the
[PostgreSQL witnesses](../../tests/postgres/checkoutPaymentGuidance.test.ts) and
[package characterizations](../../packages/platform/test/commerce/paymentRecoveryGuidance.test.ts).

## Checkout token payment

Moved to [Recover abandoned checkouts and payments](../../packages/core/docs/guide/how-to/build/checkout-recovery.md#retry-payment-with-a-recovery-token).

Evidence (historical record, 2026-11-13):

The [PostgreSQL witnesses](../../tests/postgres/checkoutRecoveryPay.test.ts)
exercise replay, retries, method binding, terminal races, renewal/token refusals,
verified settlement and hold composition on legacy and both qualified runtimes.
[Package characterizations](../../packages/platform/test/commerce/checkoutRecoveryPay.test.ts)
cover the neutral port and injected hold rules.

## Exact inline checkout retry

Moved to [Recover abandoned checkouts and payments](../../packages/core/docs/guide/how-to/build/checkout-recovery.md#retry-the-exact-failed-attempt-inline).

Evidence (historical record, 2026-11-13):

The [inline PostgreSQL witnesses](../../tests/postgres/checkoutInlineRecovery.test.ts)
cover competing tabs/nonces, CAS and terminal races, fresh-process replay,
replacement cookies, method actions, holds and renewal refusal on all three
runtimes. [Package characterizations](../../packages/platform/test/commerce/checkoutInlineRecovery.test.ts)
cover authority-first behavior, result validation and polling fallback. Host
route mounting, starter UI and browser journeys remain separate.
