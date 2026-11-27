# Platform package reference

Status: maintainer page: how to change OpenLup. Reader guidance lives in the [OpenLup guide](../../packages/core/docs/guide/README.md); sections marked "Evidence" are frozen historical records.
Audience and purpose: adopters and maintainers composing domain modules from
`@openlup/platform` and inspecting the `@openlup/core` grouped schema probe.

This page holds the deep per-module reference documentation kept out of the
published npmjs READMEs so each package README stays concise and well within the
48 KiB npmjs cap. The [package README](../../packages/platform/README.md)
remains the package entry point.

The `/migrations` entry also provides the complete installed PostgreSQL catalogue
through `createPlatformPostgresMigrationRunner`. See the self-contained
[installation recipe](../../packages/platform/README.md#install-the-portable-postgresql-schema).
It reuses the existing runner and exact canonical SQL history; qualified host
profiles remain explicit. The package factory requires `installation`; only the
repository facade defaults to legacy. No checkout is required.

## PostgreSQL quote price reads

The four reads preserve complete list, exact base, exact legacy subscription and
policy histories.

Evidence (historical record, 2026-11-13):

The existing `createPostgresCommercePromoDataPort(runtimeExecutor)` from
`@openlup/platform/promotions` supplies five advisory evaluation methods. Two
named limits remain: device evidence is not persisted and the device routine
returns constant false; redemption counts do not aggregate mirror families.
Neither limit establishes eligibility or full parity. Hosts must not infer those
capabilities from the factory's presence. See
[native promotion evidence](#promotions) and the
[restricted PostgreSQL characterization](../../tests/postgres/commercePriceAuthorityRead.test.ts).

## Application file upgrade

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

`./identity` provides server identity services; `./identity/contracts` supplies browser-shareable contracts.
The host-only `createPostgresContactClientRegistrar` resolves guest purchase
contacts and refreshes optional defaults only on unlinked rows; its result grants
no account access and linked rows remain untouched.
See [guest contact resolution](../../packages/core/docs/guide/concepts/identity.md#guest-checkout-contact-resolution)
for host quotas, internal result fields and erasure boundaries.
Importing identity does not activate an adopter’s composition.
Installed exports alone do not mount routes or establish host readiness; the
application must verify its selected identity composition and capabilities.
See the [identity recipe](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/concepts/identity.md#contacts-principals-and-authority) for composition, migrations and operator invitations.

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
[bootstrap/prune commands](../../packages/core/docs/guide/concepts/identity.md#direct-human-login) own maintenance wiring.
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
[privacy wiring](../../packages/core/docs/guide/concepts/personal-data.md#personal-data-coverage).

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

`EcommerceEventsPort` and its closed event/request types live in the contracts
entry. The Node communications entry supplies validation and the explicit
PostgreSQL source projection/outbox-handler composition. The first catalogue
covers paid orders, nonfinancial refunded status, token-free checkout eligibility
and four subscription lifecycle facts. Install the complete migration chain,
select an account/environment and a fixed live cutoff, and keep commerce and
export claims in separate invocations with disjoint allowlists. No route,
schedule, provider effect or historical backfill is installed by importing them.
See the [event source and dispatch contract](https://github.com/openlup/openlup/blob/main/docs/platform/CANONICAL_CONTRACTS.md#ecommerce-event-export)
at the source revision matching this package for retention, authority and recovery.

The Node-only communications entry includes `runCommunicationsAdapterConformance`
for adapter-owned offline email and marketing-sync fixtures. It returns passed
case labels or throws a sanitized finding with a fix and recheck instruction.
This fixture proof does not qualify live providers or consent-push lifecycles.
See the [extension-kit recipe](https://github.com/openlup/openlup/blob/main/docs/platform/ARCHITECTURE_AND_EXTENSIONS.md#run-an-adapter-conformance-check)
at a source revision matching the installed export.

The sparse `COMMUNICATIONS_MIGRATIONS` inventory includes the portable account
newsletter withdrawal forward; install the complete canonical chain. Account
opt-out denies only `marketing_newsletter` and preserves suppression. Opt-in
changes the preference without granting consent. Earlier opt-outs need the
[operator upgrade statement](https://github.com/openlup/openlup/blob/main/docs/platform/DATA_AND_MIGRATIONS.md#account-newsletter-withdrawal-upgrade),
which also documents the provider-sync and email-change limits.

For the native PostgreSQL composition, install the complete migration chain and
use `createPostgresEcommerceEventProjection` from the public communications entry.
Supply one `binding`, immutable `liveSince`, `now`, local `resolveTarget`, and
`withTransaction` that commits or rolls back the entire callback on one database
connection. Supply `currency: { code, exponent, provenance }` from the host's
selected settlement profile and currency owner. Call `initialize` with the
approved new-fact cutoff, then `project(limit)` in a bounded postcommit job.
Do not call it as a new prerequisite of payment commit.

Bind `createPostgresEcommerceEventHandler` to the same binding/transaction owner,
the selected adapter's `events` port, clock and current `authorize` callback.
Register that handler in its own outbox invocation with only
`ECOMMERCE_EXPORT_EVENT_TYPE`; run commerce handlers in a separate invocation and
lease. The worker owns dispatch/claim retries; the projector owns source handoff.
Supply the selected finite platform vocabulary as `knownEventTypes`; known
unclaimed facts do not become handlers, and an unknown type still refuses.
The adapter's synchronous authority callback must also check the exact retained
duty and current subject immediately before HTTP. A missing target records a
visible refusal and cannot block unrelated subjects.

An unknown/dispatching receipt stays retained. Stop and quiesce the export lane,
inspect the privileged matching receipt/digest, obtain provider evidence, then
call `reconcilePostgresEcommerceEvent` with that exact digest, binding, evidence
reference and explicit resolution. An identical retry additionally requires
qualified deduplication and current authority; it preserves the original request.
The helper refuses live claims and mismatched evidence. Keep raw projections
and recovery snapshots out of logs. This operator action needs application-owned
authentication and never fabricates account qualification.

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

<a id="native-communications-operations-development-preview"></a>

### Native communications operations

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
[public contribution guide](https://github.com/openlup/openlup/blob/main/CONTRIBUTING.md#contribution-checks).

## Invoicing contracts

See [invoicing composition, duties and read helpers](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/how-to/build/invoicing.md).

`@openlup/platform/invoicing` exposes `readInvoiceCapabilities`;
`invoicing/contracts` contains types only. Host selection is explicit and default-off.
Frozen facts, correction recovery, exact absence, owed duties and host-only fiscal,
artifact, delivery, payout and owned-history seams are described in the
[invoicing reference](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/how-to/build/invoicing.md#select-the-ports).
The contract entry supplies no executor or activation.
`createNativeUnsupportedInvoicePorts` supplies inert typed refusals for every
host, store and provider seam. `runInvoiceAdapterConformance` checks adapter-owned
offline fixtures; its sanitized evidence does not establish live fiscal readiness.

Issue helpers in `invoicing` preserve claim/preflight/projection/fresh-money/
create/fenced-finalize order. Hosts bind compatibility payloads, seller/date/tax
policy, captions, event descriptors and key scopes. Canonical and legacy line
checks share the unchanged originating allocation; handoff helpers register no job or
executor. Eight issue/line/payment/handoff cases join the existing package smoke
selection. Continuity cutover and activation remain separate.

If your invoice flow can issue during a provider outage, block issuance when
`readInvoicePaymentEvidence` returns `provider_payment_identity_mismatch` in
`providerEvidence.unavailableReason`. The helper reports `providerStatus: "unknown"`
for an identity refusal and `provider_read_failed` for an outage. Custom readers
can throw an error with the `PaymentReadbackIdentityMismatch` code from the
`@openlup/platform/payments/contracts` type.

Correction and reversal workers preserve durable identity, recovery and fenced
outcomes through host callbacks. The reference host requires a conforming
correction bridge; the legacy vendor method stays unselected. Reversal handlers pass
through the RPC action (`voided`, `correction_requested`, `corrected`, `no_invoice`). The required package
selection includes correction/reversal witnesses in `test/invoicing/contracts.test.ts`.
See the [invoicing design](https://github.com/openlup/openlup/blob/main/docs/platform/plans/oss-m09-invoicing.md#p3-correction-and-reversal-boundary)
for managed migration and reconciliation limits.

See the [M09 forward owner](https://github.com/openlup/openlup/blob/main/docs/platform/DATA_AND_MIGRATIONS.md#m09-invoicing-forward-design-and-control-approval) for the registered managed-correction limit and follow-up.

`createPostgresInvoiceStore` uses a caller-owned structural executor for native
owed duties, split fact leases, claims and fenced issue/correction results.
Missing host facts refuse before writes; clearance remains host work. Delivery
requires an explicit host envelope projection and M04 transport. `INVOICING_MIGRATIONS` separates native child-document and managed
base-row correction storage. Install the complete native catalogue, not its
seven sparse byte-identical SQL assets. The local-only Postgres adapter consumes
this store without claiming fiscal parity or registering a worker. The
[invoicing architecture owner](https://github.com/openlup/openlup/blob/main/docs/platform/ARCHITECTURE_AND_EXTENSIONS.md#invoicing-contracts)
describes reversal recovery, capture faults and cutover fencing.
`collectInvoiceDuties` and `createIndependentInvoiceDutyBinding` collect retained
paid/handoff duties through separately committed store phases. Hosts invoke them
outside payment and fulfillment work; missing facts remain owed. The pinned
payment-decoupling SQL is a sparse catalogue projection, requiring the full P4
native chain. See the architecture owner for continuity and activation limits.

`runNativeInvoiceIssueJob` supplies the native create/readback binding over
explicit local/fresh money and provider ports. Fresh non-ready results settle
before returning; stale results write no failure. No scheduler or default
composition is registered. Operator DDL/ACL limits of the unchanged M07 readback
remain registered in the architecture owner.

The invoicing read side adds `runInvoiceDeliveryJob`, `assertInvoicePdf`,
`invoicePdfFilename`, `syncAcceptedInvoiceDocuments`,
`syncInvoicePayoutSettlements`, `resolveInvoiceDocumentHistory` and
`createInvoiceReadModel`. Hosts supply authorization, storage, M04 transport,
terminal/backoff callbacks or the native store, and safe native history projection. See the
[read-helper recipe](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/how-to/build/invoicing.md#deliver-documents).

`createInvoiceServices` and `createInvoiceContribution` compose the existing
helpers through `/invoicing`, with explicit selection, default-off and readiness
before execution. Native collection, issue, delivery, document/payout sync and
history use their module implementations; host facades may bind factories where
transport or query projection is host-owned. No executor is installed.
`claimInvoiceSellerRevision` selects a seller before leasing. The optional native
store seller binding and managed wrappers persist its first-ever claim revision;
legacy fallback and forward-only migration limits are owned by the
[M09 migration section](https://github.com/openlup/openlup/blob/main/docs/platform/DATA_AND_MIGRATIONS.md#m09-invoicing-forward-design-and-control-approval).

OMS read projections are optional. Omitting the host health classifier preserves the original unprojected empty health snapshot (`ok`, no reasons or evidence IDs); it does not evaluate provider health. The reference composition injects its existing classifier and evidence readers.

### Captured native invoice composition

`@openlup/platform/invoicing/postgres` supplies an explicitly enabled
captured sandbox provider, append-only non-fiscal PDF artifacts and a PostgreSQL
owned invoice-history/ticket reader. The host passes a restricted runtime
executor and authenticated principal UUID. See the
[invoicing reference](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/how-to/build/invoicing.md#capture-sandbox-invoices)
for composition, refusal and sandbox limits. Construction installs no route,
schedule or provider connection.

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

Captured native invoice composition uses the existing native accounting/invoicing
tables on the qualified-v2 chain.

Evidence (historical record, 2026-11-13):

No managed adapter behaviour, database object or grant is changed. The existing
qualified runtime table permissions suffice; the host owns the driver,
authentication, route for the email's account-documents URL and schedules.
The [installed/native witness](../../tests/postgres/invoicingCaptured.test.ts)
exercises the packed entry through a restricted login; it is local sandbox proof,
not live-provider or hosted qualification.

### Native OMS and support stores

Reference facades re-export the package's account/support error constructors.

Evidence (historical record, 2026-11-13):

The [installed-store witness](../../tests/postgres/m19StorePromotion.test.ts)
selects compiled tarball exports and the complete `qualified-v2` chain with a
restricted runtime login; [identity assertions](../../tests/postgres/m19StorePromotionIdentity.test.ts)
cover reference facades and refusal constructors. Their presence is not a passing
qualification result; the [task record](plans/oss-m19-g12.md) carries executed proof.

## Account and support contracts

See [account reads, commands, events and operator recovery](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/how-to/build/account-and-support.md).

The command transcription includes confirmed order now/reactivation, structured
pause/cancel survey and save-offer carriers, and an optional slide reason.
Legacy survey/offer strings remain strings. Native order history projects a
terminalized settlement intent as `cancelled` rather than payment pending.
No new operator action, retention discount or browser binding is installed.

After the package-editor forward is installed, native
`createPostgresAccountReadSources` maps `subscriptions.composition_constraint`
into the existing account `sizeConstraint` field. This gives the classic editor
its stored nominal-plan seed; constraint meaning remains host-owned. Line prices
still come from the frozen native subscription lines. Managed/custom account
sources and existing self-service command bindings keep their own contracts.
The [subscription owner](ARCHITECTURE_AND_EXTENSIONS.md#subscription-contracts)
describes editor composition, quote acceptance and future renewal terms.

`./account-support/postgres` exposes the existing
`createPostgresCustomerSupportJourneyPort`. Supply a restricted runtime connection
and a trusted operator ID; close the port when its host scope ends. The native
search, summary, detail and snapshot reads preserve their existing codecs and
refusals. The existing recovery and lead-absorption commands keep their limits;
subscription actions and contact correction still refuse by name. The separate
`./account-support/read-contracts` entry exposes the existing portable-client and
Customer 360 read schemas with CSP-safe initialization; it selects no Node driver.
`./account-support/contracts` remains type-only. Authentication, machine-read
governance and optional diagnostic ports remain host composition. No diagnostic
store or HTTP route is installed by these entries.
`applied_from_next_parcel` leaves the frozen parcel unchanged; show that scope to
the customer.

`@openlup/platform/account-support` supplies `createAccountReadFacade`
and the unchanged account-read diagnostic helpers. Inject account and order owner
ports; delegation preserves their arguments, receivers, results, nulls and thrown
failures. Authentication, authorization and private profile/market projection stay
with the host. Importing this entry selects no driver or capability.

`account-support/contracts` is type-only and browser-safe. It declares account,
Customer 360, self-service command, operator recovery and invoice-access envelopes
with explicit capability flags. These declarations do not install their services.
The [account/support reference](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/how-to/build/account-and-support.md#choose-the-imports)
owns the available boundary and later-phase limits.

R2 adds `readAccountSnapshot` with the two-stage fan-out and a store-level recent
20-order request, stored-money order history/detail, Customer 360 projections
and M09 invoice history/PDF delegation. `createInvoiceAccess` checks the requested
document against the owned account/order history before resolving its ticket or
reading PDF bytes; foreign or unknown documents return `{ kind: "denied" }`.
Standard UUID owner/order/document identifiers match regardless of letter case,
without rewriting echoed values. Opaque host references remain case-sensitive.
Select pricing, captured line
presentation, private extensions and fulfillment evidence through typed host
ports. Missing evidence stays unknown; owner refusals retain their distinctions.
The default-off reference selections and host-fed read views are unmounted.
Native Customer 360 uses the existing authorized PostgreSQL support reader;
account/history/invoice drivers still require explicit host selection.
Subscription pointer enrichment preserves optional nullable `paymentMethodKind`:
selected-empty evidence is null, while unread evidence is omitted. Reference
line presentation explicitly picks the declared display keys before projection.

`createCustomer360ReadFacade({ authorize, journey, summary, diagnostics })`
requires `authorize(): Promise<boolean>` before every method's source read.
Refused callers receive `{ kind: "denied" }`; authorized delegates preserve
arguments, results, nulls and thrown failures. The reference binding supplies
that authorization once per call, before opening either support scope.

The [account/support reference](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/how-to/build/account-and-support.md#choose-the-imports)
owns the available R1 boundary and later-phase limits.

R3 adds `createSelfServiceCommandFacade({ context, capabilities, ...lanes })`,
returning `SelfServiceCommandFacade` with required host capabilities and every
managedSubscription, nativeLegacySubscription, subscriptionControl, typed/raw,
profile, paymentMethod, commerce and recovery output lane. Input lanes are optional.
Unselected methods return `{ supported: false, refusalCode }`; paymentMethod uses
the host paymentMethodSetup refusal by identity, commerce uses commerceRecovery,
and other lanes use a frozen host_binding_required refusal. Every lane guards
the principal; typed/raw lanes require a supplied clientId equal to context.clientId.
The trailing `ControlSnapshot = unknown` generic retains the control snapshot type.
Native legacy routing preserves
explicit pause and ownership before bundle quote validation. Owner results,
refusals and nulls retain identity. Supported paymentMethodSetup requires a
paymentMethod lane; supported commerceRecovery/configuredPurchase require commerce.
Supported genericBundleCommands/commandBoundReceipts require a selected subscription
command lane. Missing required lanes refuse customer_self_service_lane_configuration_required.
`encodeNativeSubscriptionCommand`, `decodeNativeSubscriptionPreview` and
`createNativeSubscriptionDriver` retain the raw owner protocol and apply key;
apply never previews. `createPaymentMethodComposition` adapts generic M07
setupMethod to paymentMethod.execute without owner imports. Native repair is a
[registered follow-up](https://github.com/openlup/openlup/blob/main/docs/platform/plans/oss-m12-account-support.md#follow-up-register).
The default-off reference binding mounts nothing; browser key retention and
native start remains unselected; profile editing has the explicit native port below.

R4 adds `createOperatorRecovery`, `createManagedOperatorAuthority`,
`createPostgresOperatorAuthority`, `operatorAuthorityCapabilities`,
`moveIdentityForEmailCorrection`, `executeOperatorAccountLink`, `linkThenApply`
and `ACCOUNT_SUPPORT_MIGRATIONS`. The host injects its transaction/RPC and identity
ports, verified human operator and recovery-path policy. Recovery token generation
and SHA-256 hashing use the runtime Web Crypto API without a Node import; the
host may still inject its opaque-token generator. Managed email admission
and claim precede identity mutation and settlement. Native lifecycle commands
delegate to M10, with actual optional owner receipts and named unavailable
subcases. Link-then-action reports a completed link separately when the second
command refuses, applies from the next parcel or fails. The reference binding is default-off and unmounted;
no import provisions authority or activates a route.

R5a adds `createAccountSupportBindings` and `createAccountSupportServices` here,
and `createAccountSupportContribution` in `/composition`. Supply already bound
R1–R4/owner operations for one explicit managed/native graph, host capabilities
and a readiness observer. Each distinct callable receives one guard shared by
its service, port and route aliases; each entrance re-observes readiness. Disabled
construction calls no observer. Refusals are `disabled`, `schema_unknown` and
`schema_unsatisfied`; owner results and thrown failures pass through unchanged.
A null selected operation remains a required port without an executable binding.
The separate injected commerce record uses `commerce(key, ...args)` and returns
`{ kind: "unsupported", code: "host_binding_required" }` for a null record/member.
The reference host may select real M11 checkout/recovery, ATP and existing effect
descriptors by supplying its already-built selection through `commerceOwner`
and its existing registry through `commerceRegistry`. R5b does not construct M11
or import its adapters; the host supplies the complete account/M11/ATP schema
and matching enablement/readiness. Keep capability flags unsupported until
their owner callables are bound. This adds no package export or owner import to
account-support contracts. One M11 result is forwarded without rewrapping its
guarded services; unknown stock, unsupported options and handler outcomes retain
their owner meaning. Contribution descriptors install no routes, handlers,
schedules or workers. See the
[reference recipe](https://github.com/openlup/openlup/blob/main/docs/platform/RUNTIME_AND_SELF_HOSTING.md#opt-in-disposable-subscription-reference)
for the host's schema and transport obligations.

### Customer account events and mutations

See [profile and event semantics](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/how-to/build/account-and-support.md#preserve-profile-and-event-semantics).

`createPostgresCustomerAccountMutationPort` binds a trusted principal/client scope,
`createCustomerAccountMutationSchemas` with adopter validation values, and a clock.
Select it as the self-service facade's `profile` port. The same port supplies
`requestInvoiceCorrection` and metadata-only `readEvents` (latest 20). Bind
`createCustomerAccountMutationHandlers` to host authentication, copy and BFF
responses. Imports mount no route; the starter editors are separate work.

Profile names collapse whitespace; empty/null clear and omitted fields preserve.
The schema factory refuses policies that widen its limits: keys 8–180, nonempty
names 2–80, correction reasons 8–500, at most 20 requested fields of 1–80, and
optional nonempty notes up to 500 characters. Adopters may narrow those limits.
The phone policy binds the calling prefix and requires nine local digits,
preserving local/prefixed input extraction. Email is rejected. Replay uses the
recorded profile-event key and returns current state. Profile update and event append are
separate query commits: append failure leaves the profile write committed, and a
retry without a recorded event may mutate again. Do not wrap both in a host
transaction or claim concurrent exactly-once mutation.

Install the complete selected prefix through `20261110120000_customer_account_events.sql`.
The new ledger has client cascade, occurred-time index, enabled RLS and closed
owned routines. Runtime EXECUTE grants go only to service_role; its table access is
client-column SELECT for absorption census, with the exact SELECT policy.

Payloads contain personal data. Register `createAccountEventPrivacyContributor`
in the existing identity registry and require `account-support`: supply a trusted
payload reader and explicit retain/unresolved policy. Missing coverage is exported
as unavailable. Missing reader or unresolved policy refuses erasure. With a
reader configured, an explicit retain assessment leaves payloads in place and
appears in the erasure receipt without checking that reader's export availability;
identity field clearing and cascade do not erase them. No default registration,
deletion or retention period is installed. The finite connected-store profile carries exact
rows, following the customer communication-preference event ledger. See the
[data owner](https://github.com/openlup/openlup/blob/main/docs/platform/DATA_AND_MIGRATIONS.md#customer-account-event-data).

### Native account persistence reads

See [owned account reads and their refusal boundaries](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/how-to/build/account-and-support.md#bind-reads-to-the-customer).

`@openlup/platform/account-support` supplies
`createPostgresCustomerOrderHistoryReadStore`, `createPostgresAccountReadSources`
and `readPostgresCustomerAccountClient`. Supply a host-authenticated principal
and client pair plus a server-authorized query executor on the restricted runtime
lane. Every native query rechecks that pair, including order/subscription
companion reads. The factories create no connection, route or default binding.
Order presentation and invoice summaries remain selected owner ports.

The detail translator uses captured quote money and native promoted-line
allocations. Historical summaries retain the recorded total and currency, and
the store's line reader retains recorded line amounts. Detail without captured
money refuses `native_account_order_money_unavailable`: required tax, discount
and shipping fields cannot express absence. It invents no zero amounts, backfill
or current prices. Native observations supply tracking links; external tracking
IDs alone carry no invented URL. Existing replacement selection is retained.
`readPaidActivationGaps(orderIds)` on both native reader factories returns an
owned order companion keyed by order ID, with `orderId` and `paidAt`. Use it on
the order view; no provisional subscription association is invented. The shared
order-summary DTO remains unchanged.

`createPostgresAccountReadSources` implements native subscriptions, accepted line
prices, blockers, pause windows, method/stock-wait evidence, delivery alignment
and dunning/cycle action states. Extension and next-charge policy are required
host inputs. Saved addresses (available through the selected shipping port), billing profiles, payment/delivery preferences and
account events are optional explicit sources: each missing section throws
`host_binding_required` with its section name. The same limit applies to the
private-profile view. These refusals do not prevent independent reads of owned
profile identity, orders and native subscription evidence. The aggregate account
snapshot requires every selected section; a missing section refuses that call.
No new native profile table or empty-array success is supplied.

For existing actor routines, bind `createPostgresCustomerSubscriptionSnapshotPort`
or `createPostgresCustomerNewsletterPreferencesPort` to a verified actor gateway.
They validate the existing snapshot/newsletter DTOs and retain SQL errors and
null ownership results. Their DTO types are available from the isolated
`account-support/contracts` entry. Newsletter read and withdrawal are available;
a saved true flag exposed as granted without evaluator evidence throws
`host_binding_required` for `newsletterConsent`. Complete purpose choices and
grants remain named refusals until the separate consent change lands. No true
command is advertised. No managed constructor or managed behaviour changes, and
no release is implied.

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

The [native persistence owner](#native-account-persistence-reads)
owns host inputs and section refusals. The
[billing recipe](#customer-billing-profiles-and-frozen-invoice-buyers)
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
source. Native repair authorization and scheduling use recorded token context,
the authorized retry rung and the dispatch fence; later automatic rungs read the
current usable method. Historical tokens without recorded recovery context are refused.
The [default-off recipe](RUNTIME_AND_SELF_HOSTING.md#opt-in-disposable-subscription-reference)
selects no browser route; native start and browser key retention remain
R5 limits.

### Operator recovery selection

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
[`shipping` port](#saved-customer-address-book) supplies owned address-book storage. Its saved IDs can be selected for future
subscription delivery through `createPostgresDestinationPort(...).selectSavedShippingAddress`.
That owned selection retains subscription-event replay precedence; new typed
commands retain their existing fingerprint rule and clear a saved selection on
success. See [saved subscription selection](#saved-subscription-shipping-selection).

## Marketing SEO and content slots

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

Reference error paths re-export the same constructors, preserving `instanceof`
and the existing SQLSTATE mapper.

Evidence (historical record, 2026-11-13):

The source witness `tests/postgres/m19BundleWriteExport.test.ts` exercises the
installed tarball on qualified-v2 through a restricted runtime login. Its local
result is recorded in the task record, not a hosted or provider qualification.
The identity witness is `tests/postgres/m19BundleWriteIdentity.test.ts`.

## Native fulfillment preparation and captured dispatch

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

Install the complete selected catalogue through
`20261110230000_operator_shipment_commands.sql`.

## PostgreSQL checkout recovery tokens

PostgreSQL computes and stores exactly `order.created_at + 24 hours`, retaining
sub-millisecond precision and refusing an elapsed deadline. Only the SHA-256
hash reaches storage.

## Checkout recovery waves and expiry

The legacy integer SQL entry retains defaults of 3600/72000 seconds for
first/final offsets, 86400 checkout seconds, 2592000 recovery seconds and 900
activity seconds.

The [forward](../../db/platform/migrations/20261110100000_checkout_recovery_waves.sql)
retains existing function headers/ACLs. New routines revoke PUBLIC/browser
execution; only selected entry points grant service-role execution. The scoped
`commerce_checkout_recovery_wave_delivery_authorize` wrapper preserves the
automatic-reminder ACL without admitting operator/buyer flows. No raw table grant
is added.

For an unpinned episode, the live `checkout_recovery_reminders` setting or its
fallback supplies the schedule. A pinned episode retains its stage labels,
hours and offsets. See [Install reminder stages and hours](../../packages/core/docs/guide/how-to/build/checkout-recovery.md#install-reminder-stages-and-hours).

Evidence (historical record, 2026-11-13):

The [PostgreSQL witness](../../tests/postgres/checkoutRecoveryWaves.test.ts)
exercises legacy and both qualified runtime profiles. It does not establish a
running scheduler, browser journey, network delivery, real-provider prepared
storage or expired-order recreation. At that historical checkpoint, the native payment attempt store
was sandbox-only; the appended prepared provider store now supplies durable preparation. Starter bindings and recreation consumers are separate
obligations.

## Operator order payment links

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

Evidence (historical record, 2026-11-13):

The additive migration introduces nullable recovery-root and immediate-predecessor
order links, restrictive unvalidated self-FKs and a unique non-null predecessor
index. Historical links stay null. No backfill, writer or new traversal/tie-break
policy is included. See the [PostgreSQL witness](../../tests/postgres/checkoutRecoveryInspection.test.ts)
and [composition characterizations](../../packages/platform/test/commerce/checkoutRecoveryInspection.test.ts).

## Expired checkout recreation

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

Evidence (historical record, 2026-11-13):

The [PostgreSQL witnesses](../../tests/postgres/checkoutRecoveryPay.test.ts)
exercise replay, retries, method binding, terminal races, renewal/token refusals,
verified settlement and hold composition on legacy and both qualified runtimes.
[Package characterizations](../../packages/platform/test/commerce/checkoutRecoveryPay.test.ts)
cover the neutral port and injected hold rules.

## Exact inline checkout retry

Evidence (historical record, 2026-11-13):

The [inline PostgreSQL witnesses](../../tests/postgres/checkoutInlineRecovery.test.ts)
cover competing tabs/nonces, CAS and terminal races, fresh-process replay,
replacement cookies, method actions, holds and renewal refusal on all three
runtimes. [Package characterizations](../../packages/platform/test/commerce/checkoutInlineRecovery.test.ts)
cover authority-first behavior, result validation and polling fallback. Host
route mounting, starter UI and browser journeys remain separate.

## HTTP runtime and security contract

See [HTTP admission and request handling](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/how-to/operate/self-host.md#declare-http-admission).

The Node-only `./http` entry builds a request handler around host-supplied route
tables, dispatch, entrypoint loaders, deadlines, security-header policy, robots
content and static-asset reader. Its request order is fixed: apply security
headers, handle canonical trailing-slash redirects and declared entrypoints,
dispatch the BFF and scheduled routes, refuse unknown API paths, then apply
host-declared redirects and static-document rules. The package does not infer
which application routes are authorized or supply deployment-specific header
policy.

Buffered requests retain the exact raw bytes for signature verification while
also exposing parsed JSON to handlers; the platform CSP-report entrypoint and
explicitly marked stream-first handlers retain their live stream instead. Body
size/deadline boundaries remain explicit. Static serving returns 404 for a
missing asset, serves only declared route documents or an enabled SPA fallback,
and leaves route admission to the host. These helpers define the HTTP adapter
contract; they do not certify a deployed route or security policy.

## Marketing contracts

See [marketing handlers, analytics and consent](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/how-to/build/marketing.md).

The browser data-layer factory defaults to analytics-consent-only admission. Hosts may opt in with `consentPolicy: "independent"` to admit events with either stored analytics or marketing cookie consent. The explicit `consentPolicy: "host-authorized"` mode also admits observations when no purpose is granted, solely for hosts that authorize limited consent-aware transmission and enforce route and per-tag gates. Both nondefault modes keep consent updates tied to each stored category; `pushAnalyticsConsentUpdate(false)` denies both. The host must gate every tag by its own purpose, and may allow denied-state transmission only for explicitly authorized consent-aware tags. The factory does not inspect tag behavior or minimize event payloads; the host must authorize every admitted event and its data. Queue admission never authorizes storage or grants a purpose. In nondefault modes update(true) publishes stored flags and update(false) publishes all denial; neither switches the admission policy or fences routes. Queue admission does not prove delivery or attribution.

`./marketing` provides acquisition address references, historical case projections,
list/count reads, portable prelaunch list/detail schemas, idempotency keys, survey submission/evidence/list schemas and
newsletter consent events/responses. Reference compatibility shims forward the
same schema objects and load the reference validation wrapper before package
schemas. The marketing runtime entry configures the shared Zod instance in
jitless mode before constructing schemas, preserving CSP-safe initialization
for direct imports as well as reference facades, like the pricing, catalog and
communications entries. The type-only `./marketing/contracts` entry has no
runtime initialization. The rich prelaunch DTO and case submit/transition schemas remain application-owned
and are excluded from the browser entries. The shared
`acquisitionOpaqueReferenceSchema` lets those retained contracts reuse the exact
reference syntax. No entry registers a route automatically.

`./marketing/contracts` exports only types. Explicit acquisition DTO shapes are
checked against the runtime schema inference by an executed TypeScript equality
witness. The tester case port exposes list, get, active count and close; the app
uses the server-only compatibility port for its retired methods. Evidence ports retain survey submission,
survey listing and consent application. Port types are also forwarded through
the runtime entry, following the commerce boundary. Both entries forward research schemas or types from the compatibility
owner, `@openlup/core/marketing/research`; runtime schemas retain object identity.
Tester case locale remains `en|pl`, matching its persisted constraint; partner
inquiry SQL retains `und`. Widening it requires
a separate migration. Historical wire values remain unchanged.

The source and built entries have browser graph proofs. The root test runner
selects `test/marketing/`; the installed consumer checks both public entries,
compiles typed usage and refuses deep imports. Kiosk and research reference
contracts/ports continue to consume the core export. The app owns its admin
response client and host composition.

`./marketing/server` owns acquisition case handlers, list/count and prelaunch
list/detail factories, survey evidence submit/list and consent application,
research submit/admin handlers and managed survey orchestration without loading
`pg`. Select `./marketing/server/postgres` for the three PostgreSQL port factories
after installing the existing optional `pg` peer. Hosts inject the BFF responder,
authorization and binding resolvers. Direct case reads receive the host bundle
predicate at their original guard; prelaunch and evidence dispatch stays in the
host. Notification HTML and subject are injected separately, preserving
HTML rendering before the subject clock read. The reference owns retired
route refusals, raw signed consent ingress and notification copy. PostgreSQL
SQL, role selection and transaction/pool handling remain unchanged. The
server-only compatibility command types do not expose retired admission schemas.

The partner lifecycle uses these same entries: `./marketing` exports the strict
`partner_acquisition_v1` case/list/transition and inquiry submit schemas;
`./marketing/contracts` exports their DTOs and `PartnerAcquisitionPort`;
`./marketing/server/postgres` exports `createPostgresPartnerAcquisitionPort`.
Partners retains domain and data ownership. The factory accepts an explicit
`connectionString`, opens its pool lazily, and runs submit/list/transition through
`BEGIN → SET LOCAL ROLE platform_acquisition_runtime → routine → COMMIT`.
It preserves normalization, original command receipts, quota effects, descending
cursor tuples and version fences. The host validates wire input, selects the
neutral list view and authorizes operators before binding. The direct adapter
does not enforce administrator membership; its SQL checks actor UUID presence.

Install the complete selected [source catalogue](https://github.com/openlup/openlup/blob/main/docs/platform/DATA_AND_MIGRATIONS.md#partner-acquisition-data)
before using the factory. The four existing partner SQL units are present in
all three source plans; the npm package's sparse SQL assets do not constitute a
complete partner installer. R1 adds no SQL, grants, route activation or host
binding. The reference catch-all router has an empty route table; source BFF
leaves alone do not establish serving endpoints. Host routing, authorization,
legacy drain, environment selection, connection cache and pool disposal remain
application-owned.

`closed_won` is a partner pipeline fact. It creates neither a customer identity
nor marketing consent, provider notification or managed CRM transition. Rich
managed inquiry/admin contracts stay separate. The strict submit schema accepts
`openlupInternalCheck`; a host using another sentinel must map it explicitly at
its compatibility seam. Current forms admit country `OTHER` and leading-zero
phones that direct SQL refuses; this contribution preserves those refusals.

Partner personal-data export/erasure is unavailable, with
resource duties recorded by the [Partners owner](https://github.com/openlup/openlup/blob/main/src/domains/partners/README.md).
Existing marketing privacy-contributor coverage must not be read as partner
coverage. Append-only receipts and audit are retained; nonempty acquisition
state remains outside supported store transfer. The package contract, public
counterpart/producer and real PostgreSQL witnesses freeze these limits. The
PostgreSQL witness packs the current artifact, compiles both declaration modes,
and executes its default factory against a disposable full native catalogue;
it establishes no provider or hosted qualification.

Analytics facts share these browser-safe entries. `createNoopAnalytics` implements
Core's existing analytics port; deployment and advertising defaults remain inert.
`AnalyticsEventMap<StepName>` retains the host's literal step vocabulary, with
`string` as the neutral default. Private transport ownership fields and envelopes
remain host extensions. Types are forwarded type-only by `./marketing/contracts`.

`createAnalyticsDataLayer` owns loader readiness per instance and accepts the host's
browser/storage access, consent key and change event, `consentSignalNames`, event
prefix, container reader and deployment callback. `consentSignalNames` supplies
one `analytics` wire name and the ordered `advertising` wire names. Without it,
no consent command is pushed and optional event admission returns false, even
with browser access, a container and stored consent; deployment attempts remain
independent. Consent commands seed default before update and
use array-like arguments; advertising grants read marketing consent at push time.
By default, update commands carry the caller-supplied analytics decision and
optional events require the stored analytics flag. With
`consentPolicy: "independent"`, updates additionally require each
purpose’s stored flag, and optional events accept either stored analytics or
marketing consent. With `consentPolicy: "host-authorized"`, optional events are admitted even before choice or after refusal, while updates still require each purpose’s stored flag. Optional event admission in every mode requires a configured container and configured signals. Hosts must independently fence private routes and unauthorized tags. The host owns
authorization and must not use this helper to create consent; stored flags are
admission inputs, not consent authority.
An explicit all-denial update denies every signal. Sinks are attempted independently with failure
isolation and no replay of observations made before consent. Admission booleans
mean synchronous local acceptance only, never delivery or business acknowledgement.

`createAnalyticsRoutePolicy` requires public paths, redirect sources and all
sensitive-path sets. Its optional-route predicate preserves broad eligibility;
deployment URL sanitization admits exact public paths and safe campaign values.
`projectPaidPurchase` consumes only structural paid-recap facts, preserving
allocation/grouping, the item cap and ordered suppression reasons without an
ambient currency policy. `selectMarketingHistoricalConsentTime` selects exact
native chronology only after host authorization, without changing the local
grant. The reference retains its narrower checkout-kind admission and all wire
names. [Purchase equivalence](https://github.com/openlup/openlup/blob/main/src/checkout/machine/purchasePayloadEquivalence.test.ts)
and the package analytics witnesses pin these boundaries.

`createAnalyticsContextHandler` in `./marketing/server` accepts a required BFF
responder, enable reader, persistence resolver, access-token reader, trusted-subject
resolver, capability mint/hash functions, historical cookie name and `clientIdField`.
The host supplies the client-id wire field name through `clientIdField`; the strict
request also keeps `granted` and `explicitGrant`. Grants require a client
id and existing revoked contexts require an explicit new grant for replacement.
Only token hashes reach persistence. Enrollment uses only the server-verified
subject, and invalid bearer grants refuse before writes. Cookie attributes and
method/flag/origin/schema refusal order are preserved. The host owns flag and
RPC names, gateway authority, route mounting and observability. Persistence
operations must reject on failure; null persistence refuses as unavailable.
There is no default persistence, portable SQL or reference route for this handler.
An `active` result is a local context fact, never delivery, and telemetry context
failure never gates commerce. The [context witness](https://github.com/openlup/openlup/blob/main/packages/platform/test/marketing/analyticsContext.test.ts)
exercises the factory through synthetic host bindings.

`./marketing` also provides browser-safe JSON-LD serialization and graph builders,
route URL/hreflang helpers, an ordered head descriptor and plain contact/legal
projections. Applications supply identity, origin, routes, locales, images and
content; the descriptor is plain data for a host head manager. The type-only
`./marketing/contracts` entry exports shared organization facts and contact,
legal-document and privacy-processor shapes, also forwarded as types by the
runtime entry. The package supplies no document wording, processor inventory or
content policy. The [marketing recipe](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/how-to/build/seo-and-content-slots.md#choose-the-imports)
owns the mechanics and installed-artifact proof.

## Marketing composition

See [selecting marketing operations and privacy owners](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/how-to/build/marketing.md#describe-the-selected-operations).

`./composition` exports `createMarketingContribution`, an inert descriptor for
the `marketing` capability's `./marketing`, `./marketing/contracts` and
`./marketing/server` entries, with a runtime dependency on `identity/contracts`
for obligation validation.
Supply already-bound operations and host schema requirements. Ports, routes and
triggers share the supplied functions; null ports remain required for Core
readiness, and handlers retain only registration descriptors. Duplicate handler,
schedule or route identities refuse. Construction invokes no callable and
installs no worker, route or schedule. See the
[composition contract](https://github.com/openlup/openlup/blob/main/docs/platform/ARCHITECTURE_AND_EXTENSIONS.md#contributions-seams-and-readiness)
for the host admission boundary.

`./marketing/server` also exports `createMarketingPrivacyContributor` and
`createMarketingPrivacyBindings`. Explicit enablement and both complete owner
ports select one contributor; its `exportPersonalData`, `assessErasure` and
`eraseOrRetain` callables can be passed directly to `createMarketingContribution`.
Missing ownership makes coverage unavailable and erasure unresolved. Identity
owns assessment ordering, subscription vetoes, receipt replay and transaction
rollback; the marketing fence runs only during `eraseOrRetain`. Provider request
acceptance never proves deletion. The reference leaves marketing unselected,
so its marketing privacy coverage remains an open gap. See the
[privacy composition recipe](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/how-to/build/marketing.md#choose-the-import-boundary).

The contributor and binding declarations use identity contract types and local
structural interfaces compatible with identity's `PersonalDataContributor`.
They do not reference identity's main entry; `./marketing/server` compiles without
`pg` or `@types/pg`. Select `./marketing/server/postgres` explicitly for those ports.

## Commerce contracts

`./commerce/server` also exports `createPostgresCheckoutRecoveryTokenPort` for a
trusted host's already admitted order. Inject a dedicated transaction lane with
effective service-role privileges. The port supports contacts without a principal,
stores only token hashes and computes expiry as order creation plus 24 hours;
the shared `expiresAt` argument cannot choose a deadline. New checkout links
preserve earlier links of the same order until expiry or payment. Pending
renewal-cycle orders are refused. Inspection preserves initial subscription
mode and cadence from stored quote/activation facts, normalizes consumed links
for paid confirmation, and grants payment continuation only through validation
of an active pending order. It sends no mail and performs no settlement. See the
[recovery recipe](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/how-to/build/checkout-recovery.md#issue-a-recovery-token-for-an-admitted-checkout).

`./commerce/server` exports `createPostgresCheckoutRecoveryWaves`.
`./composition` supplies `createCheckoutRecoveryWaveJob` and
`createCheckoutRecoveryWaveHttpEntry`; `./communications` supplies
`withCheckoutRecoverySendEvidence`. Apply the complete migration chain before
selecting them. Reminder waves atomically mint distinct links without revoking
older checkout links. Pending initial purchases remain eligible; renewal-cycle
orders refuse. Successful or recent active payment evidence suppresses nudges.
A final wave that follows a first wave requires a confirmed first-wave receipt bound to its event,
template and selected delivery profile, independently of outbox completion.
Skipped, disabled, ambiguous and failed sends do not create that evidence.
The existing recovery email handler remains the consumer.

`./commerce/server` exports `createAdminCheckoutPaymentLinkHandler` and
`createPostgresOperatorCheckoutLinkStore`. The host supplies the verified active
human administrator session, order snapshot/commercial validation, responder and
positive `operatorLifetimeMs` / `recoveryWindowMs` configuration. The session
supplies identity; request identity fields refuse. Native SQL checks the existing
active operator authority and refuses machine principals and renewal-cycle orders.

The operator command commits admission, revokes every prior same-order checkout
link, inserts its token, optionally queues the existing transactional recovery
email, then records its outcome. Separate writes retain the acknowledged failure
stage. Customer/service issuance remains nonrevoking, so a later such link
coexists with the operator link. Concurrent operator revocations can both finish
before either insert; both resulting links then remain live. Payment-case
recovery is separate. Copy returns the token without email; email returns an
explicit queued result only after durable per-token handoff. Expiry is the earlier
configured deadline; an elapsed deadline returns `order_not_recoverable` without
issuing a token. The operator UI and expired-checkout recreation require separate
host composition. See the [operator recipe](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/how-to/build/checkout-recovery.md#give-an-operator-a-payment-link).

`./commerce/server/postgres` also exports
`createPostgresCommercePriceAuthorityReadPort(executor)`. Allocate it once per
request and pass it to `createConcurrentCommercePriceAuthorityPort` from
`./pricing`. It reads complete active price-list and exact unit-entry histories,
plus the selected context's complete subscription-policy history. UUID demand
waves are deduplicated and chunked at 500; result rows are never truncated.
Matching keys use canonical UUID values; query arguments and returned identifiers
keep their original spelling.
Raw histories and failed promises are shared only within that request, with
caller-owned copies. The existing authority selects half-open effective windows,
validates policy digests and refuses ambiguity; the reader never chooses a newest
winner or substitutes a fallback after a failed read. Supply the restricted
runtime executor; the reader changes no role, grants, configuration or data.

`./commerce/server/postgres` exposes the existing native
`createPostgresCommerceOmsPort`, `createPostgresCommerceOmsControlPlane`,
`createPostgresProviderExceptionHealPort` and `createPostgresCommerceReturnsPort`.
Supply an executor using the installation's restricted runtime login. These are
store bindings: holds, exact release, unpaid cancellation, completed
external-refund marking and return request/approve/reject. Control-plane reads
remain the reduced `control_plane_v1` projection. Rich OMS reads, notes, address
correction retain their existing refusal. Replacement requests use the optional
explicit replacement binding, which can be supplied by
`createPostgresFulfillmentOperatorPort` from `./fulfillment/native`. Returns allow one line per order item per request, with quantity capped at the
ordered quantity. Returns record intent; they do not receive, restock or execute a refund. The host authenticates
and authorizes each operation. The native operator resolver accepts an existing
Commerce operator whose UUID is either an active control principal or an active
human `admin` membership with no control row of any state. A human distributor,
revoked member or admin without a Commerce row does not resolve. No authority is
provisioned by the resolver. Human hosts must enforce admin-only admission and
resolve again before every command and replay; the existing machine path is
unchanged. The owner provisions a Commerce row for each human admin and never
deletes it; withdraw human access by revoking membership. Deletion would set
`commerce_order_holds.created_by` to NULL, making a human fulfillment-exception
hold eligible for automatic release. This existing FK hazard is not changed.
See the [composition recipe](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/how-to/build/oms-stores.md#choose-the-imports).

With the complete catalogue through `20261110200000_operator_order_commands.sql`,
unpaid cancellation locks the current payment aggregate and refuses in-flight,
captured or indeterminate payment before writing one operator audit and releasing
the order's held purchase reservations. Late captures remain review-required.
Manual external-refund marking accepts paid orders only and records status without
a payment-provider call, refund notification or accounting reversal event. Existing
object metadata keeps its keys; other metadata is retained under `previousMetadata`
before the command writes its top-level source.
Genuine refund sources retain their event duties. Neither operation changes an
active subscription's lifecycle or schedule.
With the complete catalogue through `20261110210000_return_request_decisions.sql`,
fresh return requests accept paid or fulfilled orders owned by the authenticated
customer. Replay normalizes key/note whitespace, UUIDs, line order and defaults.
Hosts declare a subset of the database's stored reason set. Codes outside the
stored set receive a clean command refusal. New line SKUs use a trimmed supplied value, then the
order-item snapshot SKU, then `unknown`. Historical NULL SKUs mean not recorded;
historical receipts replay against their stored fingerprints. Trimmed key aliases
are resolved before creation; a unique matching receipt replays its own ID, and
ambiguous matches receive the uniform refusal without changing historical rows. Partial approval
requires an amount. Approved/rejected decisions each emit one intent event;
requests emit none. These commands do not receive goods, restock or execute refunds.

For native v1 destinations, use `./commerce/server/destinations` with the complete
native SQL installation. Authorize parent reads, use opaque references and bind
checkout and dispatch explicitly. Share a transaction between the shipment reader
and dispatch enqueue.
Addresses, phone numbers and identifying references persist. Address-change
events retain optional reasons in their top-level and nested payloads. The port
provides no destination-row export or erasure. Use the separate
[saved-address port](#saved-customer-address-book) for the mutable book. The
confirmation outbox is durable and native mail dispatch needs a host binding.

For experimental v2 ingress, discover native readiness with
`destinationV2Capabilities`, then parse and apply the host address policy. Managed
hosts support v1 checkout and saved addresses. Fresh v2 destination issuance
requires an installed native writer. Use the v1 address book for saved addresses.
Follow the
[destination validation guide](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/how-to/build/customize-the-starter.md#validate-a-checkout-destination).

`./composition` exports the inert `createCommerceContribution` for the installed
commerce entries and selected callables. Duplicate descriptor identities refuse;
the [composition recipe](https://github.com/openlup/openlup/blob/main/docs/platform/ARCHITECTURE_AND_EXTENSIONS.md#contributions-seams-and-readiness)
and [reference binding](https://github.com/openlup/openlup/blob/main/docs/platform/RUNTIME_AND_SELF_HOSTING.md#opt-in-disposable-subscription-reference)
describe host readiness, one executor per operation and native recovery limits.

`./commerce` stays browser-safe. `./commerce/server` is the separate Node-only
entry for checkout engines, handlers, stores and adapters. It exports
`tryCompensate` and `CheckoutCompensationPort`: release the selected order's
reservations, attempt unstarted-promotion cancellation, then cancel the abandoned
order only when promotion cleanup did not succeed. Existing keys, reasons,
warning messages and swallowed cleanup failures are preserved. The reference
facade delegates to the same function; composition still owns the cleanup ports.
The package boundary test bundles the browser entry without Node built-ins or
the server subtree, and the cold consumer exercises installed compensation.
Starter declaration types are inferred from the `createStarterOfferGuard`
binding signature; the declaration interface stays internal to the engine.

The Node-only entry owns the checkout admission/quote/resume/failure sequence,
neutral command adapter, runtime and one paid-order saga. Composition injects
HTTP schemas/responder, quote and persistence ports, subject/metadata projections
and the existing prepared-payment execution callables. Provider roles, flow
selection and trusted provider-evidence classification are reference inputs.
Saved-method alias and recurring-mode strings are host-defined generics passed
unchanged through resolver, saga and runtime; the evidence schema owns its internal JSON-length bound. The reference retains
locale, fiscal, profile, starter-policy, request observation and status-link
bindings. Acquisition expectations and accepted shipping terms require quote
acceptance; offer asks require a bound policy. A matching owned saved epoch can
resume; edited or incomplete state re-quotes. Stock refusal compensates only a
proved pre-dispatch draft; scoped contention and uncertain dispatch carry no
cleanup capability. A synchronous decline stays failed and is never auto-settled.
Neutral finalize and one-time reservation conformance tests use recording ports;
atomic acquisition/finalize SQL still requires integration with its migration chain.

The server entry also owns generic order-draft, runtime-finalize, intent-persistence
and resume stores, cancellation adapters and reservation sweeps. Structural clients
retain the incumbent RPC/table calls; composition supplies frozen snapshot schemas,
ordered finalize arguments, response decoders and fail-open phone normalization.
Use `createCommerceOrderDraftRpcPort`, `createCheckoutCompensationRpcAdapter`,
`createCommerceCheckoutResumeQueryPort` and `createConfiguratorIntentPersistenceRpcPort`
with structural clients, including `ConfiguratorIntentRpcQueryClient` for intent
persistence. Reference bindings retain their incumbent exported factory names.
Verified identity overwrites submitted identity after normalization. Draft retries
supersede only once after an idempotency conflict; catalog refusals do not supersede.
Recovery classifiers inject subject admission, compare shipping terms as well as
money, and separate continuation, expiry policy and refused token states. Application
recovery projection, routes and destinations stay in the host. SQL atomicity and
active-subscription guards require real PostgreSQL integration; the C2 handoff
release check is **to be released**.

`./commerce/server/native-checkout` exports
`createPostgresNativeCheckoutPersistence` for the `qualified-v2` draft rail.
Bind a restricted runtime executor, pass a server-produced `quoteSnapshot`, and
supply the route-authorized `clientId` through the separate options argument.
The port validates quote money, derives the draft snapshot, and calls the
existing guarded native draft routine with explicitly encoded JSON. It retains
`metadata.quoteSnapshot` and `metadata.orderDraftSnapshot`, including line tax,
totals and host context, for order-detail readers. A matching replay returns the
durable draft receipt; changed input conflicts without superseding the order.
The receipt's `not_started` field describes draft creation, not current payment
truth. Neither creating nor replaying it settles an order or dispatches payment.
Browser return handling and authenticated quote production belong to the host.
Existing native refusals for line discounts and zero-payable orders still
apply. Catalogue and prices are install-time seed data on this
rail; this port adds no price writer or managed-rail behavior.
The [installed PostgreSQL witness](../../tests/postgres/nativeCheckoutPersistence.test.ts)
checks snapshot retention, refusal, concurrent replay and fresh-process recovery.

`createPostgresAcquisitionCheckoutPersistence` adds final acquisition admission
over that persistence port. Supply a restricted runtime pool with exclusive
checked-out connections, the region, the existing financial policy and a host
classifier for acquisition discount semantics. It owns one READ COMMITTED
transaction: serialize the normalized native idempotency key, lock the existing
scoped definitions, re-read the current promise
and paid-family facts, check the quote's capability and pricing policy, then
persist and commit the draft on that connection. Changed second-delivery promises
refuse even when initial money is unchanged. Missing standalone capability raises
`AcquisitionTermsError` with `acquisition_terms_capability_required`; incompatible
engines raise `acquisition_terms_v2_required`. A changed promise raises
`acquisition_terms_changed`. Existing matching receipts replay before current
offer checks; the lower writer still validates replay ownership and input.
An ordinary returning subscription may omit acquisition terms only with complete
discount evidence, no acquisition grant or marker, and paid-family evidence.
Admission re-checks paid-family eligibility for the ordinary-returning path; a quote issued before the family's first payment stays admissible until it expires, as in the reference implementation.
The host must pass only a quote produced on the server, authorize the buyer and
verify quote acceptance before calling this boundary. A host that mounts
acquisition routing must route every acquisition caller through this adapter;
the mounting integration supplies its own no-bypass witness.
The lower persistence factory remains
available for trusted composition and does not enforce acquisition admission.
No route is mounted by either factory. Definition writers must share the same
row-lock protocol; this adapter adds no schedule-insertion protocol or writer.

`./commerce/contracts` is a type-only, browser-safe entry for commerce-owned
records and generic persistence, checkout/runtime, availability, recovery and
offer-policy ports. It imports no pricing module. Consume pricing DTOs from
`./pricing/contracts` directly. Commerce does not re-export pricing DTOs; its runtime
reuses the version constant through `./pricing/contracts`. Quote ports take the
host request, response and existing options as type parameters; the reference
binds the existing pricing definitions, adding only the server-bound offer.

`./commerce/server` supplies the Node-only OMS handlers, managed adapters and
order-detail composition.
`./commerce` remains browser-safe, including its full runtime import closure.
It also owns canonical order-money validation and commerce event payload schemas.
The latter reuse the core outbox envelope and inject host quote/draft validators,
without importing an outbox worker or storage implementation.
The same entry owns `deriveOfferAvailability`, `defaultOfferAvailability`,
`availabilityBySku`, `statusForSellableNow`, `reasonCodeFor` and the low-stock
threshold. Their reference facades preserve function identity. The server entry's
`createOfferAvailabilityPort` runs the existing physical-table projection over
an `OfferAvailabilityQueryClient` and an injected `isStockProvider` predicate.
It preserves active-hold subtraction, lot/location eligibility and provider
missing/stale refusals. SDK narrowing and provider selection stay host-owned.
M06 owns normalized new-purchase reads and reservation TTL policy; the reference
composition passes its selected read port through unchanged. With `dataKind: "postgres"`,
the host supplies `stockSourceKey` to bind the native ATP reader; omission reports
`inventory_stock_source_key_required`. Managed composition prefers an injected
reader, then binds `stockRpc` over `inventory_new_purchase_stock_read`; without
either it reports `inventory_new_purchase_stock_reader_required`.
W2 conformance distinguishes reads, fallback and one-time allocation; real SQL
atomicity and consumption remain integration obligations.

`./commerce` provides neutral cart/order/read, checkout, intent, persistence,
resume and customer-default schema cores and factories. Bind existing pricing
schemas and explicit host vocabulary, then extend the object cores with local
locale, profile, sizing, fiscal and provider policy. The reference retains those
extensions; it does not publish that policy into the package.
The intent factory accepts a SKU schema with string input and output, preserving
string SKU inputs when hosts infer request types. Resume and availability bindings
also preserve string SKU and product-slug inputs. When composing host fields,
retain their legacy positions: object key order also determines validation issue
order, including nested variants and checkout requests.
Offer tokens are opaque; `minimumUnits` is an untrusted ask with an injected default, never an
admission grant. The server entry executes the offer binding and bounds its server-minted evidence.
The starter guard receives terms, basket/discount functions and its plan schema
from the host. These entries install no store, route,
migration or provider.

Required root discovery includes `test/commerce/`: schema refusal/replay and
port-fit tests join recovery/error/helper witnesses, compensation and neutral W4 composition.
The unchanged reference suites and a pre-extraction parse transcript protect
host bindings. The cold consumer imports both installed entries and checks
availability projection/refusal, opaque offers, injected minimums and snapshot
refusal without optional peers. This establishes contract proof only.

OMS schemas and pure operational builders export from browser-safe `./commerce`.
Order-money derivation and paid-event constants reuse the existing commerce
owners. `OmsOrderPaymentStatus` binds the existing generic
`OmsPaymentStatus<PaymentIntentStatus>` to the core payment states; the generic
K1 contract remains available unchanged.
Node-only `./commerce/server` owns the generic handlers, managed RPC/query store
and detail composition that uses the shipping runtime. DTOs and structural ports
remain in the type-only contracts entry. Inject settlement,
identity/presentation and provider read projections at composition. The managed
client requires only `rpc`; table reads and note persistence receive a separate
query capability, including the `is(column, value)` filter required by hydration.
Unprojected timeline labels use canonical step keys; hosts supply localized copy
through `timelineLabel`. Refund marking remains an operator mark. Replacement creation
uses the existing fulfillment handler and never confirms arrival or interrupts
an active subscription. W5/W6 tests pin replay tuples and forbidden effects.

Returns expose request, approve and reject only: `CommerceReturnsPort` and
its schemas are at `./commerce`; the three handler factories and
`createSupabaseCommerceReturnsPort` are at `./commerce/server`. `restockDisposition`, `refundMode` and
`refundAmountCents` record intent. Receive, restock and refund execution do not
exist. The host supplies authorization and a `BffResponder`; the request adapter
forwards the authenticated principal as `p_requested_by` to the database's owner,
idempotency-key and fingerprint checks.
The package request schema defaults to neutral reason codes. Bind a host set with
`createCommerceReturnsSchemas(reasonCodes)` and supply its request schema to the
customer handler's `requestSchema` dependency; the reference binding retains its
legacy set and unchanged request/refusal envelopes.

Native order-review contracts and the type-only `OrderReviewLifecyclePort` stay
at `./commerce`. Customer/admin handler factories, PostgreSQL lifecycle/media
adapters and raw uploads are exported from `./commerce/server`. Strict schemas keep
pending declarations distinct from stored/confirmed observed media and keep
storage locators out of public results. The raw upload handler accepts an
`OrderReviewRawUploadBinding`; metadata finalization holds its transaction across
the host's promotion callback. The reference host retains its private filesystem
object store, lease composition and reconciliation. M02 `BlobStoragePort` is not a
drop-in binding: it has no private read, inspection, temporary write or promotion
operations. K3b preserves that host seam and adds no M02 storage bridge.

Hosted feedback has its own contracts at `./commerce` and injected Supabase
submit/token-check ports at `./commerce/server`. This tokenized public post-delivery lifecycle is distinct from native order
reviews. It requires the adopter's database to provide `submit_order_feedback`
and `check_order_feedback_token`; native `db/platform` supplies neither RPC.
These ports add no route or native binding. Review-delay policy remains host-owned
SQL (class (b) retention): native uses 14 days and the contributed managed profile
uses 21 days. There is no TypeScript delay parameter or SQL change.
The reference browser contract facades initialize their shared Zod instance in
jitless mode before loading package schemas, preserving CSP-safe construction.
The commerce package contracts add no global Zod configuration side effect. Browser
conformance bundles the complete commerce entry and both reference facades
without externals; the raw-upload source is a failing browser control, while
the complete server entry bundles for Node.

Neutral producer event contracts are exported from `./commerce`;
`createCommerceOutboxEventSchemas` binds the host's exact quote/draft snapshots.
Event-type literals and host payload behavior are preserved.

## Commerce domain effects

The Node-only `./commerce/server` entry provides the transactional email
consumer factories, their descriptors and dispatch registry. Compose explicit
`uniqueRegistry` composition from `@openlup/outbox` and
`CommerceEmailRuntime` bindings for the fulfillment payload parser, communications
transactional scaffold and send-outcome mapping, plus locale, money, generic
line labels, paid-order presentation and tracking/notification policy. The
package selects no provider, country, commercial offer or environment policy.
Neutral email ports take the host locale as a type parameter and carry `contextName` and
`messageId`; the reference maps its existing extension/provider field names.

Supplying `transactionalEmail` registers the transactional email consumers
together; `fulfillmentEnabled` separately controls the paid-fulfillment consumer.
Fulfillment reuses M08's existing handoff and risk seam. This registry adds no
emitter, dispatcher, invoice executor, schedule, migration or subscription
mutation. Cancellation email stays unregistered; `extraHandlers` can bind the
independent accounting consumer. The refund consumer trusts amounts only with
`provider-refund.v2` evidence. Return approved/rejected are separate notices.
Bind the optional `buyerCommsPolicyReader` when channel ownership must suppress
the registry’s eligible buyer-facing email handlers. It reads that live policy at handler
time and settles suppressed events as processed with
`channel_owns_buyer_comms`; omitting the reader leaves those eligible handlers unsuppressed.

The browser-safe `./commerce` entry provides event contracts, email DTOs and pure
projections; it never imports `./commerce/server`.
`projectCommerceSalesChannelEnvelope` retains opaque source identity without
normalization. `CommerceChannelExposureReadPort` is only a host-injected read;
no inventory exposure SQL or default implementation is supplied. Producer event
schemas bind exact host quote/draft snapshots through a factory; email consumers
retain frozen minimal subsets for in-flight compatibility. W8/W9 package
conformance and the rebound reference suites cover this boundary. UI extraction
and any artifact-cap change require their own approved scope.

## Shipping

`createDeliverySelectionBoundary` uses normalized dictionary or accepted-catalogue
options and injected canonical point sources. Valid dictionary options require an
allowlist; catalogue fallback defaults to the declared set and permits narrowing
only. Excluded sources perform no point I/O. Provider-selected transport remains
refused by checkout/preference contracts that require non-null carrier/service.
Adapters own decoding, provider identities and HTTP clients.

Shipping handlers require injected host schemas; contracts are type-only with opaque provider/carrier strings.
No vendor code, inventory import, activation or parity claim.
`resolveThresholdShipping` evaluates configured delivery terms against product
payable after product discounts, excluding delivery: equality and higher spend
are free. `summarizeThresholdShipping` projects one quote's effective delivery,
free state and remaining product spend. Pass `stale: true` for loading, failed
or busy quote state to suppress the remaining-spend helper. Missing delivery
money does not imply free delivery. Hosts own copy and formatting; fees and
thresholds remain configuration inputs.
Native flat-rate save requires the rate port, a ready Core report and
`nativeRateSchema`, a same-database Core `SchemaObservation` proving the applied
seed identity and settings objects. A candidate schema label is not proof;
later forwards do not invalidate an applied seed. The reference host exposes
`observeNativeRateSchema()` for this ledger/object observation and retains
caller-declared schema requirements. Missing proof keeps the named refusal.

## Inventory

Native purchase reservations expose `createPostgresPurchaseReservationPort`:
an atomic ordered item batch over finalized order items, per-reservation release,
and bounded expiry. The trusted host supplies its observed-stock source and
server payment status, wires checkout compensation and schedules expiry. Item
arrays are serialized as JSON for node-postgres. Existing native ATP counts its
live holds together with renewal holds, while the installed subscription
priority horizon (`inventory_renewal_protection`, default 14 days) remains in
force for purchase admission. Matching replay retains the
reservation identity and current status; changed keyed input and elapsed initial
expiry refuse. Local lots, locations, balance counters and movement history are
outside this slice. Install the complete catalogue; this remains a
source binding with explicit host composition. See the
[G4 source task evidence](https://github.com/openlup/openlup/blob/main/docs/platform/plans/oss-m19-g4.md).
Fresh reserve/release writes and expiry require READ COMMITTED and shared
transaction admission. Contention maps to `InventoryPersistenceError`
with SQLSTATE `55P03` and reason `inventory_admission_busy` or
`inventory_lock_unavailable`; unsupported isolation maps to the persistence
error with code `22023`. Committed receipt replay needs no new admission.
The gate caps the transaction-local lock timeout at 50 ms; no automatic retry
or fallback is performed. The helper is owner-only, reached through the bounded
definer entries, with no runtime helper or table grant.


`createPostgresAbandonedCheckoutCompensationPort(executor, now?)` supplies
`CheckoutCompensationPort.cancelAbandonedOrder` on native PostgreSQL. The bounded
routine closes the pending order, created intents and provisional activation,
then releases its purchase holds in the same transaction. It retains strict
keyed replay, refuses renewal orders and leaves existing payment/uncertainty
facts untouched. A dispatched simulator attempt refuses without writes with
`provider_attempt_in_flight`; captured or indeterminate attempts retain the money
refusal. The host withholds this operation for uncertain dispatch.
Dedicated promotion cancellation (`cancelUnstartedPromotionOrder`) remains
unbound on native PostgreSQL. No table grant, withdrawal marker or provider
dispatch is added. Install the complete catalogue and compose the binding
explicitly.

Reservation keys, stock-source references and cancellation reasons can contain
identifying strings, as can receipt metadata. Hosts should use opaque references
and keep personal details out of those fields. There is no erasure path for
these retained reservations, receipts or compensation history yet.

`createInventoryBindings` selects one store with exact host provider validation. With `dataKind: "postgres"`, supply `stockSourceKey` to bind the existing native ATP new-purchase reader; without it, `unsupported.newPurchaseStockRead` reports `inventory_stock_source_key_required`. Admin reads remain ready. The native PostgreSQL admin port refuses direct stock adjustment because this stock is externally observed; no native direct stock writer is supplied here. Native preview availability subtracts all live holds and remaining subscription demand through the horizon installed via `inventory_renewal_protection` (default 14 days), clamped at zero; native safety and channel exposure remain zero. Managed preview additionally accounts for channel exposure. The native reader refuses a horizon differing from the installed value or an own-order exclusion as `native_stock_read_options_unsupported`. For managed reads, an injected reader wins; otherwise supply `stockRpc` to bind `createManagedStockAvailability` with the managed forward `20261025109000_inventory_new_purchase_stock_read.sql`. Without either dependency, the reason remains `inventory_new_purchase_stock_reader_required`. Managed previews retain provider-tagged ATP accounting and their fixed 14-day horizon, refusing other horizons or exclusions as `managed_stock_read_options_unsupported`. The managed SQL reader refuses a NULL as-of timestamp as `inventory_stock_as_of_invalid` (SQLSTATE `22023`). Their conservative stale flag is true if any provider row for the SKU is stale; ATP quantities and allocator freshness checks are unchanged. `createInventoryContribution` declares selected callables without activation.

For native hosts that want the installed horizon on each read, use
`createPostgresStockAvailability(executor, { sourceKey, now }).readInstalled(skus)`.
It sends a single batched query for a nonempty list. The native SQL stock read
resolves the horizon in the same statement snapshot as stock and renewal demand.
An empty list returns an empty map. The starter subscription editor reads the
installed horizon on each stock read. The explicit `readPort.read` still refuses
requests that supply a different horizon.

`previewRenewalStockProtection` uses a host pool on a read-only snapshot and
returns one validation outcome for the proposed value. Use the
[settings preview](../../packages/core/docs/guide/how-to/operate/configure-settings.md#preview-before-changing-a-setting)
to inspect current stock for named SKUs, how the proposed horizon could affect
new purchase availability, and which records retain their terms. The version-1
document estimates proposed availability at the same instant and in the same
snapshot as current availability. Existing reservations keep their quantities
and expiry times.

Apply `20261123142000_inventory_renewal_protection_validation.sql` from the
complete native catalogue. The existing horizon reader now calls
`public.inventory_renewal_protection_validate(jsonb)`. The validator returns
the normalized policy with the original revision string and an integer horizon,
or raises `inventory_renewal_protection_policy_invalid` (SQLSTATE `22023`).
The migration owner and `service_role` can call the validator directly.
The qualified runtime logins inherit execution through `service_role`.
The existing horizon and stock reads keep their privileges and the absent-row
14-day fallback.

For custom runtime roles with a direct horizon-reader grant,
`EXECUTE` on the pure validator is optional for ATP. Grant it for connected
settings validation or preview. The validator reads no table, and direct calls
without its grant raise SQLSTATE `42501`.

`INVENTORY_MIGRATIONS` projects canonical units 27/33 byte-for-byte; install the full catalogue. Store support and pending proof: [M06 parity](https://github.com/openlup/openlup/blob/main/docs/platform/plans/oss-m06-stock-reservations-delivery.md#parity-pending-rows).

## Promotions

`./promotions` owns the existing automatic/legacy and code quote application,
benefit interpretation, advisory read ports, preview proofs, public-money binding,
acceptance tokens and passive telemetry. It calls `@openlup/core/promo`; it does
not contain another evaluator. Each factory receives the host facts it needs:
`createQuotePromoDiscounts` takes a customer classifier;
`createQuotePromotionV2` also takes the product floor and bound legacy application;
`createQuoteAutomaticPromotions` takes an email eligibility resolver and the bound
applications. `createQuotePromotionCodeAdjustments` and `createPromotionCodePreview`
require the floor. No factory supplies a default financial policy.

`createPromotionQuoteAcceptance<Request>` requires `projectRequest`, which returns
the host's exact request-binding projection; `promoCodes` also binds separately.
Its four issue/verify functions retain public-money projection, section diagnostics,
TTL and rotation. Explicit `acquisitionTerms` binds the full server-selected promise.
The pricing quote handler passes resolved acquisition terms to both
acceptance callbacks. An opt-in shipping binding appends shipping terms. A host must forward them to the acceptance helper. With no
acquisition configuration, terms are absent and historical token bytes stay equal.
This opt-in signature addition does not activate acquisition-only mounted issuance.

`recordPromotionAcceptanceOutcome` requires a recorder and swallows recorder
failure. The reference wrapper retains its existing sanitized operational recorder.
Reference wrappers also retain startup floor resolution, customer classification,
email/contact precedence and the rich request projection. Quote reads never reserve
capacity. Pricing receives application callbacks and has no import back to promotions.

`createAdminPromotionsHandlers` and `createAdminPromotionCodesHandlers` receive
the relevant members of `PromotionAdminBindings`: existing host admin-kit factories, authorization
resolver, response writers, exact RPC-error constructor/mapper and bound preview
helpers. The package does not copy or relocate that kit. The reference wrappers
bind these same objects, preserving human-only writes, required audit, signed
activation previews, validity-window checks and revision-aware replay delegation.
`createAdminPromotionSchemas` also requires the host currency schema. Its list
DTOs preserve system-managed read-only rows and valid status-only mirror handles;
the managed adapter retains the underlying write fences. Adjacent shipping,
catalog-price and subscription-band schemas and managed adapters remain reference-owned.

`createPostgresCommercePromoDataPort` and `createPostgresPromotionClaimSweepPort`
use an injected `PgQueryExecutor` from `./data`. They retain five evaluator methods
and bounded stale-claim sweep; they add no claim writer or reservation path.
`PROMOTIONS_MIGRATIONS` identifies the byte-identical projections of canonical
units 47/48 with paths, positions and hashes. These sparse units are not an
installation chain: use the complete canonical catalogue. No migration or
manifest identity changes in this move.

`createPostgresQuoteCustomerEligibility` is a trusted-server read adapter.
`resolve(email)` trims and lowercases the lookup, prefers an exact stored email,
then checks at most the 25 oldest matching candidates after local-part plus-tag
normalization. It returns `clientId`, `source` and `matchKind`; plus-normalized
evidence is only for promotion eligibility and must never grant recognition,
login, sessions or past-order access. The result of `resolve` must stay inside
the server and must never be sent to the browser.
`hasPaidSubscription(clientId)` compares canonical UUID values and checks paid
subscription facts across the normalized family using the existing native
paid-order-count reader. The final family check is independent of the bounded
preview lookup: a newly persisted exact alias may have no personal paid orders
and still belong to a paid family. Neither read changes stored contact identity.
Two native evidence limits remain: the device-redemption routine returns constant
false because visitor evidence is not persisted; this does not establish device
eligibility or implement a device guard. Redemption counts are keyed by individual
promotion IDs and do not aggregate mirror families. Hosts must not assume either
capability or claim full eligibility parity from these reads. The characterization
tests preserve these limits without changing the reader or adding a default
eligibility rule.

Admission re-checks paid-family eligibility for the ordinary-returning path; a quote issued before the family's first payment stays admissible until it expires, as in the reference implementation.

The server entry is classified as an adapter because its executor declaration
reaches the data entry and optional pg types. It imports at runtime without pg
and works with an injected executor; selecting the data gateway retains its
named missing-pg refusal. Its declarations compile after peer selection. The
contracts entry remains a non-adapter, imports no other module and compiles
without optional peers in NodeNext and Bundler modes.

The [promotion suites](https://github.com/openlup/openlup/tree/main/packages/platform/test/promotions) retain existing assertions. The
[real PostgreSQL witness](https://github.com/openlup/openlup/blob/main/tests/postgres/promotionsNative.test.ts) installs
the full canonical chain, checks projection hashes and validated constraints,
and proves reads without durable writes, paid/released lifecycle, bounded
sweep, receipt/outbox fences, replay, lock/settlement skips and explicit invoker
grants. This is existing native lifecycle/read evidence only. Native code
candidates, mounted issue/honor, acquisition-only mounted acceptance and the
full native/managed eligibility matrix are accepted native-backend capability
gaps, without a parity claim, in the
[module ledger](https://github.com/openlup/openlup/blob/main/docs/platform/plans/oss-m05-catalog-offers-pricing.md#d8-pending-outcome-ledger).

Opt-in `shippingTerms` also binds shipping-only promises. `createQuoteShippingPromotions`
resolves post-discount thresholds; optional `acquisition` bindings select host policy.
Omission preserves incumbent behavior. See [parity seams](https://github.com/openlup/openlup/blob/main/docs/platform/CANONICAL_CONTRACTS.md#m05-parity-seams).

## Pricing

The unbound `createCatalogPriceSetupHandler` and
`createPostgresCatalogPriceSetupStore` provide human-authorized preview, apply and
receipt readback for one immediate positive gross base at minimum quantity one.
Portable DTOs live in `./pricing/contracts`; schemas and canonical-byte encoding
live in `./pricing`. The command matches the price operations retained in draft
v2/v3. Hosts bind the same verified administrator session to authorization and
SQL execution. No route, capability or runtime binding is installed.

Apply serializes receipt before price context, checks the expected base and
closes/inserts at one database statement instant. Replay precedes target reads;
key reuse or another operator refuses. The read-only readiness routine validates
native input domains, actual financial definitions, retained agreements and the
independently audited cohort. Unproven evidence hard-refuses before and after the
provisional write. Preview restores every provisional price row. Existing
subscriber agreements and clocks are unchanged. The known aggregate-reason defect
is retained: an existing invalid-SKU reason can hide a second invalid SKU.
See [native base-price writes](DATA_AND_MIGRATIONS.md#native-base-price-writes)
for installation, transfer and managed-rail limits. Scheduling, list lifecycle,
context-version operations, zero-price writes and broader price plans remain
reserved for a later command version.

The existing `./catalog` entry supplies the opt-in PostgreSQL quote catalog
reader described under [Catalog](#catalog); the quote engine consumes its
existing `CommerceQuoteCatalogReadPort`.

For an offer projection that builds several quotes, create one
`memoizeCommerceQuoteCatalogReads` wrapper from `./pricing` per request and
pass it to the projection and its quote ports. The wrapper shares the first
catalog promise, including any rejection. If the reader throws before returning
a promise, the wrapper shares a rejected promise with the same reason. Create a
fresh wrapper for the next request to read the catalog authority again.

`./pricing` provides the existing OpenLup strict commerce price authority,
subscription-price-policy schemas, canonical digest and integer math, signed
pricing-policy assignment tokens and safe refusal mapping. Hosts inject exact
price-list, base-entry, legacy-entry and policy-history reads. The authority
validates the base before reading history and uses the observed base's
`priceListId` for that lookup. History excludes legacy fallback even when no
revision is currently effective. Digest, interval, ambiguity and amount-kind
refusals retain their existing identities and precedence. The opt-in
`createConcurrentCommercePriceAuthorityPort` instead schedules history alongside
base reads using the selected list ID, with base-refusal precedence.

`./pricing/contracts` contains dependency-free authority observations, policy
DTOs and version constants; its only external type comes from the exact
`@openlup/core/pricing` entry. `./pricing/browser` directly re-exports exactly
`createCommerceQuotePrimitives`, `acquisitionCapabilitySchema`,
`acquisitionTermsExpectationSchema`, `acquisitionTermsSchema`,
`resolvedAcquisitionTermsSchema`, `shippingTermsSchema` and
`deriveSubscriptionUnitPrice`, the same objects as on `./pricing`.
`deriveSubscriptionUnitPrice` is a display estimate; the quote is the amount
charged. Its defining module sets zod to `jitless`, as the server entry does.
Tree-shaken production bundles that import only the entry's earlier symbols do
not contain that call. Evaluating the whole entry applies the setting, which
changes no parse result; that covers dev pre-bundling, unbundled ESM and Node.
Acquisition schemas come from their defining file; shipping
re-exports its pure validator owner through an exact linted edge, preserving identity
without handlers or Node HTTP declarations. The reference
quote context admits both terms as optional fields and retains its existing strict
fields and refusals. The complete browser bundle contains no Node imports or
pricing server root. Other schemas, Web Crypto hashing and Node HMAC token
operations stay in the server entry. Tokens retain assignment binding, the
72-hour default compatibility window and rollback behavior. Secret selection,
feature flags and readiness remain reference composition responsibilities.
Reference paths use named exports of the same functions and error classes;
the browser keeps its existing policy schema binding locally.

### Offline quote money v2

Use experimental `planCommerceQuoteMoneyV2` from `./pricing` with resolved line
prices, the promotion owner's selected outcome and the no-promotion baseline.
Each candidate carries its own delivery and threshold facts. Inclusive plans
rank gross payable with fees. Exclusive plans rank merchandise, shipping and
handling before tax and fees. Equal scores retain the promotion owner's choice.

Pass the same planning input as `planInput` to `composeCommerceQuoteMoneyV2`
with matching tax evidence and allocation IDs. Composition reruns the planner.
Provide separate fiscal rates and position metadata for inclusive money, or
the verified tax result, position and fee metadata for exclusive money. Owner
diagnostics and `displacedCodes` are separate. In both arms, `taxEvidence.evidenceDigest`
commits the destination binding, selection, service and evidence expiry.
If verified tax evidence disagrees with the plan, recalculate tax for the same
planning input before composing again.

Use `quoteDigest` with `commerce.quote-money.v2` for the shared money and
`commerce.quote.v2` for the complete estimate or final quote without its
`quoteDigest` field. `commerceQuoteV2Schema` checks both digests before evaluating
totals and amount limits. The offline functions require plain JSON data and refuse hidden own keys.
Read the schema refusal’s code, field and remedy from the issue params.
`./pricing/contracts` and `./commerce/contracts` types share the money shape through `@openlup/core/pricing`.
The offline functions rely on their caller for evidence acquisition and issuance.

### Legacy quote foundation

The quote foundation also owns neutral money/tax/quote DTOs, promotion evidence
and rejection details, bounded catalog facts, provenance creation/public stripping
and the supported-tax-profile guard. `createCommerceQuoteSchemas` requires the
host's currency, product-slug and context schemas; `createCommerceQuotePrimitives`
requires currency validation. No settlement default or catalog policy is installed.
The original line, currency, VAT, discount and shipping equations and v1/v2
provenance refusals are preserved. Quote ports accept host request/response types.
The reference keeps its rich browser request/context validation and catalog bridge;
server compatibility paths export the same error classes and provenance/tax functions.
The portable schema counterparts stay server-side; binding tests compare their
results and diagnostics with browser validation.

`createDbBackedCommerceQuotePort` owns the existing quote computation and price,
tax and component helpers. Hosts supply bounded catalog/price reads, settlement
values, a flat shipping read, promotion application and context callbacks. The
reference binds `getShippingFlatMinor`, industry context and existing promotion
implementation. Shipping is read before promotion application; the original VAT
helper and both discount lanes are preserved. Snapshot comparison accepts injected
response validation and request reconstruction, so rich context stays local.

Quote, ordered batch and offer handlers take the host's schemas and BFF responder;
the reference binds its observed request context. The single-quote handler owns
promotion acceptance/fallback. For each validated batch quote entry, the handler
resolves optional eligibility and policy and then calls its injected quote port;
entries run concurrently and return quote bodies in request order. A failed call
fails the whole response. The handler supplies no shared time or read context;
any cross-entry sharing is selected by the host port. The handlers retain their
existing refusal mapping and public evidence validation.
Offer projection requires roster, representative-request, unit-count, floor and
wire-scope policy. It retains v1/v2 responses, partial degradation only for a
missing configured price, and the first successfully priced representative.
The current reference uses this product-only projection for display copy; it
excludes delivery and is not a checkout expectation. The offer cache is keyed by
caller strings: its success and failure TTLs bound reuse age, not key count, and
the caller controls the key set. Readiness keeps its 60-second positive and
5-second negative caps. Every caller-side policy reason still requires a
dedicated host monitor; the exported reason tuple lets a host coverage check
enumerate the reasons but does not install or verify monitors.
The additive acquisition API is off by default. `selectAcquisitionTerms`
and `filterAcquisitionPromotions` require an `AcquisitionFinancialPolicy<Row>`:
row facts, classification, metadata validation, pair matching, initial rate and
unconfigured terms all come from the host. Omission refuses with
`acquisition_terms_policy_unconfigured`, even with no rows; no financial policy
or schedule is bundled. Selection preserves row identity, validates the whole
tagged schedule and uses half-open windows with the next future boundary.

`createAcquisitionQuoteSchemas` composes separate capability/context/resolved-terms
schemas with the host's validators. `projectAcquisitionOfferPricing` pins the
observation time and capability for every representative request; its v3 output
contains public terms and expires by the next boundary or 60 seconds.
`createAcquisitionOfferPricingSchema` retains the injected v2 settlement and scope
rules. The opt-in handler delegates absent acquisition headers to an incumbent
handler; negotiated responses require v3, paired v2 policy and private no-store
headers. The incumbent handler continues ignoring acquisition headers.
`createAcquisitionReadinessCache` requires an explicit policy configuration,
validates acquisition evidence, clamps positive cache expiry and rereads once
after crossing a boundary. The existing shared readiness cache remains unchanged.

Promise comparison is independent of money. Explicit server-selected resolved
terms can join the existing acceptance money projection and totals section;
absence contributes no property. Quote/batch refusal mapping and unsigned-terms
fallback checks require explicit acquisition configuration. Reference composition
supplies none: existing schemas, headers, reads, error details and token bytes
are preserved. Threshold shipping is supplied by the separate
[parity seam](https://github.com/openlup/openlup/blob/main/docs/platform/CANONICAL_CONTRACTS.md#m05-parity-seams).
Checkout admission, claims, finalization,
promotion implementation, stores, SQL, routes and activation remain outside
this API.

Native policy revisions expose optional `closedFromOpen` evidence after their
one admitted NULL-to-finite close. Digest verification retains the original
NULL end; selection and returned `effectiveTo` use the shortened interval.
Install the complete catalogue through
`20261122140000_subscription_price_policy_close_digest` before using the updated
native readers. Unverifiable pre-forward closed tuples refuse with
`subscription_price_policy_original_tuple_unverified`; historical digests are
never replaced. Closed-from-open provenance can only be set by a guarded
close or a native restore after installing
`20261123192000_subscription_price_policy_close_provenance`. The [migration and rollback guidance](https://github.com/openlup/openlup/blob/main/docs/platform/migrations/compatible-data-transfer.md#policy-revision-close-compatibility)
owns compatibility. This adds no scheduler, closing command or activation.

The package witnesses in `test/pricing/` move the incumbent authority, policy,
token, quote, snapshot, handler, offer, cache and readiness assertions. Currency
fixtures use synthetic identifiers while preserving the same arithmetic and
refusals. Reference schemas, rich catalog/context policy and composition remain
in the application. The existing cold consumer exercises both entries and
compiles installed declarations without optional provider peers.

## Catalog

### Read governed offer memberships

Install the complete PostgreSQL catalogue through
`20261124120000_catalog_publication_reads.sql`. Call the experimental
`readPostgresCatalogMembershipPage(executor, input)` from `@openlup/platform/catalog`.
It reads one page with one SELECT. The caller owns the transaction and savepoints.
An expected refusal is returned as a value and leaves the transaction usable.
A confirmed legacy catalogue returns an empty first page. A governed page
returns evidence for each emitted SKU and a cursor when more entries match.
Pass back that cursor with the same offer and mode. Start again at the first
page when the head moves. A PostgreSQL serialization failure is retryable.

On qualified-v2, apply `20261124180000_catalogue_read_grant.sql` to use
`openlup_catalog_publication` for both reads. Where provisioned, `service_role`
remains supported. Run readiness in a read-write `READ COMMITTED` transaction
and close it promptly.

### Read activation readiness

Install the complete PostgreSQL catalogue through
`20261124140000_catalog_publication_readiness.sql`. Call the experimental
`readPostgresCatalogActivationReadiness(transactions, installed, input)` from
`@openlup/platform/catalog` with up to 100 distinct SKU codes and the expected
head digest from a membership page.

On qualified-v2, apply `20261124180000_catalogue_read_grant.sql` to use
`openlup_catalog_publication` for both reads. Where provisioned, `service_role`
remains supported. Run readiness in a read-write `READ COMMITTED` transaction
and close it promptly.

Direct SQL calls hold a `SHARE` lock on `catalog_products` until the
transaction ends, so concurrent publication can return `publication_busy`.

The read waits for an in-flight publication, then reads the sealed head, SKU
evidence and price readiness in one snapshot. It writes nothing. A moved head
is a retryable conflict and a legacy catalogue is `unsupported`. A code with no
sealed or governed live SKU is `sku_not_materialized`; damaged evidence refuses
the whole batch. SQL alone reports `price_readiness_missing` and
`price_shape_invalid`, at one evaluation instant; overlapping effective price
lists refuse the batch. After the transaction closes, `installed.assess`
receives a copy of each certified subject and may add other reasons. Pass
`assess: () => []` when there are no installed rules. An item is ready when it
has no reasons.

Run `openlup catalogue project --trusted-packs ./owned/catalogue.ts --json`
to check trusted pack definitions and fixtures with their content validators.
The module executes with the operator's permissions. The report identifies the
scratch JSON and gives an inert replay command. `catalogue check --packs` and
`runCatalogExtensionConformance` from `@openlup/platform/catalog/testing` read
inert JSON. See the installed [catalogue recipes](../../packages/core/docs/guide/how-to/extend/catalogue-extension.md)
for the copied skeleton, offline checks and evidence limits.

Catalogue pack authoring adds `defineCatalogPack` and `draftsFor` to
`./catalog/contracts`. Descriptors preserve readonly literal type, unit, option,
tax-class and profile references. `defineCatalogPack` recursively freezes the descriptor and returns a recursively
readonly view, including metadata supplied through referenced objects; it neither
validates it nor invokes callbacks. `draftsFor` types the existing v1 draft fields
and derives each SKU's option keys from that product's selected `dimensions`.
Zero selected dimensions require empty options. For explicit annotations, supply
the selected keys as the second type argument, for example
`CatalogPackDraft<typeof pack, "finish">`; omitting it means all installed
dimensions. Derive this argument from `typeof product.dimensions[number]` when
annotating an existing product. An annotation restricts allowed dimension names;
`draftsFor` correlates the actual inferred selection with SKU options, while
runtime validation checks the supplied list. The full v1 SKU shape accepts
inline or referenced objects and readonly or mutable arrays, including
`identifiers` and `assetRefs`. Type-level unit references also
cover quantity scalars inside list attributes. To hand readonly authoring output
to existing mutable draft/command DTOs, pass each draft through the existing
server `catalogDraftPayloadSchema.parse(draft)`; the schema validates and returns
the v1 wire payload. Attribute definitions describe the closed value-kind grammar;
attribute values and prices are not added to v1 drafts.

Draft payload v2 adds product/SKU `attributes` and per-SKU `priceOperations` in
place of `priceRef`. Each price operation is the complete version-1 immediate
base command: `schemaVersion`, `commandKey`, `variantId`, `priceListId`, fixed
`mode: "one_time"`, `minQty: 1`, `amountKind: "gross"`, positive integer
`unitPriceMinor` and `expected: {entryId, unitPriceMinor}` (both null or both set).
It changes no live price. Zero new prices and unknown payload versions refuse.
`catalogDraftPayloadV2Schema` and `catalogDraftCommandV2Schema` validate that
version; the original schemas and v1 bytes remain unchanged. The opt-in `createPostgresCatalogDraftStoreV2` and `createCatalogDraftHandlerV2`
use the explicit `CatalogDraftStoredRecord` union and its stored-record/result
schemas to read both versions. The original factories retain v1 admission and
result types. Upgrade readers before enabling v2 authoring.
Stop v2 authoring before rolling back; retained v2 history still needs a v2 reader.
`draftsFor` also types v2 values against their declared attribute scopes and kinds,
including required attributes in inline, referenced, readonly and mutable inputs.
For incomplete interactive authoring use the wire schema: missing required
attributes remain saveable and `validateCatalogDraftV2` reports publication
readiness issues through the existing attribute validator and reference resolver.
Complete axis options reuse the v2 combination owner, so equivalent units cannot
hide duplicate combinations; missing options remain publication readiness issues.

The version-2 `resume` command takes no payload and reopens the same abandoned
draft by appending an open revision with its retained payload and reservations.
Legacy revise still refuses an abandoned head; every original receipt replays
unchanged. The native forward writes only draft-owned rows. The managed rail
does not supply this feature.

Draft payload v3 adds a closed `publication` input envelope: `kind` (release or
compensation), ordered `operations` and optional immutable draft/media evidence.
It retains the v2 attribute and price-command grammar. Opt in through
`createCatalogDraftHandlerV3` and `createPostgresCatalogDraftStoreV3`;
`CatalogDraftPublicationStoredRecord` covers all three retained versions. The
v1/v2 factories and their version-specific unions keep their admission boundaries.
Upgrade readers before v3 authoring; stop v3 writes before rolling readers back.
Retained v3 history continues to need a v3 reader.

V3 freezes `product.sharedContent` as `CatalogDraftSharedContentV3`: version 1,
`catalogAction`, an optional document, presentation, explicit offer memberships
(including false), requested modes (including an empty array), and SKU publication
facts. `extractCatalogDraftPublicationInputs` validates and extracts exactly this
envelope and `publication`, without defaults or operation sorting. Installed
validators own the opaque document, presentation and per-SKU facts. They receive
the complete shared-content envelope. Industry vocabulary stays in that data.
The [operation union](../../packages/platform/src/catalog/contracts/draftV3.ts) carries explicit
eligibility separately from memberships/status. `set_derived_sku_facts` records
explicit document/quantity-bound cache operations, including for omitted SKUs;
omission alone never requests a change. The eventual publisher must verify each
operation against its immutable source and apply the ordered prefix guards.
These are inputs only; saving or previewing a v3 draft executes no operation.

Document provenance names either `current_draft` or an exact retained receipt
tuple. `resolveCatalogDraftProvenance` expands the former from the persisted
record's ID, revision, command key and fingerprint; it cannot embed a fingerprint
inside its own input bytes. Retained provenance requires matching declared draft
evidence and later authority verification. Media claims retain the exact SKU,
media reference, sorted unique asset set and immutable proof digest. Neither
extraction nor a claim grants publication authority or proves external readiness.

`createCatalogCandidateService` takes authorized draft/definition/lineage readers,
the composed registry and an optional price-owner validator. `prepareCandidate`
returns issues and an impact summary without writes. Its self-contained reference
is `v1:<draftId>@<revision>/<publicationId>@<headRevision>`, or `/unpublished`.
The same reference resolves v1 through v4 immutable payloads. The released
reader order, refusal codes, issues and digest stay the same with ordinary
wiring. Its preparation report is unknown because it has no publication
observations. `validate(candidateRef)` reconstructs the preview and
`compareCandidate` checks the caller's complete expected head and digest.

To prepare a v3 or v4 publication, use
`createCatalogCandidateServiceWithPublication` and supply `readEvidence`.
The publication service reads the exact draft to select the evaluator. It
reuses that draft when a v1 or v2 payload needs the released checks. If the
evidence is unavailable, return `null`. The preparation report can still show
a known issue that needs fixing. Saving or preparing a draft executes no
publication operation.

See [Correct a price-list refusal](../../packages/core/docs/guide/how-to/build/customize-the-starter.md#correct-a-price-list-refusal)
for how to locate and correct a price operation.

### Change a product rule

See [Change a product rule](../../packages/core/docs/guide/how-to/build/customize-the-starter.md#change-a-product-rule)
for the starter's edit, test and reinstall steps.

For an existing deployment, supply the self-contained build asset with
`withCatalogPublicationRules` when composing the pack. Use that pack for the
regular definition installer and build the host registry from its types. The
rules module owns content validation, so its type definition can omit an inline
validator. Export the hooks documented by `CatalogPublicationRulesModule`.

Use the named presentation fields for titles, routes, short names, advertised
weights, media references, and accents. List advertised weights in ascending
order without duplicates. Derived SKU facts can contain bounded JSON objects,
arrays and scalar values. Published SKU details have a 2,097,152-byte UTF-8
limit and must fit the publication page depth limit. Give each display field
its own value. Copying a whole authored document into a display
field fails preparation, including a copy as a localized map or array.
An exact copy has an equal canonical JSON value. Transformed or re-encoded content, such as JSON serialized inside a string, other encodings or normalized text, is outside this rule.
Content is refused while an earlier revision of the document cannot be read.
When creating a product, include the authored document at `product.sharedContent.document`.
Store structured display values as typed public attributes.

Render public product attributes supplied by the catalogue read model. The
existing projection admits up to 2,048 bytes per projected text value.

#### Native publication commands

Apply the complete native migration chain before binding
`createPostgresCatalogPublicationCommands` from `@openlup/platform/catalog`.
Supply a dedicated catalogue owner transaction lane, an installed rules registry
and a server verifier for human administrators. Authorize the operator through
the binding. The binding checks live administrator membership on every command.

Enable `includeApprovalSeal` on the opted-in candidate service. Copy the
candidate reference, digest and `preparation.postStateDigest` into the approval
request. A structural seal can be available while activation is pending. Publish
using the same candidate, its full expected head, and a distinct command key.
Retry an uncertain response with the original command and key. If the approval
or expected head changed, prepare the current draft again.

To repair live drift, save a `compensation` revision against the current head
and approve it under a fresh key. Publishing it appends another revision. An
issued candidate's approval remains effective for its history.

For a new governed lineage, compose `createCatalogDraftHandlerV4` with
`createPostgresCatalogDraftStoreV4` and save a payload with
`schemaVersion: 4`. Governed v3 publication facts carry the authoritative
lifecycle. Withdraw a product with its exact child roster. This clears both
purchase eligibility flags while retaining the SKU, its physical facts and
offer memberships. Restore the product independently, then explicitly restore
and enable each SKU offered for fresh sales. Read the exact governed issue
with `readbackV3` and retain the returned schema version on original receipts.
An older predecessor requires explicit adoption. Archive remains unavailable
until the commerce barrier supports it.

Descriptor fields are closed, including nested metadata. Unit dimensions and
axis attribute references resolve within the selected type. Referenced keys,
unit codes, type versions, tax-class keys and profile references retain literal
types: use the inline helper or preserve those literals when declaring arrays
and objects elsewhere. Widening them to a general `CatalogPackInput` or string
keys removes static reference evidence, even when the runtime value is valid.
Runtime schemas remain authoritative for value bounds and semantic checks.

`catalogProductTypeIssues` in the server entry returns definition issues with
stable `CatalogConformanceCode` values and JSON-pointer paths rooted at the
input definition array. `catalogPackIssues` checks the closed pack shape,
namespace, tax-class and profile references, then reuses those definition issues
with paths under `/types`. These checks perform no I/O or callback execution.
`createCatalogProductTypeRegistry` uses the definition issue list
and throws its first issue as `error.issue`, retaining the
`invalid_catalog_type_definition` refusal. Custom registries can supply
`resolve` alone. The Node entry `./catalog` exports
`CATALOG_CONFORMANCE_RULES`, an exhaustive typed record supplying severity, rule,
fix and installed recipe destinations. Browser contracts export
`CatalogConformanceCode` and its related shapes as types only; the union reuses
Core's `CatalogQuantityCode` for quantity refusals and the V2 owner's
`CatalogCombinationCode` for combination refusals; checker prose
stays in the Node entry. The small pack authoring helpers remain browser-safe;
the recipe guide and offline checker are separate opt-in entries. Existing definitions remain valid.
New metadata includes optional exact unit factors, bounded attributes, axes,
a default tax class, a versioned profile reference and a build-pinned
`validatorRef` (`sha256:` followed by 64 lowercase hexadecimal digits).
An axis names a declared dimension and a variant-scoped attribute of that type.

`catalogDefinitionDigest` and `catalogPackManifest` compute SHA-256 identities
server-side over bounded canonical JSON. Labels and executable callbacks are
excluded; validator artifact references and all other admitted definition
metadata are covered. Definition versioning follows the
[catalogue extension agreements](https://github.com/openlup/openlup/blob/main/docs/platform/CANONICAL_CONTRACTS.md#catalogue-extension-agreements).
Manifests are derived immutable projections, never client-authored evidence. These helpers install nothing, publish nothing and
activate no capability. Quantity types re-export Core's single definition;
the existing v1 quantity validator and option canonical bytes are unchanged.
`installCatalogDefinitions(installExecutor, pack)` installs definitions and tax-class
keys through the owner-only native `catalog_definition_install` invoker routine.
The installer uses `catalogPackIssues` for pack closure and references before SQL.
Supply the native migration-owner executor explicitly after applying the complete
selected catalogue. Digests come from the platform's canonical bytes, and the
receipt replays for the same pack version and manifest digest. Reusing a pack
version with different bytes or redefining an installed type version refuses.
Retired tax-class keys stay retired; custom units remain definition JSONB.
Installation never publishes or binds a runtime capability.

Include `subscriptionProfileDefinitions` to opt into exact profile-version
checks. Supply an empty array to reuse installed profiles. The first successful
declaration owns its receipt, and an identical declaration in a later pack
reuses it. A fresh opted-in install requires READ COMMITTED. Use
`readInstalledCatalogSubscriptionProfile(executor, { key, version })` with the
native migration-owner executor to read the exact profile and policy pins or
receive `null`. Follow the [subscription profile upgrade path](../../packages/core/docs/guide/how-to/extend/catalogue-extension.md#subscription-profile).

Products have nullable `type_key` and `type_version`: NULL means legacy and not
mapped. Existing products, SKU codes, prices, documents and subscription references
are unchanged. A composite foreign key requires complete new bindings to name an
installed version. SKUs inherit their product's type. There is no separate binding
state because it would duplicate NULL-ness before publication exists.

`observeCatalogDefinitionReadiness(readExecutor, registry, database)` reads every
live product type reference and compares its installed digest with the composed
registry. The executor needs SELECT on both tables through table ownership or a
BYPASSRLS read role, with row security inactive on both tables; the helper grants
no access. It checks `row_security_active` for both tables in the same SQL statement
as the binding read. Active row security marks the observation incomplete, even
when no bindings are visible. A referenced definition that is unavailable retains
its binding with a NULL installed digest. Both cases yield `unknown` readiness
and make the write guard refuse with `registry_missing_referenced_version`.
Put the result in `ReadinessInput.catalogRegistry`
in the application's `createVerificationInput()` for `openlup verify --app`.
Missing versions or unequal digests report `registry_missing_referenced_version`.
Keep every referenced version in the composed registry.
`createCatalogDefinitionWriteGuard(readExecutor, registry)` returns a guard that
re-probes before invoking each supplied catalogue-write callback. A mismatch or
probe failure prevents the callback. Applications must explicitly wrap their
writes; existing adapters are not silently rebound. Host migration-phase calls,
boot readiness and publication wiring belong to the later V2 reader/composition
work. The managed rail does not supply this feature.

The native quantity forward adds nullable all-or-none net-content and gross-mass
columns to live SKUs. Net dimensions are `mass|volume|count`; gross dimension is
explicit and fixed to `mass`, so storage rejects any other dimension. Coefficients
are positive `numeric(40,0)` values and scales are 0–12. Use decimal strings at the
TypeScript boundary. SQL does not admit unit codes: the future publisher checks
units against installed definitions. Gross mass is never inferred from net content.
Stock and reservations continue to count sellable packs.

After applying the complete native catalogue, call
`backfillCatalogNetContent(installExecutor, {batchSize})` with the migration-owner
executor. `batchSize` is a required positive PostgreSQL integer. Each invocation
of the owner-only invoker routine locks one batch of eligible SKUs in ascending
ID order with `FOR NO KEY UPDATE`. The driver drains batches, can resume after an
interruption and is a no-op on replay. It fills only absent net content from
positive legacy grams as mass / scale 0 / `openlup:g`; native zero stays unknown.
It preserves existing content and every gross-mass field. Migration application
itself performs no backfill. The old `net_weight_g` contract and V1 readers stay
unchanged; V2 readers and migration-phase host wiring arrive separately. The
managed rail does not supply this feature.

The native attribute forward adds nullable `attribute_values` JSONB on products
and SKUs. NULL preserves legacy absence; each supplied value must be an object
whose PostgreSQL rendered text is at most 1 MiB (1,048,576 bytes). This storage
ceiling measures different bytes from canonical JSON safety checks and the
separate aggregate draft limit. No opaque document is mined or backfilled, and
V1 DTOs and canonical bytes are unchanged.

`validateCatalogAttributes(definition, input, references?)` checks values against
an installed type's existing attribute definitions. Pass `productAttributes`
and `skus: [{id, attributes?}]`; omitted or NULL attribute objects mean absence.
The helper reuses `catalogProductTypeIssues` and canonical JSON depth/byte safety
checks and independently enforces the per-product/per-SKU 1 MiB rendered-text
storage ceiling before value preparation or reference resolution. The storage
counter includes UTF-8 string bytes and the spaces after JSONB colons and commas;
key ordering does not affect size. It conservatively allows for numeric exponent
expansion rather than claiming to reproduce every PostgreSQL numeric spelling.
For admitted values (whose only JSON numbers are integer quantity scales 0–12),
the count is exact. An oversized object returns `attribute_storage_too_large`
at `/productAttributes` or `/skus/<index>/attributes`. Separate objects do not
share a storage-byte budget; the aggregate canonical-input limit still applies.
The helper snapshots supplied data and does not call `validateContent`. Compose
that callback separately for application cross-field policy. Unknown keys,
wrong scope, malformed values and invalid cardinality return `valid: false`
with shared conformance codes and JSON-pointer paths. Missing required values
or locales return `valid: true` with `readinessIssues`. A locale fallback never
satisfies an explicitly required locale. `false`, absence and a supplied empty
list retain their declared meaning; a required list may be empty only when its
bounds permit it.

Values use strings for text, stable enum IDs, signed decimals and calendar dates
(`YYYY-MM-DD`, years 0001–9999); localized text is a locale-to-string object.
Quantity values use Core's decimal-string quantity shape and installed units.
Lists contain only the declared scalar kind. References use
`{namespace, id}`; the namespace must occur in the definition's allowlist. The
injected `CatalogAttributeReferencePort.resolve` receives one deduplicated batch
across product and SKU values. Each requested pair needs exactly one `resolved`
result; missing, duplicate, dangling, private, unavailable or failed resolution
refuses. The port supplies application visibility evidence and performs no
arbitrary relation or URL lookup on behalf of this helper.

`catalogAttributesReadyForPublication` is only the attribute admission predicate.
`prepareCatalogAttributeProjection(validation, publicationRevision)` accepts its
successful, complete validation result and a positive bigint revision written
as a decimal string. It produces deterministic frozen rows, repeating product
attributes per SKU, retaining local SKU values and zero-based list ordinals.
Every `text_value` slot is additionally bounded to **2,048 UTF-8 bytes**, including
the entire canonical-JSON map for localized text and each scalar list element.
The landed unconditional index carries `(attribute_key, definition_version,
text_value, sku_id)`, so the bound applies regardless of `filterable` or `facetable`.
On the qualified stock PostgreSQL profile (8 KiB pages), the
[B-tree tuple budget](https://github.com/postgres/postgres/blob/REL_16_STABLE/src/include/access/nbtree.h#L142-L155)
is 2,704 bytes. The conservative allocation is 2,048 text bytes + 64 ASCII
attribute-key bytes + 4 version bytes + 16 UUID bytes + 128 bytes reserved for
headers/alignment: 2,260 bytes. It does not depend on value compressibility.
Custom builds with smaller pages are outside this sizing proof. A larger declared
character `maxLength` still permits shorter values; an oversized actual text slot
returns `attribute_projection_text_too_large` at the scalar's input path and
prevents preparation. The real-index witness uses maximum-length keys and version
values, inserts adjacent safe boundaries and reproduces a bypassed oversized
index insertion failure.
Localized scalar maps occupy one canonical-JSON text slot; reference slots encode
`[namespace,id]` as canonical JSON. Signed decimals remain exact strings in the
unconstrained numeric slot. Quantity preparation calls Core
`canonicalizeCatalogQuantity` with the installed conversions, rejecting overflow
and `quantity_not_exactly_representable` before any SQL coercion. No Number
conversion, rounding, inferred unit factor or mixed revision is admitted.

`catalog_attribute_projection` is the single rebuildable SKU-keyed projection
specified by the [catalogue extension agreements](https://github.com/openlup/openlup/blob/main/docs/platform/CANONICAL_CONTRACTS.md#catalogue-extension-agreements).
Its key distinguishes SKU, publication revision, attribute key, definition version
and value ordinal. Text, decimal, boolean, date and reference slots accompany
quantity dimension, canonical unit and `numeric(52,12)` canonical value. The
projection has RLS enabled, owner-only access and no runtime grants or policies.
There is no publication-table FK before publications exist, no seeded revision
and no generation service. The preparation helper refuses quantity loss before
SQL coercion; it never inserts rows or commits independently. LC1/LC2 must integrate attribute validation,
candidate/publication digests and insertion in the single publication transaction.
The L1 required-locale predicate is not proof of a durable publish refusal.
Connected transfer carries authoritative product/SKU values and omits
projection contents even when populated. Restore leaves the projection empty;
rebuild and serving require later integration. No writer or consumer is activated.
The managed rail does not supply this feature.

The native axes forward adds nullable product `variant_axes` in display order
and SKU `option_values`, `canonical_option_bytes` and `combination_digest`.
The SKU-local partial unique index applies to active, non-NULL combinations per
product, regardless of product status. Existing legacy rows retain NULLs and all
existing identity constraints. The storage CHECKs require supplied options to be
objects and digests to be 32 bytes; they do not certify canonicalization.

`canonicalizeCatalogCombinationV2({definition, axes, options})` in the Node entry
computes canonical bytes and SHA-256. Supply installed immutable metadata and
complete selected options. Axis keys sort for identity; the product's display
array is retained separately. Stable enum IDs and booleans are canonical, labels
are excluded, and quantity equivalents share identity through Core's exact
arithmetic with explicit installed unit factors. Missing factors, unknown or
incomplete axes and unrepresentable quantities refuse. The existing option
helper and v1 command/receipt bytes retain their exact behavior.
V2 quantity options use Core's positive decimal-string grammar: up to 52 input
coefficient digits and scale 0–12, with canonical `numeric(52,12)` bounds checked
after normalization and conversion. V1 retains its 40-digit input ceiling.

`validateCatalogCombinationChangesV2` prepares retained plus incoming SKU facts
without I/O. Retained evidence must come from authoritative rows/history scoped
to one product; incoming changes accept options, never a digest. Omitted SKUs
remain unchanged, withdrawal preserves facts, and a changed mapped identity
requires a new SKU. Active typed SKUs require complete options and identity;
zero selected axes with explicit empty options has one canonical empty identity.
The helper refuses active duplicates; `classifyCatalogCombinationConflictV2`
compares bytes on a digest conflict to distinguish a duplicate from a collision.
Both refuse without merging identities. Payloads contain at most 10,000 SKUs;
the product capacity parameter defaults to 50,000 retained plus incoming SKUs.
This is pure preparation, not persisted capacity enforcement or publication.

An incoming mapped identity change reports `sku_identity_change_requires_new_sku`.
Inconsistent authoritative identity evidence or colliding derived digests report
`combination_identity_integrity_failed`; investigate these integrity failures
without rewriting retained identities. The earlier `combination_digest_collision`
code remains in the exported union and guidance record for compatibility; this
owner now reports the integrity code for that condition. Conditions and validation
order are unchanged.

LC2 must bind definitions and recompute evidence within the human-authorized
publication transaction, apply the
[catalogue lock order](https://github.com/openlup/openlup/blob/main/docs/platform/CANONICAL_CONTRACTS.md#catalogue-lock-order),
preserve published identity keys and immutable history, and prove explicit
legacy conversion and incremental publication. No publisher, lifecycle wiring,
serving reader or capability is activated here. Connected transfer carries the
new authoritative fields, including NULLs and declared order, in existing rows;
old readers ignore them, and future V2 readers require publication evidence.
The managed rail does not supply this feature.

Opt-in `priceAuthority: "effective"` on the native bundle store and the admin
`effectiveTarget` hook provide [effective bundle parity](https://github.com/openlup/openlup/blob/main/docs/platform/CANONICAL_CONTRACTS.md#m05-parity-seams);
`selectEffectiveBundleTargetPrice` is exported. Omitted seams preserve defaults.

The native envelope and dark draft adapters now live in this entry as
`createPostgresCatalogSkuEnvelopeReadPort` and `createPostgresCatalogDraftStore`.
They accept an injected executor and retain the existing mapping, errors and SQL
semantics. The mapper remains internal to the package. `CATALOG_MIGRATIONS`
projects canonical positions 1, 8, 58, 59, 61, 142, 143, 144 and 145 byte for byte, including
the nullable definition-binding, quantity, attribute and axes forwards; these assets are sparse references,
never a standalone install chain.

`createPostgresCommerceQuoteCatalogReadPort(executor, options)` implements the
strict quote catalog port using existing runtime `service_role` SELECT grants.
`options.verifyDocument(document, envelope)` is required host policy: admit the
opaque schema, check semantic identity against the envelope and verify its
canonical digest. It rejects with the existing `CommerceQuoteCatalogReadError`
from `./pricing`; unknown failures become `catalog_authority_unavailable`.
Current product/slug/pointer and revision id/product/number/schema/digest are
checked before inactive products are excluded; host verification then runs only
for included products. The adapter returns active SKUs sellable in at least one mode,
with positive physical grams and one primary unit GTIN. Prices remain separate.

Scans use keyset pages of 100 and `maxItems` (default 500, a positive safe
integer). Excess items or page budget, duplicate variant/code and repeated
cursor refuse the entire read. Missing verifier refuses configuration; missing
or changed authority never falls back to legacy data or an empty success.
Each call reads afresh; any shared promise must live within one host request.
Current-direct consistency does not establish a publication-wide snapshot or
qualify a publication head; that protocol remains a separate catalog boundary.

The composition entry adds `createCatalogContribution` and its structural input
interface. It describes actual catalog, pricing and promotions callables under
those existing module identities, with no environment discovery, client creation
or registration. It imports only readiness types: composition gains no catalog
edge. Catalog uses data at runtime for the native bundle writer and pricing for
the effective-window selector. Package boundary
checks pin those imports and peer-free composition declarations. The packed
consumer exercises both new stores and the descriptor without optional peers;
its synthetic executor proves named refusal, not durable storage behavior.


`./catalog` provides the existing neutral catalog
foundation, installed product types, draft validation/use cases, active SKU
selection, resolved SKU projection and sellable reference reads. Hosts supply
the read/store ports, verified operator authorizer, product-type registry and
BFF responder. Draft commands retain the original canonical bytes, receipt-first
replay, actor binding and named refusals. Read projections carry opaque
product-scoped document references; they do not interpret document payloads.

Fixed-bundle application/admin now uses this same server entry: rules, read/write
ports, batched stock derivation, nine mutations, four reads/price preview and the
public sellable-feed factory. The availability service deduplicates component
SKUs across compositions, calls the injected port once when SKUs are present and
skips it otherwise; the host port owns its query strategy, and missing answers
remain unknown. Named reference wrappers inject lifecycle and stock
helpers, existing admin kit/spec/flags, validators, responder, wire versions and
the packaged RPC error constructor. Read and write errors retain one package identity.
`createPostgresBundleCatalogStore` now accepts the data entry's injected
`PgQueryExecutor`; it renders the incumbent list/detail/feed/history SELECTs
without constructing a pool or switching roles. `createPostgresBundleAdminWriteStore`
binds the unchanged shared writer to the data entry's pooled role-free transaction
lane; it encodes the routines' three JSON arguments for the native driver while
preserving SQL null/default behavior. Hosts retain authorization, response mapping
and transport composition.
`BundleRpcError` and its `DomainRpcError` base are exported by this entry;
reference paths re-export those same constructors. `BUNDLE_MIGRATIONS`
projects canonical units 16 and 19 with their original paths, positions, hashes
and byte-identical SQL. These sparse projections are not an installation chain:
apply the complete canonical manifest. No new migration or activation is added.
Preview target selection remains the existing first active matching-mode row.

`./catalog/contracts` carries dependency-free DTOs, the shared authority error,
GTIN/authority helpers, quantity/option helpers and the existing draft JSON
canonicalizer. It imports no Zod, Node runtime or server barrel. Runtime schemas
use the server entry with jitless Zod; the reference browser keeps its sellable
schemas locally. Media manifest validation and `resolveProductMedia` are also
browser exports: declared product/variant/locale associations resolve to supplied
URLs with deterministic ordering and neutral fallback, without filename inference.
The server entry adds bounded source-pack export/validation/restore/import;
`BlobStoragePort` comes from the existing `@openlup/core/platform-runtime` entry.
Import validates every resource before uploading immutable digest keys, deduplicates
shared keys and never activates associations. No upload route is mounted.

Read and draft behavior is supplied by the existing use cases and host ports.
`publicationRead`, `publish` and `lifecycleWrite` remain explicitly unsupported
in the neutral reference binding. Lifecycle DTOs and server validation/publication
ports are types only, with an opaque publisher brand and no constructor or default
binding. A missing authority is `unsupported`; an unavailable configured authority
is `dependency_unavailable`, never an absent receipt. Successful readback requires
real publication lineage; existing active rows cannot invent a head. History pages
are bounded to 100 receipts with stable revision ordering and opaque cursors.
Existing SKU `draft`/`active`/`archived` and draft receipt `open`/`abandoned` wire
statuses remain unchanged. `withdrawn` may map from `archived` only where an
authority establishes withdrawal; abandoning a draft does not withdraw a variant.
Neither entry installs SQL. Rich application catalog interpretation remains
reference-owned. The [M05 plan](https://github.com/openlup/openlup/blob/main/docs/platform/plans/oss-m05-catalog-offers-pricing.md)
records the cut, its exclusions and the witness ledger.
The moved characterization suites are under `test/catalog/`; the required cold
consumer imports both entries without optional peers and checks installed
canonicalization, authority identity, selection and unauthorized draft refusal.
Three synthetic media conformance cases and one lifecycle type case complement
those moved suites; the existing package boundary tests cover browser closure.
Bundle browser schemas remain locally defined by the reference, preserving
parse/default/strictness behavior; the package contracts add plain DTO types only.
Installed callers inject validators into server factories. Five package suites
retain 44 bundle cases; two root binding suites retain 18. Four neutral W4 cases
and one binding/browser-closure case add five required cases. The cold consumer
also checks bundle composition refusal, unknown stock and exact allocation;
catalog server is deliberately classified as an adapter because its declarations
reach optional pg types through the executor. Its runtime still imports and reads
through an injected executor with optional peers absent. Catalog contracts remains
a non-adapter and compiles without peers. Server declarations compile after peer
selection. Five real-PostgreSQL cases characterize full-chain replay, complete
ordered reads with unchanged data, whole-set rollback/refusals/dry runs, price
history, sequential key recognition and explicit invoker grants. Native routines
have no independent human-only actor-kind gate; the handler supplies that gate.
This does not close the bundle parity ledger.
The complete contracts entry measures 3,281 B minified+gzip against its 4,096 B
budget; other entry and aggregate caps are unchanged.

Moved catalog, pricing and promotion fixtures use synthetic identities, regions,
currencies and host-defined context fields. Their assertions retain the original
operators and case counts. Reference classifiers receive the legacy threshold
from their host composition; only the immutable managed baseline predicates
await an owner decision. Pricing VAT calculation retains
both exported helpers and their signatures: `calculateIncludedVat` delegates to
`splitIncludedVat` through a distinct named wrapper using the same arithmetic.

### Native offer-policy readiness inputs

The catalogue SQL descriptor includes native-only, unbound readiness inputs for
price-writer integration. Installation distinguishes existing subscriptions
from future pending acquisition and records the original cohort marking; it
never performs the operator's audit or captures the rollout baseline.

After auditing every legacy non-fixture subscription, including paused and
cancelled rows, service authority can explicitly invoke
`commerce_capture_offer_policy_v2_legacy_baseline()`. Capture takes no caller
count or fingerprint and never overwrites an existing baseline. A zero baseline
requires empty installation provenance and a currently empty cohort. Missing
provenance, changed membership and incomplete financial or historical order
proof fail closed. The internal helpers only read; they grant no writer,
provider, deployment or activation capability. Existing TypeScript readiness
contracts and subscription agreement/schedule behavior remain unchanged.
See the [migration and transfer owner](DATA_AND_MIGRATIONS.md#native-offer-policy-inputs).

## Scheduled jobs

See [scheduling selected work](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/how-to/operate/self-host.md#select-background-work).

A job is `{ id, schedule, lease?, run(context) }` with a UTC cron expression. Domains and packages contribute jobs to `createScheduledJobRegistry`, which refuses duplicate ids and ships empty. The Node host runs registry jobs on its own timers and calls `run` directly, with no HTTP request and no secret. `createScheduledJobHttpEntry` mounts the same job behind the cron guard for a hosted cron. A job that declares `lease` runs only after the injected job-lease port grants it; a lease held elsewhere skips the run, and a finish the port refuses fails the run. `scheduledJobsFromContribution` turns a contribution's cadence schedules into jobs and refuses a cadence that no cron expression matches exactly; a contribution run that reports a failed outcome fails the job.

Schedules are authored in UTC; a Node adapter must interpret them in UTC to
match hosted cron. `createNodeScheduler` forwards its optional `timezone` to
`node-cron`. The higher-level `createNodeHost` does not set that option, and the
pinned `node-cron` uses the process-local timezone when none is supplied. A Node
host using UTC-authored schedules must therefore run its scheduler in UTC.

`NodeSchedulerAdapter.stopAll()` returns `Promise<void>`. It fences and stops the
current registrations synchronously, then waits for callbacks already admitted,
including pending lock acquisition and unlock. Await it before disposing their
resources; custom scheduler implementations must return that drain promise.
The adapter calls each supplied timer's `stop()` with its original receiver;
receiver-dependent timer implementations such as `node-cron` retain their state.
Later registrations remain supported. The Node host caches its `stop()` promise,
keeps its listener and dedicated PostgreSQL lock session available until the
drain settles, then attempts both cleanup operations even after a drain failure.
This lets an admitted HTTP-bridge callback finish its local request after a
pending lock acquisition. The [composed HTTP witness](../../packages/platform/test/composition/nodeHost.test.ts)
uses a real local listener and bridge request across that shutdown boundary.

The PostgreSQL lock adapter also reserves each numeric advisory key locally
before acquisition. This prevents reentry on the same session, including pending
acquisitions and colliding job IDs. Contention releases the reservation;
uncertain acquisition refuses that job and further grants with an actionable
error, retaining its reservation until session disposal. Each acquired key is
observed on the same backend in a separate statement before the job runs. A
changed PID or missing lock ownership refuses with
`OPENLUP_E_ADVISORY_SESSION_AFFINITY`; release also checks the backend and
requires an actual unlock. Failed unlock retains the reservation. Use a dedicated
direct connection or session-mode pooler, never `Pool.query` or transaction
pooling; a finite check cannot certify a pooler's configuration. Follow the
[connection recipe](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/how-to/operate/connect-postgresql.md#assign-connections-by-work)
when runtime `DATABASE_URL` uses a transaction pooler. The
[qualified PG16 witness](https://github.com/openlup/openlup/blob/main/tests/postgres/m14QualifiedComposition.test.ts)
proves pooled requests, session exclusion and backend-switch/reset refusal before
the body, plus refusal to unlock another backend's grant. The
[disposable PostgreSQL witness](https://github.com/openlup/openlup/blob/main/tests/postgres/nodeHostRuntimeDrain.test.ts)
checks same-session exclusion and replacement-host admission after drain.
This graceful-stop contract does not fence an old host at external provider I/O
or settle an effect accepted before an acknowledgement; the
[transfer boundary](https://github.com/openlup/openlup/blob/main/docs/platform/ARCHITECTURE_AND_EXTENSIONS.md#existing-store-transfer-and-recovery)
retains those separate duties.

## Bundle readiness

See [bundle selection and admission](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/how-to/operate/self-host.md#select-the-bundle).

`PLATFORM_BUNDLE` selects `vercel-supabase` (the default when absent), `node-supabase` or `node-postgres`. A bundle's readiness refuses, before any traffic or timer: an unknown `PLATFORM_BUNDLE` (resolution itself still falls back to the default); a self-host bundle without `APP_BASE_URL`; and, reported together under `OPENLUP_E_ENV_MISSING`, every selected capability without its settings: the scheduler without `CRON_SECRET`, Node scheduling without `DATABASE_URL` for its cluster lock (never a silent single-instance lock), and the selected blob capability without its settings (see Blob storage). An unknown `PLATFORM_BLOB` is refused too. The Node host checks readiness at boot.

## Blob storage

See [storage configuration and injected clients](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/how-to/operate/self-host.md#supply-configuration-and-storage).

`PLATFORM_BLOB` selects the blob capability; without it the bundle's own applies (filesystem for node-postgres, the local development default). `bindBlobPort` builds each one from the environment and the clients the application injects:

- `filesystem`: `BLOB_FS_ROOT`, `BLOB_FS_BASE_URL`;
- `s3`: `BLOB_S3_BUCKET`, `BLOB_S3_BASE_URL`, and a default client from `createS3ClientFromEnv` (`BLOB_S3_REGION`, `BLOB_S3_ENDPOINT`, `BLOB_S3_FORCE_PATH_STYLE`, `BLOB_S3_ACCESS_KEY_ID` with `BLOB_S3_SECRET_ACCESS_KEY`). `@aws-sdk/client-s3` is an optional peer loaded on first use, so only an application that selects S3 installs it;
- `supabase`: `BLOB_SUPABASE_BUCKET` and `BlobBindingDeps.supabaseStorageClient`, a factory returning the structural `SupabaseStorageClient` declared in blob. Blob itself reads no data-gateway settings. The default composer supplies this factory from the data-gateway settings and its optional `createSupabaseClient` dependency, using the service-role key with `persistSession: false` and `autoRefreshToken: false`. For this binding, a blank `SUPABASE_URL` falls back to `VITE_SUPABASE_URL`, consistently with readiness;
- `vercel-blob`: the injected `@vercel/blob` module and `BLOB_READ_WRITE_TOKEN`.

The Node host passes the composed ports, blob storage included, to the HTTP runtime builder and to the jobs contributed to it. The reference repository's compose file starts a local S3-compatible service with `--profile local-storage`; missing storage credentials refuse at service startup, while an omitted `OBJECT_STORAGE_PORT` selects an ephemeral loopback port. The inactive profile requires no storage settings. A conformance test runs upload, read-back, delete and access refusal against that image; initialization failure with Docker available fails the test. Hosted S3 provider certification is not claimed.

## What the application supplies

See [host composition and application-owned inputs](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/how-to/operate/self-host.md#compose-the-host).

- the BFF route table, the not-found response, the request preflight and the per-request hook;
- how a request reference is chosen, and the health payload with its strict contract;
- the security header policy, including the content security policy, the production hosts and the robots.txt body;
- its own entrypoints, by exact path or by path rule;
- the job configuration file or object, the direct job bindings and the host admission check;
- the migration catalogue, the migration lock name and the object-inventory projector;
- the release correlation, default failure reason and read-failure messages that the job-run ledgers record;
- the environment, passed explicitly, and the provider clients it needs (the Supabase `createClient`, the `@vercel/blob` module, optionally its own PostgreSQL gateway factory), so the package itself reads no environment variable (an injected SDK may read its own credentials; the static and migration roots default to the working directory). Its optional PostgreSQL peers are `pg` at runtime and `@types/pg` for declarations; `@aws-sdk/client-s3` is loaded lazily by the default S3 client. Blob declarations use structural types and need no S3 SDK;
- an optional scheduler profile for the Node host: a fenced projection of the declared jobs with its own bindings and validation hooks.

`createBundleComposer` binds the blob slot by default; pass `createBundleComposer({ createSupabaseClient })` to enable its Supabase Storage binding when the data-gateway settings and bucket are present. Without that client Supabase Storage stays unbound. A custom `blob` binder still overrides the default. The HTTP, scheduler, data, migrations, analytics and transactional slots stay `null` until the application supplies their binders; `createDataBindings` builds the data binder from the application's database client factory.

For payment and fulfillment provider adapters, the host supplies clients and
policy and composes only declared port capabilities and refusals. Read the
installed `./payments/contracts` or `./fulfillment/contracts` declarations and
their maturity before binding; an exported adapter does not activate a provider.

Fulfillment descriptors optionally declare intake, reservation ownership,
consumption, movement support, split support, transport selection and label MIME
formats. Omitted fields preserve existing defaults. Native services refuse
unsupported declarations before host/store/provider work. Use
`readFulfillmentCapabilities` with an optional operation/format probe for the
[documented execution limits](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/reference/limits.md#fulfillment-execution-limits).
The native binding forwards `capability.intakeMode`; standalone dispatch-store
hosts pass it in the store options. Snapshot-only stock workers take
`stockMovements: false` and return a separate movement refusal.

## Job-run ledger SQL

See [the ledger install-path constraint](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/upgrade/database-migrations.md#select-the-complete-catalogue).

`JOB_RUN_LEDGER_MIGRATIONS` lists the files a fresh installation applies, in order, through its own migration chain:

1. [`sql/20260809150000_job_run_ledger.sql`](../../packages/platform/sql/20260809150000_job_run_ledger.sql): the job controls, runs, and the v2 claim and finish; its bytes and migration identity equal the reference application's platform migration of that name.
2. [`sql/20260809150001_job_run_ledger_v3.sql`](../../packages/platform/sql/20260809150001_job_run_ledger_v3.sql): the v3 claim and finish the PostgreSQL ledger calls, as `CREATE OR REPLACE`, with bodies byte-equal to the reference chain's definitions.
3. [`sql/20261125070000_job_run_finish_lease_fence.sql`](../../packages/platform/sql/20261125070000_job_run_finish_lease_fence.sql) fences the finish by the current lease token. Apply the pending forward through your existing migration chain.

The package SQL and the reference application's platform migration chain are alternative install paths, never applied together: the reference chain defines all four job-control functions itself, with plain `CREATE FUNCTION`, so it fails on a database where the package SQL already created them. The package file `20260809150001_job_run_ledger_v3` has a migration identity no reference migration uses. Importing the package never applies SQL.

## Optional peers

`pg`, `@types/pg` and `@aws-sdk/client-s3` are optional peers. Install `pg` and
`@types/pg` alongside this package when selecting PostgreSQL adapters; install
`@aws-sdk/client-s3` when selecting S3 blob storage. Loading an unselected adapter
never installs or initializes its SDK. The PostgreSQL scheduler lock also loads
`pg` only on its first operation.

A selected capability whose SDK is absent rejects its first loading operation
with `OPENLUP_E_PEER_MISSING: <package> is required by <capability>; install it
alongside @openlup/platform`. The original module-resolution error is the cause.
A broken SDK, a missing transitive dependency or a provider error propagates
unchanged. Blob `exists` retains its boolean contract and returns false on a
failed HEAD; use an upload or list operation to observe an S3 loading refusal.

## Verification

This package's tests are part of the repository's required test selection; from this directory, `npm test` runs them alone. The tests rewrite the originating application's characterization with neutral names and synthetic data, and a boundary test refuses environment reads and provider imports outside its explicit `pg` adapter and `@aws-sdk/client-s3` blob-client allowlist. Follow [repository testing](https://github.com/openlup/openlup/blob/main/CONTRIBUTING.md#test-scope-and-diagnostics) for placement, setup and speed rules.

The module-boundary proof permits one optional `./<module>/contracts` export
only when that module declares `contracts: true` in `PLATFORM_MODULE_GRAPH` in
[`eslint.config.js`](https://github.com/openlup/openlup/blob/main/eslint.config.js). Its `types`, `import` and `default`
targets follow the module entry shape at `dist/<module>/contracts/index`.
Contracts files may import only their own contracts subtree through canonical
relative `.js` paths and exact public `@openlup/core` entries. Both ESLint and
[`packageBoundary.test.ts`](https://github.com/openlup/openlup/blob/main/packages/platform/test/packageBoundary.test.ts) enforce this allowlist
for static imports and re-exports (including types) and literal `import()`;
they refuse non-literal `import()` targets. Both checks reserve the identifier
names `require`, `module`, `exports`, `process`, `globalThis`, `global`,
`__dirname`, `__filename` and `Buffer` in every value and type position,
including local and property identifiers, and refuse every use of `import.meta`.
This rejects loader aliases and wrapped calls regardless of the load target.
The existing non-literal `require` member-call guard also remains, including
computed property calls.
The package test additionally requires every file in the contracts subtree to
be a scanned `.ts` file, refuses triple-slash type and path references and all
meta-properties (also `new.target`), and retains member-call `require` detection
outside contracts. Identity declares this entry; synthetic graphs also exercise these checks.

The job-run ledger SQL asset test verifies a readable, nonempty file within the
package SQL directory. Its SQL parity tests bind the actual adapter calls to the
shipped routine signatures; the asset's explanatory header may be edited freely.

`npm --workspace @openlup/platform run api:check` compares every declared entry graph with the
committed `api/*.api.md` reports. After building, deliberately regenerate them
with `node --experimental-strip-types ./scripts/api-contract.ts --update` from
this package, and review the declaration changes.

Current measured caps and the published release baseline are owned by
`release-gates.json`; [Package artifact limits](#package-artifact-limits) describes
the checks.

The source-checkout binding `npm --workspace @openlup/platform run test:consumer` runs
[`platform-cold-consumer.ts`](https://github.com/openlup/openlup/blob/main/scripts/packages/platform-cold-consumer.ts).
It requires the cold package producer's verified `OPENLUP_PACK_MANIFEST` and
exact `OPENLUP_PACK_COMMIT`; it never substitutes a workspace build or repacks
on refusal. `ci:required` invokes that proof; API checks remain in the shared
cheap phase. The producer must include publishable core and platform tarballs;
the package inventory includes both at the same set version. Cold packing requires a clean committed package tree; an uncommitted preparation cannot produce the manifest.

The proof installs those tarballs, locked Zod and explicit Node type tooling
offline from the default npm cache into an OS temporary directory outside the checkout.
It verifies optional-peer absence physically and through both CommonJS and ESM
resolution, refuses symlinks and ancestor package sources, checks the complete
export classification, imports every nonadapter entry with an empty environment,
and compiles its types in strict NodeNext and Bundler modes without skipping
library checks. A type leak fails the proof even if runtime imports pass.

It then checks actual missing-SDK refusals, installs the three peers at the root
lockfile's exact versions using `npm install --prefer-offline --min-release-age=3 --no-audit --fund=false`
and the default npm cache, compiles all adapter declarations and runs the real SDKs against owned
in-memory fixtures: S3 upload/HEAD/list/delete through the real SDK and
deterministic invalid-URL refusals after the default SDK/driver loads.
These fixtures contact no live provider. The PostgreSQL adapters then run their SQL conformance
against a disposable database: the CI job's pinned PostgreSQL service when the job supplies its
identity (`OPENLUP_PROOF_SERVICE_CONTAINER` and `OPENLUP_PROOF_SERVICE_PORT`), as the outbox proof
uses it, or otherwise an owned, labelled container of the same pinned image. There is no skip:
without either the proof fails. Temporary consumer files, the proof database and an owned container
are removed on completion. Missing cached packages fail the initial offline installation;
the SDK-present install can fetch missing registry metadata or packages. Neither
phase redirects npm to an empty temporary cache.
Raising a peer pin within three days of that version's release makes this proof fail with npm's own no-matching-version error until the version ages.

The composition declarations describe the injected Supabase factory structurally;
they do not import the data entry or its PostgreSQL types. The cold proof still
requires all declared non-adapter entries (including `./identity/contracts`) to import in fresh processes and compile
in both resolution modes with all three optional peers absent.

## Package artifact limits

The monorepo's package artifact checker enforces this package's
`release-gates.json` caps and packed content allowlist. Only
`--release-set <version>` checks compressed growth against the last released
baseline, with explanations in the new set's changelog section and release body.
For the published `1.1.0` set, comparison used the published `1.0.0` tarball;
releases before `0.43.0` remain in the source-only `CHANGELOG-HISTORY.md`. Its browser-safe `./identity/contracts` export also has a minified+gzip cap. See the
[package artifact policy](https://github.com/openlup/openlup/blob/main/.github/VERSIONING_AND_EOL.md#package-artifact-limits)
for measured sizes, current caps, the S1 baseline refresh and refusal remedies.
Artifact checks require a clean package directory; `--manifest-only` supplies no
artifact evidence.

## Payments prepared attempts

`@openlup/platform/payments` exports `executePreparedAttemptMechanism`: validate before durable preparation, refuse prepared replay, dispatch once unless the host proves no charge, and retry one immutable local finalization. The host owns keys, fingerprints, nominal error trust and persistence. An unknown execution never authorizes redispatch. The reference facade retains its existing binding.

`./payments/contracts` is type-only: execution/dispatch, transient method handoff, capability overlay, verified money/method evidence, bounded readback/absence, neutral refusals, refund observations and multi-subject conformance fixtures. Verification uses receipt time for freshness; ingress starts processing at receipt time and reuses durable first receipt on redelivery. Event identity includes outcome class. Transient authorization and opaque handoffs never enter persisted diagnostics. Capability support is explicit; timeout/truncation is unknown, never exact absence. Refunds require explicit evidence by default; `legacy-assume-full` is an explicit host opt-in. See the [M07 ledger](https://github.com/openlup/openlup/blob/main/docs/platform/plans/oss-m07-payments-money-truth.md).

The payments entry also exports verified ingress, canonical truth fingerprints, method lifecycle/refusal handoff, reconciliation/verify-now and three runner-independent conformance functions. A new internal boundary projects verified envelopes into the contributed processing carrier: original bytes reach verification unchanged, receipt time starts processing, and durable first receipt overrides redelivery time. Full-reversal chargebacks use the existing dispute path. Snapshot and delta observations preserve original payment money; missing observation, required money or identity refuses before terminal application. Missing money, amounts that are not safe positive integers, or blank currencies on succeeded, refunded or disputed adapter evidence use the existing amount-mismatch refusal before ingestion or terminal application; ingress returns the existing processing-failure response. Failed and pending evidence may still omit money. Hosts own durable stores and response transport. Conformance requires safe positive integer amounts and nonblank currencies on settling money and checks exact identity/money, capability/port agreement and transient-secret exclusion; its evidence contains no handoff. Real-store durability still requires a selected-store proof.

The next paragraph records the earlier direct-truth-only profile. The published
package includes the provider store described below and its matching native
migration.

`createPostgresPaymentTruthPort` accepts the platform data executor structural
shape and `PostgresPaymentTruthOptions` from the contracts entry. It preserves
the native truth ingest, reconciliation, sweep and readback SQL. `PAYMENT_MIGRATIONS`
projects canonical units 10/35/56 byte for byte, with path, position, SHA-256 and
asset URL; install the complete catalogue, never those three files alone.
`paymentSchemaDescriptor` admits direct truth, settlement and later-only cycle
alignment, and explicitly refuses prepared durable storage, method setup,
absence reopen and cumulative refund. Refunds are purely financial. Seven real
PostgreSQL cases cover fresh/prefix installs, replay/conflict, unknown readback,
lost acknowledgement, rollback, denied access, dunning/recovery, concurrency and
later-only dates; this does not claim managed-store parity or host activation.

The following paragraph describes the attempt-store prefix. The subsequent
method-reference forward adds collection to that prefix as described below.

The next three paragraphs record the earlier provider-store checkpoint; the
0.42.0 qualification below supersedes its uncomposed capabilities.

The current native chain through `20261114100000_payment_provider_attempt_store.sql`
adds `createPostgresPreparedAttemptPersistencePort`,
`createPostgresProviderPaymentControlPort` and
`createPostgresPaymentWebhookControlPort`. Explicit intent admission allocates a
separate durable payment identity. Preparation persists request authority before
the provider call; finalization acknowledges that same row. An unresolved attempt
replays without another dispatch. Verified ingress persists independently of result
application, which refuses unresolved or stale attempt attribution before effects.
`paymentSchemaDescriptor.preparedDurableStore` is now `supported`; method setup,
absence reopening and cumulative refund remain `unsupported`.

Correlated provider renewal failures record an immutable native retry failure
receipt with the exact provider attempt, sequence, cycle and observation facts.
The retry owner records settlement first; truth reuses its settlement key and
omits generic dunning-case creation for that receipt. Rung and schedule come from
the receipt, with `payment_pending` retained on the cycle. Provider dunning case,
notice and token handoff await attributed composition. A real provider renewal
binding is not supplied at this stage; the starter still binds sandbox renewal.

With `20261114110000_payment_method_refs.sql` installed, `methodSetup` is
`supported`. Compose `createPostgresPaymentMethodSetup` with a host-authenticated
principal, the selected adapter's `methodPort` and host-owned customer creation.
It checks subscription ownership before provider I/O, reuses a recorded customer
and preserves stable customer/setup keys. The account facade can select it as
its `paymentMethod` lane with `paymentMethodSetup: { supported: true }`.
No lane is selected by importing or installing the package.

`createPostgresPaymentWebhookMethodRefPort` records reusable references;
`consumePostgresPaymentMethodDelivery` applies lifecycle facts and schedules only
eligible recorded retries before setup close. Method evidence uses
`resolveMethodOwner`; saved-method money evidence uses the additive
`resolveSavedMethodOwner`. Neither trusts adapter metadata as ownership.
`createPostgresRecordedSubscriptionMethodReader` returns `method_ref_not_recorded`
for historical labels or mirrors without recorded evidence. Scope repair is
explicit and batch dry-run is the default. For native host-composed real history,
missing recorded references block retries, recovery, reactivation, timed auto-resume
and upcoming reminders until the host records refs with `payment_method_ref_upsert`.
Original renewal charging keeps its previous method and mandate evidence behavior
when no recorded reference exists, even with real-provider history. Once any
reference row exists, every reader uses strict recorded authority, regardless of
its status or active state. Account-support health and lifecycle admission follow
the provider-history classification even without a reference. Setup keys are
trimmed and must contain 8–180 characters. Explicit
sandbox behavior is preserved; an initial captured
checkout alone does not override a completed sandbox attachment/current terms. See the
[method-history limits](DATA_AND_MIGRATIONS.md#module-catalogues-and-installed-histories)
for the schema and manual-path boundary. Collection, linking and scheduling do
not settle money or alter subscription service. Expiring methods can remain
chargeable until expiry; dispatched repair authority cannot be substituted.
Offline PostgreSQL and fake-client witnesses establish this selected store path;
provider activation and joined renewal composition remain separate.

The 0.42.0 source qualification adds the complete chain through
`20261114120000_payment_reconciliation_refund_evidence.sql` and
`createPostgresPaymentProviderReconciliationPort(executor, options)`. The port
claims recorded attempts, commits exact-identity application and reconciliation
evidence atomically, and opens or advances dunning only from an immutable
attempt-bound failure rung. Same and stale observations replay without changing
case, authorization or notice authority. Historical unattributed cases return a
named refusal while retaining applied money.

Once the durable capture evidence migration is applied, native provider success
requires a signed webhook or a recorded provider readback for the active payment
attempt. Both carry the actual received amount, currency and
`capturedAmountBasis: "provider_capture_v1"`. Custom reconciliation callers
supply that basis with the observed `amountMinor` and `currency` and
`normalizedStatus: "succeeded"` in the readback payload after confirming the
capture through the provider. Use the active attempt's stored remote reference
for that lookup. Apply the packaged migration and update the payment runtime
together. Exact completed results and ordinary decline evidence remain valid.

`paymentSchemaDescriptor.absenceReopen` and `.cumulativeRefund` are now
`supported` for that installed chain. Auto-reopen remains default off. Explicit
absence proof, watchdog evidence, age and conflict guards authorize one recorded
provider sequence without spending customer retry budget or bypassing existing
dispatch receipts. Cumulative refund evidence uses a maximum per charge; original
payment money remains unchanged. Refunds preserve subscriptions and paid-cycle
history, releasing only eligible held reservations for that order.

On the native rail `commerce.order.refunded` means the status only, with no
money-moved claim. Customer “refund processed” messaging must use the
evidence-gated `commerce.order.refund_processed` path. Monetary readback through
`payment_refund_readback` requires accepted same-currency evidence. A status-only
refund cannot produce that financial notice. The native rail supports the two
reference payment providers through declarative profiles; a third provider needs
a profile declaration plus its adapter. Refund creation and live-provider activation remain separate work.
See the [native payment limits](https://github.com/openlup/openlup/blob/main/docs/platform/DATA_AND_MIGRATIONS.md#module-catalogues-and-installed-histories).

The additive provider recovery factories read bounded evidence and use the existing
checkout admission owners: `createPostgresProviderPaymentRecoveryGuidancePort`,
`createPostgresProviderExpiredCheckoutSafety`,
`createPostgresProviderCheckoutRecoveryAttemptPort` and
`createPostgresProviderInlineRecoveryAttemptPort`. Their host still supplies
recorded provider authority, verified ingress, evidence normalization and route
composition. Historical intents are never backfilled; missing handles stay in
flight and do not prove absence. Install the complete selected migration chain
before composing these ports. Offline PostgreSQL proof does not activate a
provider account or qualify a complete hosted payment journey.

The 0.42.0 source candidate also adds `createPostgresProviderPaymentRail` from
`@openlup/platform/payments` and `createPostgresProviderRenewalBinding` from
`@openlup/platform/subscriptions`. These supersede the uncomposed checkpoints
above for an explicitly selected card provider host. The
[server example](../../examples/neutral-store/host/provider-portable.ts) binds the
renewal webhook control, lifecycle and retry ports together; the starter does
not select it. Supply host authentication, client construction, mode policy,
population lease, inventory, readiness and frozen execution inputs.

The neutral factory forwards customer, client, order and save-card facts and
returns redacted `persistence` facts beside transient handoff. A committed prepare
precedes the provider call. Replays and uncertain replies never dispatch again.
Use independently committed executor calls for payment execution; never enclose
the provider call in a database transaction. `controlFor` binds result application
to a host transaction after provider I/O.
card provider readback supplies no provider occurrence time, so signed evidence completes
native renewal bookkeeping with the payment owner's existing settlement key.
First receipt and provider time remain separate. Reconciliation results retain
their committed `reconciliationId`. A synchronous decline retains its nullable
remote handle and consumes the existing failure rung before attributed dunning.

Original renewal dispatch checks the addressed method and customer against the
current recorded authority whenever any method reference exists. A healthy
replacement never authorizes the stale input; no-ref original renewals retain
their existing path. Finalized SCA-required attempts resume through the persisted
refusal owner using the durable execution key and prepared instant. Untimestamped
ingress keeps native occurrence null and returns no occurrence instant, including
on replay. Superseded and unresolved success events reach native exact-attempt
validation and its acknowledgement path before recovery bookkeeping. This uses
the event's durable attempt link, not the current remote handle: finalizing a
matching handle after unresolved ingestion leaves that event unresolved on every
redelivery, without business-state changes.

The native rail supports the two reference payment providers through declarative provider profiles. A third provider needs a profile declaration plus its adapter.
Install the complete catalogue through
`20261121090000_payment_provider_profiles.sql` to use the profile-based generic
predicates. The immutable `payment_provider_profile(text)` resolves closed policy
data; unknown admitted providers retain their existing generic behavior, with
claims and reopening disabled. The reference adapter implementations carry typed profile declarations;
a profile declaration does not activate an adapter. Existing evidence fields,
result codes, replay responses and refusal order remain unchanged.
The optional `executionFlows` argument on `createPostgresProviderPaymentRail`
lets a host select existing protocol flow labels; omission preserves the current
one-time/off-session mapping and supplies no additional provider composition.

This composition selects card provider only. The second reference provider's portable
composition and live-provider qualification remain follow-up work. Existing
managed exports and the default sandbox bindings remain available.

The published package includes `createPostgresSandboxPaymentSimulator` and its
matching native migration. The simulator requires the complete native chain
through `20261101222000_sandbox_payment_attempts.sql`. Its server commands use
the existing `sandbox` settlement channel only. The host authorizes
`beginAttempt`, `recordObservation` and `readAttempt`; do not expose those commands
as unauthenticated browser actions. No key or provider SDK is needed. Beginning
records dispatch conservatively; a replay returns the same row with `replayed`
and never authorizes another dispatch. An unresolved/indeterminate attempt
blocks a replacement. Terminal ingress also resolves older unknown truth for the
same attempt; replacement waits while such truth is still open. A definite refusal or expiry may be followed by a new
attempt; a still-active refused/expired attempt can instead receive late capture.

The simulator's `ingress` composes the existing verified ingress and PostgreSQL
truth port. Deliver original JSON bytes containing exactly `settlementIntentId`,
`attemptId` and `observationId`. Verification reads a server-recorded observation;
a browser return/status without that fact refuses. Recording an observation
alone never marks an order paid. A stale durable observation is acknowledged with
the existing `result_attempt_mismatch` skip and cannot apply money. Exact identity, money, observation and active
attempt checks use only durable database state. Accepted event replay preserves
the original fact after a later observation or attempt, including after restart.
No generic prepared provider store, real mandate or real money is enabled;
`paymentSchemaDescriptor` and real-provider refusals keep their meaning.

Attempt readback includes `settlementChannelKey` and `methodFacts`:
`authorizationRef`, `unattendedChargeAuthorizedAt`, nullable `payerAccountRef`,
`methodRef` and `methodEvidenceRef`. Empty initial facts request synthetic server
references. Subsequent renewal/retry/recovery can pass the saved facts explicitly,
retaining the original authorization time. Attach purchase terms only after the
exact active captured attempt's order is paid and its settlement settled. Renewal
composition reuses the attempt store with its existing settlement transaction;
it must not also settle that renewal through purchase ingress.

A verified capture after cancellation remains an operator-visible captured truth
row with `reviewRequiredAt` and `applicationStatus: "review_required"`. Its stored
state remains `open` with no settlement transition, but it is terminal for the
open-event sweep and reconciliation. The order stays cancelled; no automatic
refund or fiscal work is created. Recovery-notice contention can still roll back
ordinary capture settlement: retain the observation and redeliver the same event
after contention clears. The simulator never redispatches that captured attempt.

Attempt input adds optional method selection with opaque, persistable channelRef
and transient payer email/name. Payer contact is dispatch-only: never persist,
audit, log or diagnose it. Missing adapter-required input must refuse before
dispatch with exact `notDispatched` evidence. Conformance scans the execution
and complete projected stored payload for transient values. Nested normalized
evidence copies only declared typed fields, including nested facts; unknown
extra properties are excluded. Incomplete chargeback evidence remains stored as
a refund and unapplied, a declared operator recovery limit: reclassification
would apply the originating dispute path without checking completeness.

`createCheckoutActivePaymentActionResolver` authorizes the exact owner, order,
intent, attempt and execution rail, reads the provider once, then rechecks the
complete canonical attempt. Hosts inject synchronous `railHandoffKinds` from
adapter capture capabilities; an unknown rail supplies an empty list. Actions
carry the provider address and the existing transient `PaymentMethodHandoff`.
Pending evidence alone may expose a handoff; terminal, mismatched, unknown or
raced evidence refuses it. `createCheckoutRecoveryPaymentResolver` preserves
paid/retry/resume/wait/manual-review ordering without creating a new obligation.
`createCommercePaymentVerifyHandler` validates the existing identity triple,
checks stored ownership before readback, and uses the shared HTTP/responder
contracts. A host may inject its responder to preserve request references.

`PaymentRepairMethodPort` collects a method only; it grants no token redemption,
subscription change or payment success. Unsupported setup is explicit. Method
evidence may carry neutral registration refs/kind/status. Ingress projects them
only with `resolveMethodOwner` supplied by the host; adapter-supplied client or
subscription fields never confer ownership. Without host ownership resolution,
registration is not projected. Lifecycle carriers copy typed facts only.
The existing refusal handoff accepts a failure-reason string, not a typed
adapter refusal envelope; envelope forwarding remains unsupported.

### Test a payment adapter offline

`@openlup/platform/payments/testing` is a testing kit
for adapter authors. It re-exports `runPaymentAdapterConformance`; the existing
`./payments` export remains available. `createScriptedPaymentFake` supplies a
separate FIFO queue per injected transport call, with success, provider 5xx,
timeout before/after dispatch and redelivery 409 outcomes. It performs no I/O,
waits or retries and records call names/outcome kinds only. HTTP bindings can
provide a synthetic response for 5xx/409; SDK bindings receive a synthetic error.

```ts
import { createScriptedPaymentFake } from "@openlup/platform/payments/testing";

const transport = createScriptedPaymentFake<{ create: { id: string } }>();
transport.enqueue("create", { kind: "success", value: { id: "remote-fixture" } });
const client = { create: () => transport.invoke("create") };
await client.create(); // Inject this binding into the adapter under test.
transport.assertDrained();
```

In the author's test, pass `PaymentAdapterTestSubject[]` to
`runPaymentAdapterConformance`. Supply `safety` on each subject for the named
offline suite: `capabilityInputs` demonstrate every declared family of every
capture flow with that flow's handoff, every declared currency,
and unattended support or refusal; `transport` invokes the real adapter against
each scripted failure; `webhooks` supplies signed original bytes and independent
expected evidence for valid/duplicate delivery, signature mismatch, partial/zero/
missing amount, missing currency and chargeback. `partialMoney` pins exact minor
units. Optional close/absence ports are exercised when present; refund creation
and split authorization/capture are structurally absent. Baseline subjects
without `safety` retain the existing, narrower checks. Each capability input must
identify a supplied subject by its intent/attempt pair; dispatched remote references
must equal that subject's independent readback reference. All returned executions,
including capability and transport probes, share diagnostic redaction validation.

A typed map covers all 17 current `PaymentAdapterCapabilities` keys, including
inherited descriptor fields; adding a key requires an explicit check at compile time.
Mandate probes compare `assessMandate` with validation and execution for absent,
null, admitted and unsupported model evidence. Required stored evidence and payer
context must refuse when missing; the payer probe removes `payer` from the
unattended capability input, checks validation and dispatch when payer is optional,
and is recorded as not applicable when unattended is unsupported.
Refusal probes require `providerRequests()` (the count of every injected-client
invocation, recorded at entry before parsing or assertions) to stay unchanged whether execution throws or returns;
a returned refusal must be an exact `notDispatched` decline before dispatch.
This includes the first unsupported unattended invocation, which must return that
typed decline; a throw does not satisfy it.
Unsupported currency must refuse both validation and execution. Each successful
capture execution must match a declared flow for its family: customer authorization
must be present in the input, or the returned handoff kind must match the declaration.
The kit checks the five host-consumed declarations `unattendedChargeFlow`,
`methodHealth`, `terminalOutcomeReporting`, `mandateUpsertIsSubscriptionScoped`
and `payerContext.customerRefFallsBackToContactEmail` for shape only, and each
adapter pins their values in its own witnesses.
The attempt input has no customer-reference, method-kind or subscription-write
port, so this kit cannot prove host method-health admission or mandate persistence.
The card fixture dispatches without a customer reference despite the declared
method-health prerequisite; the bank/code fixture reads a terminal status while
its descriptor names attempt records. These are observed boundary limits, not
host-policy parity or adapter repairs.

The runner checks replay identity and ingress calls with an in-memory host;
it does not establish durable-store idempotency. Signature refusal and unusable
settling money must reach no persistence call. A currencyless notification may
bind to an adapter's single declared currency; several currencies cannot supply
an invented choice. Network errors may propagate to the host, so failure probes
assert no success without inventing proof of non-dispatch. Returned after-dispatch
timeout and 409 envelopes must also retain dispatched/unknown evidence; exact
`notDispatched`/`before-dispatch` would erase uncertainty and fails the suite. A 409 remains a
conflict response; later redelivery of the original event retains replay identity.
Partial paid amounts and cumulative partial refunds retain their witnessed
classifications. Chargebacks may be `refunded` or `disputed`.

From the repository root, run the existing adapter witnesses with:

```sh
npm --prefix . run test:hosted -- packages/platform/test/payments/<provider>/conformance.test.ts
```

The fixtures in those tests show the client bindings, the card adapter's inclusive
300-second signature window, JWS verification, cumulative refund snapshots and
full-reversal chargebacks. This proves offline contract behavior only; provider
account readiness and real-store durability need their own evidence.

### Payment service composition

`createPaymentServices` accepts `PaymentServicesOptions` and returns
`PaymentServices` or null when truth schema/capability is unavailable. The host
supplies `openTruth`, which opens one port and its asynchronous close operation.
`run` closes that scope after success or failure. Construction performs no I/O.
Use the existing `createBundleComposer` payments binder for named registration;
omitting it leaves the host cold. Schema declarations do not prove installation:
retain the existing readiness/schema checks before admitting work. Existing jobs
and routes keep their owners; this binding adds no schedule or event handler.

The reference direct truth binding injects its existing executor, templates and
recovery path. The separate verified-ingress selector is explicit and default-off;
unknown selections refuse. Its projected carrier includes the adapter fingerprint,
so the reference store records stable identity on the first receipt independently
of audit payload or clock. On replay the store reads the first stored instant;
application and follow-up work reuse it. Missing durable clock evidence refuses
rather than advancing a cycle. This D11 behaviour change does not mount a provider
route or enable an adapter; hosts must explicitly wire the selected ingress.

### Opt-in payment example

Import `createStripePaymentAdapter`, `type StripePaymentAdapterConfig` and
`stripePaymentCapabilities` from the card payment adapter subpath listed in [package.json](../../packages/platform/package.json). Supply a
structural client, `webhookSigningSecrets`, explicit `mode`, required
`supportedCurrencies` (a non-empty list of upper-case three-letter codes) and optionally
`toleranceSeconds` (default 300) and `clock` (UTC seconds). The host constructs
and configures the SDK, associates saved methods with customers and confirms
off-session requests. Interactive methods follow the declared card/wallet offer.
For capture-time qualification, supply `client.ownAccountRef` from the verified
installed credential account and record that same reference in the local qualification.
Importing creates no I/O or default binding. The adapter advertises the host
currency list as a frozen copy; the frozen exported descriptor keeps an empty list.
Account-specific readiness remains pending TEST verification. Exact absence,
refund creation and split authorization/capture are unsupported. Cancellation
is enabled only when the injected client supplies it. See the
[A2 ledger](https://github.com/openlup/openlup/blob/main/docs/platform/plans/oss-a2-payment-adapters.md) for the current
preview boundary and the host's responsibilities.

Method evidence carries the originating lifecycle and replacement facts through M07
projection when provider time is present. Without provider time it retains the
method outcome and omits the lifecycle instead of inventing a transition time.

### Opt-in bank and code payment example

Import `createTpayPaymentAdapter`, `type TpayPaymentAdapterConfig` and
`tpayPaymentCapabilities` from the bank-and-code payment adapter subpath listed in [package.json](../../packages/platform/package.json). Supply `http`
with explicit `baseUrl`, `clientId`, `clientSecret`, `fetchImpl` and optional
`timeoutMs`; `urls` with `notificationUrl`, `successUrl`, `errorUrl`;
`modelOActivationEnabled`, `mode`, and optional UTC-seconds `clock`.
`notification` requires `rootCertificatePem`, `allowedCertificateUrlPrefix`
(HTTPS directory ending in `/`) and `resolveCertificate`. The resolver owns
redirect/egress policy. Both certificates must be valid at verification time.

Verify certificate validity and notification freshness using original raw bytes.
A signed protected-header `iat` supplies UTC-seconds provider time; absent time
stays null. `maxNotificationAgeSeconds` defaults to seven days, a generous
assumption pending confirmation of the provider retry schedule. Signed issue time
more than `maxClockSkewSeconds` (default 300) after receipt refuses as stale;
both freshness limits must be finite and nonnegative. Host dedupe
uses exact event identity plus stable fingerprint when time is absent. The age
and future-skew limits apply only when the signed header carries a provider issue time. Receipt
time is used only for freshness. Transaction identity includes outcome class;
method identity includes event/alias plus outcome.

Bank redirects, one-time codes and unattended Model O alias charges are supported
when the host supplies the M07 P3 contract payer and method selection inputs.
Supply transient `payer: { email, name? }` on every
attempt, including renewals. An omitted or blank name uses the originating
neutral display label `Customer`. Select `methodSelection: { family: "bank-redirect",
channelRef }` for the bank channel, or `{ family: "one-time-code" }` with
`customerAuthorization` as a `TransientSecret`. A `renewal-unattended` attempt
uses `storedMethod.reference` and its Model O mandate. Missing payer/channel/code
and Model M or unknown mandates refuse before any dispatch with neutral
data-correction evidence. Payer and authorization never cross the return boundary
in diagnostics or request/response payloads. Readback uses the returned API
transaction ID; notification titles remain distinct. The originating typed no-charge
errors return an exact `notDispatched` envelope: proven request-document refusals
require customer data correction; OAuth, encoding and exhausted pre-send deadlines
remain transient retryable refusals. Host mode/purpose/currency mismatches throw before I/O.
A renewal the provider refuses for data validation is classified as needing customer data correction: the host should prompt the customer to update payment details, and the bundled retry schedule keeps its normal retries unless the host treats that class as terminating. The subscription stays active; nothing is paused or suspended by this classification. The contributed adopter applies this classification only when reopening a checkout; the example applies it to every purpose.
Every other execution error propagates unchanged as ambiguous.

The exported capability descriptor and its nested records and arrays are frozen.
Currencyless money notifications preserve the paid amount and bind to the adapter's single declared currency; multiple declared currencies refuse as malformed.
Alias method evidence preserves the originating lifecycle through M07 projection with
signed provider time; absent provider time leaves the lifecycle field omitted.
The adapter offers its declared market currency; alias registration and recurring
cards are not offered by this factory. Account offers
remain `verification_pending` until owner TEST readback. Chargeback observations carry full reversal,
original money and stable operation identity; refunded/chargeback readback stays
unknown for manual review, including historical attempt/error refusals in either
readback purpose. Pending and refused readback report validated configured money,
including when the paid amount is zero or absent; a refused result with mismatched
nonzero paid money stays unknown for manual review. Succeeded readback requires the originating
observed paid amount to equal expected money; underpayment and overpayment remain
unknown for manual review. There is no close or exact-absence port. Refund
creation and authorization/capture separation are unsupported. See the
[A2 ledger](https://github.com/openlup/openlup/blob/main/docs/platform/plans/oss-a2-payment-adapters.md#o-p2-boundary-and-named-deltas).

Verified audit payloads retain only reference-filtered transaction and alias facts,
including `eventKind`, alias `event` and `aliasType` when supplied. Missing failure
provenance and failure prose stay absent. Payer, authorization, certificates and
raw bodies never enter the evidence; audit facts do not affect event identity or
fingerprints. The offline M07 P2 conformance witness uses two distinct intents,
attempts, amounts and provider references, with replay and refusal boundaries.

### Reference-support surface

See [existing payment bindings](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/how-to/extend/provider-adapters.md#reuse-existing-payment-bindings).

The vendor subpaths additionally expose these experimental helpers for the
reference application's existing host bindings. Each declaration names its exact
reference consumer and carries `@experimental`: Reference-application support
surface; may change.

| Entry | Additional exports |
| --- | --- |
| Card payment adapter subpath (`packages/platform/package.json`) | `createStripeSandboxPaymentExecutionAdapter`, `createStripePaymentReconciliationProvider`, `mapStripeIntent`, `mapSetupIntent`, `normalizeStripeFailureEvidence` |
| Bank-and-code payment adapter subpath (`packages/platform/package.json`) | `createTpayPaymentExecutionAdapter`, `createTpayPaymentReconciliationProvider`, `createTpayHttpClient`, `normalizeTpayFailureEvidence`, `aliasValue`, `ProviderAttemptPreDispatchError` |

Types are inferred from those functions; no extra type export or neutral payment
entry is added. These are the existing contributed implementations, including
rich execution, recovery and filtered audit carriers. The host still owns SDK
construction, environment/feature flags, callback/return presentation, account
readiness and simulator composition. Its prepared-attempt facade re-exports the
same error class so `instanceof` preserves the no-charge trust boundary.
The M07 factories' neutral envelopes and capability limits remain unchanged;
reference-support availability establishes no provider activation or stable API.

## Native parcel contact privacy

See [protecting parcel contacts](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/how-to/build/fulfillment.md#protect-parcel-contacts).

Native preparation retains recipient and delivery-selection fields in the private
parcel contact store, separate from dispatch evidence and customer reads. The explicitly
authorized native shipment projection exposes its contact comparison.
Install the complete native catalogue before composing the preparation binding.
When composing privacy operations, register
`createFulfillmentParcelContactPrivacyContributor` from `./identity`
and require contributor ID `fulfillment-parcel-contacts` in the existing registry.
Keep the identity contributor and subscription veto. Erasure removes the contact
payload and leaves a marker that prevents legacy inference from recreating it;
finite native-store transfer carries both live contacts and erasure markers.
See the [privacy owner](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/concepts/personal-data.md#personal-data-coverage).

## Native delivery-contact correction

After installing the complete catalogue through
`20261121100000_order_delivery_contact_correction.sql`, the native commerce OMS
port composes operator shipping-address correction. Authorization remains in the
existing OMS handler. `createPostgresDeliveryContactReadPort` from
`./fulfillment/native` supplies a nonmutating order-scoped resolution, including
before parcel creation. Submit its exact revision and PostgreSQL digest together.
Exact replay returns the retained response; stale expectations, started submission,
missing historical contact and erasure refuse. A correction updates only private
contact authority, the operational revision and `shipping_address_updated` audit.
Operator creation validates that resolved contact, so a valid pre-parcel correction
can repair an incomplete original destination before the new parcel captures it.

`nativeFulfillmentCommerceResponseSchemas` adds the existing `deliveryContact`
projection to the latest native shipment. It compares recorded baseline with
effective contact and carries provenance, revision, digest and eligibility.
Older explicit shipments and custom destination readers have a null projection.
The native response schemas also accept older payloads without `deliveryContact`,
normalizing its absence to null. Orders without shipments still
return null detail. Managed schemas and other native reader limits are unchanged.
The privacy contributor exports/erases private order contacts and correction
responses; finite native transfer carries their rows and payload-free erasure fences.
See the [composition recipe](../../packages/core/docs/guide/how-to/build/fulfillment.md#correct-a-delivery-contact).

## Fulfillment stock evidence replay

See [stock-alert replay and conflicts](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/how-to/build/fulfillment.md#replay-stock-evidence).

The fulfillment migration projection additionally includes the native
`20261022165000_fulfillment_stock_evidence_replay_reopen.sql` forward at canonical
position 76 in this catalogue. Install the complete chain before stock adoption.
Matching-fingerprint alert replay refreshes severity/quantities, reopens status and
clears `resolved_at`, preserving identity, first-seen time and historical resolver
metadata. Mismatches, including legacy 0.22.0 whole-input fingerprints, still
raise `23505`; no rewrite is supplied. See the [migration owner](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/upgrade/database-migrations.md#select-the-complete-catalogue)
for upgrade and operational-dependency proof.

The updated fulfillment dispatch store also requires the complete catalogue
through `20261120110000_fulfillment_dispatch_outcomes.sql` (canonical position 137).
Its explicit intake parameter defaults to push through the legacy SQL wrapper;
polling descriptors record poll evidence. Existing receipts, acceptance keys and
replay remain unchanged. `receiptKey` is an optional byte-equal `labelKey` alias;
neutral observation status/event aliases retain legacy fields and event keys.

## Subscription contracts and renewal port

Use `selectCatalogProfileCadence` from `@openlup/platform/subscriptions` to
intersect fixed-day choices from the store, SKU, offer and command. For a
profiled request, pass the declared profile, its reference and the matching
profile and policy identity pins from your binding. The selector also
intersects the profile's choices and applies its optional fixed-day cap. An
invalid declaration returns the Core field issue with `policy_binding_missing`.

Pass a successful day projection to the owning operation. Native write
guards still enforce their limits. Profiled prepaid requests return
`prepaid_unsupported`. Unprofiled requests retain the existing
`multi_cycle_prepaid_unsupported` response.

`createPostgresSizedEditor` adds agreed-plan editing and explicit classic-to-sized
opt-in on the selected sized SQL forward. Compose it with the classic binding
through `createOfferDispatchedSubscriptionEditor`. Unchanged exact SKU/count/
add-on lines retain their complete agreements; only changed lines are quoted.
The host supplies owned need/exclusion facts, verified catalogue/stock facts,
portion proposals and a single-connection transaction callback. Its
`assertCurrentFacts` locks and rereads owned subject/exclusion facts and optional
opt-in need, and rereads every selected SKU's catalogue facts, on that connection before
the five sized composition actions apply. Catalogue evidence includes variant,
SKU/group identity, add-on/sellable flags, document revision/digest, verification,
physical size, demand per unit, exclusion keys and `sellableNow`. Facts are ordered
by canonical variant UUID with sorted exclusion keys. The ledger records them in
`subjectFacts.catalogFacts`; existing SQL equality compares preview and apply
evidence. The host compares these current reads with apply evidence and holds its
subject locks through commit; catalogue rows and stock are reread, not locked or
reserved, and concurrent catalogue publication is the publication-fence limit.
Individual add-on edits keep the existing exact writer boundary. Preview never binds; accepted opt-in binds atomically, including when
contents are unchanged. Direct/reverse binding writes refuse. Current SKU
admission is transactional; publication-head fencing and sized acquisition are
not supplied. The [subscription owner](ARCHITECTURE_AND_EXTENSIONS.md#subscription-contracts)
defines configuration, introductory reachability and host obligations.

The subscriptions entry also exports `createNativeSubscriptionBinding`,
`createNativeRetryDriver`, `withNativeDeliveryAlignmentRenewalAdmission`,
`createPostgresRenewalSettlementPort` and `nativeSubscriptionSchema`. These are
opt-in native composition and persistence boundaries; hosts supply readiness,
transactions, a shared population lease and exact payment-attempt readback.
The binding freezes the destination under the claim lock. Lower-level hosts
supply the transaction callback to `createPostgresRenewalStore` and
`createPostgresRenewalSettlementPort`. Retained `native.renewal-terms.v1` facts
freeze delivery pricing and optional second-delivery/graduation terms from the
accepted server offer. Threshold shipping uses product payable after discounts:
paid below, free at or above the configured threshold. Fixed paid shipping also
requires the retained-terms document. New threshold or paid-shipping snapshots carry the actual
`retained_shipping` marker; other zero-shipping snapshots keep their original
wire and fingerprint. Graduation runs under the subscription lock before the
first unlocked third delivery, preserving add-ons and customer-edited normal
cadences without moving the due anchor. Preparation projects discounted product
positions and a separate shipping charge in one transaction; replay adds neither.
A retained snapshot refuses preparation without the supplied transaction runner.
See the [composition owner](ARCHITECTURE_AND_EXTENSIONS.md#composed-subscription-module)
for destination claim transactions and qualification limits.

The native purchase-renewal forward adds bounded attachment and method-state
writers through `createPostgresPurchaseRenewalWriter`, plus the independently
committed `activateNativePurchaseWithRenewal` convenience call. A completion
failure leaves an enumerable durable duty while paid service remains active.
After successful completion, including replays, an optional best-effort unit
materializes the admitted logical draft lines and optional price context in one
statement. It writes only when the template is empty and still version one,
preserving later edits and graduation. A crash after completion leaves the prior
no-template state; replay can recover it. Per SKU, quantities sum, sort uses the
earliest ordinal and the unit price must agree across its original draft lines.
Different prices skip the whole template and pair with a neutral reason.
Add-on roles follow retained `renewalTerms.linePricing`, rather than catalogue
roles. Resolution checks the original draft lines and saved mode, including when
promotion allocation splits effective positions. Missing or ambiguous lists leave
NULL context while permitted template lines remain visible.
Only SQLSTATE classes 42, 22 and 23 skip the optional unit, logging
`subscription_template_unavailable` plus the SQLSTATE once. Other failures
propagate. The unit first attempts a savepoint. Only `25P01` identifies independently
committed pool queries, which continue without one; any other savepoint error
propagates. A caller transaction retains the established savepoint. Detection
calls no database function and opens no explicit transaction. Missing runtime
access keeps the prior no-template behavior and refused native edits, with no new
grant. Graduation retries absent context under the same best-effort rule in a
savepoint, preserving its existing add-on lookup and due anchor.
`createNativeRenewalCodec` supplies a versioned, database-decodable frozen wire;
`createPostgresSandboxRenewalRail` and `createSandboxRenewalPolicy` provide no-key
renewal success, decline and ambiguity using the existing native operation fence.
Hosts supply trusted purchase facts and current method identity and retry pending
attachment duties. The published package includes these exports and the matching
native migrations. This composition requires the selected database forward and
supplies no real PSP, mandate, automatic repair or default runner. See the
[subscription owner](https://github.com/openlup/openlup/blob/main/docs/platform/ARCHITECTURE_AND_EXTENSIONS.md#subscription-contracts)
for the fingerprint dialect, transaction boundaries and recovery limits.

The `./subscriptions` entry exposes hosted renewal mechanisms and
an explicit native capability descriptor and the sized parcel lever value;
`./subscriptions/contracts` is browser-safe and type-only. The [subscription architecture and recipe](https://github.com/openlup/openlup/blob/main/docs/platform/ARCHITECTURE_AND_EXTENSIONS.md#subscription-contracts)
owns the concrete ports, continuity rules, capability refusals and witnesses.
These entries do not install a store or activate a runner.

Native renewal and N1 retry stores accept injected SQL executors and explicit
snapshot/identity policy. The generic native executor consumes the subscription
ports; host composition supplies G23, M07, transaction and correlation policy.
The initial binding preserves case-before-outcome ordering with atomic bookkeeping.
N1's same-obligation recovery repairs the native decline stall (F16); it does not
supply M07 prepared-store parity or activate a runner.

With N1 then N2 installed, `createPostgresSubscriptionCommandStore` and
`createPostgresSubscriptionCommands` support native generic bundle commands and
command-bound receipts. Preview persists a quote; apply atomically updates future
terms, event and receipt with no proration or current-cycle repricing. Hosts own
authorization, address validation, SKU/composition translation and the transaction
connection. The lifecycle-closure forward enables explicit pause with atomic
recovery closure and unpaid-artifact finality. Confirmed order-now/reactivation,
structured pause/cancel retention evidence and separate trusted lifecycle timing
terms use the existing command port; see the
[subscription owner](ARCHITECTURE_AND_EXTENSIONS.md#subscription-contracts).
Prepaid remains unsupported.

Native N3 plus the ATP seam/allocator and X/Y suffix provide
`createPostgresStockWaitStore` and `createPostgresStockAvailability` (the latter
at `./inventory`). Hosts supply transactions, clock, source and the existing
wire codec. Candidate discovery preserves uncaptured frozen operations; shortage
creates a durable wait, and elapsed stock-only refusals may reacquire on the same
identity with a new claim generation. Resumed means paid realization admitted.
Native soft priority uses the horizon installed via `inventory_renewal_protection`
(default 14 days) and is distinct from durable advance reservations. The managed
contract retains its fixed 14-day horizon.
The unbound descriptor keeps stock recovery unavailable. The opt-in native M10
reference composition selects it after composed PostgreSQL proof; managed
TypeScript recovery remains unavailable.

`createSubscriptionServices`, lifecycle-message and neutral command facades are
in `./subscriptions`; `createSubscriptionContribution` is in `./composition`.
They are default-off and describe one host executor/job. The
[composed module recipe](https://github.com/openlup/openlup/blob/main/docs/platform/ARCHITECTURE_AND_EXTENSIONS.md#composed-subscription-module)
owns explicit selection, frozen mandate/replay, M04 delivery and M12 boundaries.

`createPostgresLifecycleMessages` consumes the native notice queue through an
explicit trusted host. Its optional `dispatch` policy defaults to a 60-second
lease, 6 attempts and a 900-second transient backoff. `recovered.windowSeconds`
defaults to 172800. These are neutral safety defaults. Starter hosts must supply
all four values explicitly from their typed configuration. Values are strictly
validated positive PostgreSQL integers.
Operator repair notices inherit their latest customer failure template and retain
their own identity. Returned transient failures requeue using the SQL clock,
explicit final failures settle failed, and exceptions retain the sending lease.
Accepted receipts reconcile before binding. Current recovered-case truth and an
inclusive recency cutoff gate unaccepted recovered history. The run result
reports `requeued` separately. Hosts retain rendering, token authority and
idempotent private-capture readback. The [lifecycle owner](https://github.com/openlup/openlup/blob/main/docs/platform/ARCHITECTURE_AND_EXTENSIONS.md#subscription-contracts)
defines these policies and the attempt-ceiling repair boundary.

`createPostgresSubscriptionWinback` is a separate, explicitly selected native
worker in `./subscriptions`. The host supplies an exclusive autocommit session,
the existing durable delivery rail and localized content/account-link binding.
Delivery uses one subscription-wide key across cancellation episodes, checks
eligibility after binding and records acceptance after send. The
[subscription owner](https://github.com/openlup/openlup/blob/main/docs/platform/ARCHITECTURE_AND_EXTENSIONS.md#subscription-contracts)
defines `subscriber_winback_policy`, its compatibility defaults and the
starter's retention-consent capture/refusal obligation. This worker mounts no
account page and selects no other retention planner.

### Read stock waits

Use the experimental `createPostgresStockWaitReads` from
`@openlup/platform/subscriptions` with the installed native or managed graph.
Supply a server-side `withReadSnapshot` that opens one read-only repeatable-read
transaction and keeps all queries on its connection. Bind operator and evidence
checks to the current request. For customer reads, resolve the authenticated
principal, client and permitted subscription IDs server-side. The reader verifies
that ownership in the same snapshot as the cases.

Use `listAdmin` for filtered pages with complete shortage totals and payment
evidence, and `readOperatorSummary` for totals alone. Use `listEvidence` for up to
2,000 open cases ordered by check time and `listCustomer` for up to 100 owned
open cases ordered by opening time. The reader applies eligibility after the
limit and keeps stock-secured cases visible. Pass evidence and the observation
time to `stockWaitHealth` to identify stalls and check notice freshness.

For managed reads, the PostgreSQL executor needs read access to the columns
used by each method.

| Used by | Relation | Columns |
| --- | --- | --- |
| All reads | `subscription_stock_wait_cases` | `id`, `state`, `deficits` |
| Admin, evidence and customer listings | `subscription_stock_wait_cases` | `client_id`, `subscription_id`, `cycle_number`, `scheduled_at`, `order_id`, `cycle_id`, `fulfillment_id`, `opened_at`, `last_checked_at`, `stock_secured_at`, `resumed_at`, `closed_at`, `block_reason` |
| Admin, evidence and customer listings | `subscriptions` | `id`, `client_id`, `status`, `next_cycle_at` |
| Admin, evidence and customer listings that project notices | `communication_email_deliveries` | `id`, `aggregate_id`, `aggregate_type`, `template_slug`, `status`, `last_error_code`, `updated_at` |
| Customer ownership checks | `clients` | `id`, `auth_user_id` |
| Customer ownership checks | `subscriptions` | `id`, `client_id` |
| Admin payment reads | `commerce_orders` | `id`, `client_id`, `subscription_id`, `subscription_cycle_id` |
| Admin payment reads | `subscription_cycles` | `id`, `subscription_id`, `scheduled_at`, `order_id`, `cycle_number`, `payment_id` |
| Admin payment reads | `commerce_payments` | `id`, `order_id` |
| Admin payment reads | `commerce_payment_intents` | `order_id`, `subscription_id`, `subscription_cycle_id`, `payment_id`, `target_kind`, `status` |

Native case projections report
`stock_wait_read_generation_missing: <case-id>` if the linked renewal operation
is absent or disagrees with the case. Check the operation binding for that case.

## Operations and diagnostics

The `./operations` entry contains browser-safe operational schemas,
alert projections and `createOperationsClients`, which binds an existing BFF
requester. `./operations/contracts` contains DTOs and narrow ports only.
`./operations/server` contains settings read/update, pipeline read, alert overview,
control-plane handlers and the existing watchdog delivery mechanism. Authorization,
SQL execution, evidence evaluation and alert transport are supplied by the host;
importing these entries registers no route, schedule or provider.

The [package-local control-plane witness](../../packages/platform/test/operations/controlPlaneHandler.test.ts)
preserves the injected handler's request, authorization, replay and error boundaries,
including authorization before malformed-body parsing.

`runControlPlaneWatchdogTick` evaluates persisted neutral job failures and records
an idempotent heartbeat unless `checkOnly` is true. The richer watchdog accepts a
typed evaluator; the public reference binds its maintained domain evaluator.
Settings preserve scalar values, and pipeline reads preserve the existing tester
and email projection. Identity membership and tracking effects keep their owners.
See the [operations architecture](https://github.com/openlup/openlup/blob/main/docs/platform/ARCHITECTURE_AND_EXTENSIONS.md#operations-and-diagnostics)
for refusal behavior, SQL prerequisites and the bounded preview scope.

## Risk controls

The `@openlup/platform/risk` entry exports the existing strict
schemas with CSP-safe Zod initialization. `risk/contracts` is type-only;
`risk/server` exports paid-order assessment, subject hashing, structural managed
clients and the native executor factory. Core risk remains at `@openlup/core/risk`.
No provider SDK or pg runtime import is required by risk. Hosts supply trusted
operator authorization and actor mapping, clients, mode and hash secret.
The [risk contract](ARCHITECTURE_AND_EXTENSIONS.md#risk-contracts)
explains the preserved rail differences and sparse SQL descriptor. These entries
register no route, worker or schedule and do not activate risk.

R2 adds `createRiskBindings` and the unchanged admin handler factories in
`risk/server`; supply the host BFF responder, trusted authorization, admin port,
mutation policy and already constructed assessment port. Pass `outboxRisk` into
the existing commerce registry's risk slot once. `createRiskContribution` in
`composition` describes selected routes and the assessment callable, with no
handlers or schedules. The [reference recipe](../../server/runtime/public-reference/m15RiskBinding.ts)
selects nothing by default and requires schema readiness before effects. Hosts
still mount any selected callables and own their authorization/actor mapping.

`risk/server` also exports `createRiskPrivacyContributor` and
`createRiskPrivacyBinding`. Supply the read-only resource owner and explicit
retention policy, then append the contributor to M03's existing registry with
`risk` required. Unbound policy remains unresolved. No risk deletion or retention
period is supplied, and managed identity erasure remains unavailable. Portability
is deferred unless a host supplies its own opaque binding; the helper neither
invokes it nor claims transfer/restore support.

## Company identity

`./company-identity` preserves the existing compatibility schemas
(including optional registry fields); `./company-identity/contracts` contains only
browser-safe types over the unchanged core contract. `./company-identity/server`
exposes ordered provider lookup and the HTTP handler. Pass the host BFF responder
to retain its request-reference binding. The handler shares its process cache
across factory instances: ten-minute TTL, UTC-day/normalized-identity keys, no
purpose/provider partition, manual-input bypass and oldest-insertion eviction.
Lookup does not write customer data. Identifier normalization/validity and legal-name policy are optional inputs in
`CompanyIdentityRules`. Neutral defaults keep identifiers unchanged, accept
non-empty values and do not prefer or seek fuller names. The reference
application retains its existing national rules and callers unchanged.

## Tax calculation

Choose a tax adapter in application composition and supply one merchant coverage
document. This version calculates exclusive tax. Use `./tax/contracts` for the browser-safe port and document decoders.
Use `./tax` to prepare and verify requests and reconcile coverage.
The experimental provider tax adapter factory (listed in [package.json](../../packages/platform/package.json)) takes an account-bound client, a pinned
market pack and host callbacks for verified capture, refund reservations and
positive reference lookup. It supports exclusive quotes and qualified fee-free
reporting. Persist the digest from `makeStripeTaxRequestDigest` with the verified
capture or refund reservation before dispatch. The helper accepts
`StripeTaxRequestBinding`, with `StripeTaxCaptureBinding` for commits.
After a result with `effect: "unknown"`, call the same operation with
`intent: "recover"` using the original request fields, reservation and digest.
Keep `providerLines` with the final evidence. Commit requires those verified
merchandise line IDs, including lines without assessments. Index positive observations by
the exact provider reference, which includes the operation so sales and refunds
can use the same local reference. Use `tax.classMap` to discover tax-code
composition. Keep the logical quote key when recalculating frozen input at a
later tax instant and compare the verified results with
`compareTaxRecalculationProbe`.

Call `verifyTaxQuoteRequest` for quotes and fiscal-validity requests and
`verifyTaxQuoteResult` before using successful results. The verifiers check the
integrity of a plain JSON copy first. Capture requests and results as plain
data, pass those copies to the verifier and use them once verified. Each
refusal has one fixed remedy per code and issue kind. Replay matching originals
with their key and digests. Obtain fresh charge-time input under the original
scope for validity. The port maps a verifier refusal to effect-free
`tax_fiscal_validity_unavailable`.

Use the `./tax/contracts` schemas for the field named by the JSON Pointer. An
empty pointer names the whole document. The request shape is
`{ key, input, inputDigest }` and the fiscal-validity request shape is
`{ original, evidence, evidenceDigest, chargeAt, current }`. A successful result
carries `{ kind, money, evidence, evidenceDigest }` with a money-v2 breakdown.
Reduce the combined merchandise and delivery basis if the aggregate overflows.

The quote request and the calculation evidence each have a 1 MiB snapshot limit.
The complete fiscal-validity request has a 1 MiB limit, including its original
request, evidence and current input. For `tax_invalid_input`, the remedy tells
you whether to supply the documented value or reduce the canonical JSON size
of the document named by the pointer. Result money is bounded by the decoder's
count caps. The result envelope without evidence uses a plain JSON snapshot
with no separate byte cap.

For the evidence digest,
SHA-256 hash `canonicalCatalogDraftJson(["platform.tax.evidence.v1", evidence])`
in UTF-8, using the canonicalizer from `./catalog/contracts`.
Calculation expiry and charge-date fiscal validity are separate checks.
The caller records `closeCalculation` as a local, idempotent transition for
affirmatively unused or verified-unpaid evidence. Never void, delete or mutate a
provider calculation. Indeterminate payments stay open for reconciliation.

Bind `localRateTable` to calculate from rules and registration evidence owned by
your pack or application. Configure the scope, market, currency, clock,
calculation lifetime and fiscal-validity window with `LocalRateTableOptionsV1`.
Each effective jurisdiction, tax class and tax kind needs a rate, explicit
exemption or fixed fee with a pinned refund rule. Give every rule a legal-basis
reference. Keep the versioned table associated with the digest carried in
calculation evidence. The adapter supports read-only fiscal validity and local
close receipts, with posting and reversals unsupported.

Use `runTaxAdapterConformance` with isolated synthetic fixtures to check your
adapter's coverage, money, validity and effect behavior offline. The caller owns
durable quote replay, close recording and posting obligations. Discover the
composition points under `tax.adapter` and `tax.localRateTable` in the settings
catalogue.

### Install and inspect tax coverage

Discover `tax.coverage` in the settings catalogue. Apply the selected native
PostgreSQL migration plan first. In your server-side installer, use the
migration-owner executor in READ COMMITTED and pass the selected installation
and account plus the authenticated operator's opaque reference.

```ts
import { applyTaxCoverageRevision, type TaxCoverageExecutor } from "@openlup/platform/tax";
import type { TaxCoverageV1 } from "@openlup/platform/tax/contracts";

declare const ownerExecutor: TaxCoverageExecutor;
declare const installationRef: string, accountRef: string, actorRef: string;
declare const declarations: TaxCoverageV1["declarations"];

const result = await applyTaxCoverageRevision(ownerExecutor, {
  expectedHead: null,
  document: {
    installationRef, accountRef, actorRef,
    coverage: { schemaVersion: 1, accountRef, revision: "coverage-1", declarations },
  },
});
```

Use `null` for the first append and the last observed revision for a successor.
A successful result carries `revision`, `previousRevision`, `sequenceNo`,
`coverageDigest` and `recordedAt`. Use its `revision` as the next `expectedHead`.
If the response is lost, replay the original document with its original expected
head. On a conflict, read the current head and submit a new revision. To roll
back, keep the current head as the expectation and choose a fresh revision.
Copy the prior declarations to restore their effect, or use an empty declaration
list to restore undeclared coverage. An empty revision still has a head and
declares no jurisdiction covered.

In your application's connected settings binding, return
`readers: { "tax.coverage": bindTaxCoverageReader(db, { installationRef, accountRef }) }`
from `createSettingsBindings`. Supply the scope from trusted app configuration.
Use the runtime database URL and the selected app configuration.

```sh
./node_modules/.bin/openlup settings show tax.coverage --app ./settings.mjs \
  --configuration sample --database-url "$database_url" --json
```

A successful bound read without revisions reports absence. After following the
remedy for a failed read, rerun the same invocation with the same app and
configuration. Offline `settings check` reports invalid coverage declarations
at the same pointers as the installer.

Use a qualified native PostgreSQL installation for connected inspection. Managed
installations do not supply tax coverage history. The setting is read-only in the
settings tool. Checkout consumption is qualified separately.

## Market packs

`./market-packs` exposes pure settlement/fiscal record readers,
profile comparison, exponent lookup and money formatting. COMMERCE configuration keys and refusal semantics are preserved. Readers require
explicit fallback facts; the package defines no market defaults. Supply currency, region, fiscal facts
and display locale independently; formatting historical amounts uses their own
currency. Ambient environment reading/initialization remains application-owned.
These entries add no provider, locale resources, native directory schema or
application caller swap. Shipping suggestions retain the existing optional lane.

`./market-packs` also exports `MarketDescriptor` and `describeMarket(language, profile)`.
They describe independent display, settlement, price-list and fiscal inputs;
no market values, national rules or language defaults are selected. The
[unmounted reference recipe](https://github.com/openlup/openlup/blob/main/server/adapters/market-packs/marketRecipe.ts)
imports application-owned compatibility facts and accepts explicit configuration.
Its [equivalence and variation tests](https://github.com/openlup/openlup/blob/main/server/adapters/market-packs/marketRecipe.test.ts)
separate source composition from an installed or mounted deployment.

## Channels

The `@openlup/platform/channels` subpath provides browser-safe
normalized order, retained purchase, page/cursor and money-allocation contracts
and helpers. `channels/contracts` exports types only. `channels/server` exposes
ingest admission/saga, webhook/operator/pull/recovery helpers and explicit store,
reservation and payment-owner bindings. Importing a subpath mounts no route,
schedule, simulator or provider. The host owns credentials, signature validation,
provider payload decoding, accepted currencies and enablement; jobs and simulator
remain default-off. Optional connector port types describe host capabilities,
not implemented outbound publication or synchronization.

The repository's inert [M17 reference recipe](../../server/runtime/public-reference/m17ChannelBinding.ts)
composes these public exports with explicit host clients and the existing M05
catalog and payment owners. Its separate historical bundle port reads imported
locked facts, independent of current active catalog selection. It exposes managed
webhook/page/recovery callables without mounting routes or jobs; portable selection
exposes source-only operations. This recipe is application source, outside the tarball.

Both webhook composition and retained-purchase composition refuse missing channel
reads before missing ingest rails, before any saga effect. Retained composition
then requires the original retained rows before reading the saga dependencies.

The managed rail can consume original retained paid obligations through the
existing order, payment and inventory owners. Retained rows preserve the first
approval/qualification, locked BOM, component weights, exact integer money groups
and original payment identity across retries and changed current commercial
facts. Reservations precede money effects. The ATP exposure hook reports the
same retained outstanding obligations as channel admission; conversion credits
its own validated exposure before the unchanged allocator clamps stock. Channel
admission takes no subscription locks: uncommitted renewal-demand changes remain
subject to existing stock-wait recovery. Ordinary reservation behavior is
unchanged.

The portable rail offers immutable source capture, protected readback and scoped
page compare-and-swap through `createPostgresChannelPurchasedSourceStore`.
Physical conversion refuses with `channel_purchase_physical_unavailable`; full
portable settlement is unavailable. Native functions keep the selected trusted
migration owner. Managed capture uses a closed NOLOGIN owner; runtime, browser
and MCP callers receive only their declared entrypoints. Generic outbox source
evidence omits normalized buyer/address bodies; authorized capture reads recover
the original protected data. Privacy lifecycle export/erasure is unavailable.

Fresh captures bind the normalized slug to their scoped channel and the raw-source
digest to the original page event. Raw admission checks the existing normalized
buyer, address and shipping scalar contract before persistence. Page watermarks
use the public millisecond comparison and retain the original string on ties.
Retained conversion readback verifies permanent holds by item, SKU, key and total
quantity, including split local lots; recovery retains the sealed original order
and holds when the channel's current delivery provider changes.

`CHANNEL_INGEST_MIGRATIONS` projects the two canonical native units with exact
SHA-256 identities and package SQL assets. It is a sparse projection, not an
installation chain: install the complete selected catalogue and verify its
ledger, object inventory and grants. The three generations append the same two
units after their immutable issued tails. Registry/listing authoring, fresh
qualification/approval/exposure, outbound provider operations and catalog
publication remain outside this import. No real provider readiness, hosted
qualification, release or publication follows from local proof.

Source: [channel contracts](../../packages/platform/src/channels/index.ts),
[server bindings](../../packages/platform/src/channels/server/index.ts) and
[preservation witnesses](../../packages/platform/test/channels/). Repository users can also consult
[the channel task record](plans/oss-m17-r1-channel-import.md).

## Upgrade guidance

Read the selected release's [migration notes and limitations](../../packages/platform/CHANGELOG.md)
before upgrading the exact package set. Current composition belongs to these
reader owners; imports and installation do not activate optional services.

| Boundary | Current owner |
| --- | --- |
| Invoice services, duties and seller revisions | [Invoicing](../../packages/core/docs/guide/how-to/build/invoicing.md) |
| Native fulfillment, provider intake and observation timestamps | [Fulfillment](../../packages/core/docs/guide/how-to/build/fulfillment.md) |
| Native payments and provider profiles | [Payments](../../packages/core/docs/guide/concepts/payments.md) |
| Subscription renewal, admission and timed pauses | [Subscriptions](../../packages/core/docs/guide/concepts/subscriptions.md) |
| Marketing and account/support composition | [Marketing](../../packages/core/docs/guide/how-to/build/marketing.md), [account/support](../../packages/core/docs/guide/how-to/build/account-and-support.md) |
| Commerce quote and checkout composition | [Quote prices](../../packages/core/docs/guide/how-to/build/quote-prices.md) |
| Complete SQL catalogue, session admission and ledger fingerprints | [Database migrations](../../packages/core/docs/guide/upgrade/database-migrations.md) |
| Customer recovery, inspection, recreation, guidance, token pay and inline retry | [Checkout recovery](../../packages/core/docs/guide/how-to/build/checkout-recovery.md) |

The former release-notes block is retained in the
[dated README archive](https://github.com/openlup/openlup/blob/main/docs/platform/history/platform-readme-release-notes-0.43.0.md).
Earlier release checkpoints remain in the
[changelog history](https://github.com/openlup/openlup/blob/main/packages/platform/CHANGELOG-HISTORY.md).

## Saved customer address book

`@openlup/platform/shipping` exports
`createPostgresCustomerSavedAddressPort`, `CustomerSavedAddressRefused`,
`createCustomerSavedAddressRequestSchemas`, their structural executor/scope/options
and validation-policy types, and `CUSTOMER_SAVED_ADDRESS_MIGRATIONS`. No public
signature requires `pg`. Browser DTOs remain in `./shipping/contracts`; the SQL
factory is a server entry point. The migration descriptor is sparse: install the
complete selected native catalogue through `20261110190000_customer_saved_addresses.sql`.

Construct the port with a trusted `principalId`/`clientId` pair, a query executor,
an explicit raw billing-profile reader, a clock and
localized in-use message. The database checks `clients.principal_id` on every
customer operation. Do not derive the scope from request bodies. Billing-profile
storage is separate; an empty reader is an explicit host choice, not a fallback.
The returned object implements the existing address-book and mutation ports:

```ts nocheck
// Fragment: the application supplies localPolicy, database, trustedScope, readOrdererProfiles and copy.
import { createPostgresCustomerSavedAddressPort,
  createCustomerSavedAddressRequestSchemas } from '@openlup/platform/shipping';
const requests = createCustomerSavedAddressRequestSchemas(localPolicy);
const addresses = createPostgresCustomerSavedAddressPort(database, trustedScope, {
  validation: localPolicy,
  readOrdererProfiles, now: () => new Date().toISOString(), inUseMessage: copy.addressInUse,
});
```

The local policy supplies an ISO country/default and aliases, calling prefix,
tax normalization/validation and messages. The request mechanism retains fixed
limits on field lengths and idempotency identifiers, trimming and whitespace
collapse, foreign-format behavior and shipping-only company/tax omission. When
the policy omits the optional effect-free `local` callbacks, it also applies the
default local nine-digit phone normalization and five-digit postal formatting;
supply `local` (`normalizePostalCode`, `isValidPostalCode`, `normalizePhone`) to
replace them for the local country only. Neutral demo values can use `ZZ` and calling prefix `99`.
Bind `requests` and the host response validator into the existing customer address
handler schemas and recognize
`CustomerSavedAddressRefused` with code `address_in_use` as a mutation conflict.
`createShippingBindings` accepts an explicitly selected complete native book and
mutation port; an unbound or incomplete native writer still refuses. Construction
mounts no route.

Save updates an owned ID, reuses the canonical match, or inserts. Defaults clear
only the same customer and exact kind (`shipping`, `billing`, `both` are distinct).
Clear, write and account-event append are separate calls/commits; do not wrap
them in a transaction when retaining this contract. A failed write can leave the
prior default clear committed, and an append failure leaves the address write
committed. A recorded client/event/key replays the current book without repeating
mutation or append; concurrent exactly-once behavior is not promised. A missing
or foreign entity ID on delete is a zero-row acknowledgement with an event,
while foreign updates and mismatched customer scopes refuse.

Delete refuses an address referenced by an active or paused subscription's saved
shipping or billing pointer. Nullable pointer columns are storage for that guard;
select a saved address for future subscription delivery through the destination
port described below. Existing claimed renewal snapshots remain unchanged.

Saved rows, canonical keys, contact/tax/free-text/metadata and linked event
payloads are personal data. Compose
`createCustomerSavedAddressPrivacyContributor` from `./identity` with the existing
identity/subscription owners and require contributor ID `customer-saved-addresses`
in the privacy registry. Its preparation lock precedes identity row locks and
waiting writers recheck ownership after unlinking. It exports exact saved rows and erases them through an
owned subject-client routine even after identity unlinks the principal. Compose
the separate account-event contributor and explicit retention policy: erasing the
address book does not erase retained event payloads or immutable destination
copies. No retention period or blanket erasure claim is supplied.

Finite restore targets qualified installations; legacy installations are capture sources.
The finite connected-store profile carries exact saved rows and event history,
restores addresses after clients and before subscription pointers, and replays
without rewriting them. The smaller compatible-row copier remains a separate
closed profile. Delivery/payment preferences, checkout hints and billing-profile
persistence are described below.


### Saved subscription shipping selection

After installing the complete native catalogue through
`20261110240000_subscription_saved_address_selection.sql`, select an owned
shipping or both-kind address through the existing server entry:

```ts nocheck
// Fragment: the host supplies database and the authenticated command fields.
import { createPostgresDestinationPort } from '@openlup/platform/commerce/server/destinations';
const destinations = createPostgresDestinationPort(database);
await destinations.selectSavedShippingAddress({ actorId, clientId, subscriptionId,
  idempotencyKey, savedAddressId, now: new Date().toISOString() });
```

Hosts authenticate the actor and bind the client from trusted session ownership.
The owned command persists the saved ID and emits the subscription audit,
account event and confirmation intent in the same database transaction. It
checks the owned subscription before looking up the saved ID. An existing
subscription-event key replays the current subscription state before parsing or
checking the address, even if the supplied address changed or was deleted.
This command retains that replay rule; typed destination commands keep their
existing fingerprint-conflict rule. Active and paused subscriptions are allowed;
locked cycles and already claimed next-cycle operations refuse a fresh selection.
Billing pointers, cadence and template versions are unchanged.

`DestinationAddress` and `NewDestinationAddress` retain their required
`recipientName` for newly typed input. The existing `read()` method retains
`Promise<DestinationDocument>`; use the additive `readWithSaved()` for saved
selections and their order/parcel snapshots. It returns `DestinationReadDocument`,
a union with `SavedDestinationDocument`: only the saved representation permits
a null recipient, and its address carries the explicit `savedAddressId`. The
compatibility reader refuses a null saved recipient instead of returning it as
a required string.
Canonical bytes never identify a saved row. Each new subscription destination
read snapshots the current saved row into a fresh immutable destination without
replacing prior destinations or the last typed binding. Retain the existing
subscription-read/renewal-claim transaction. Retained claims and existing orders
or parcels keep their frozen destination; later unclaimed cycles consume edits.
A successful new typed-address command clears the saved pointer atomically;
replayed or refused typed commands do not clear it.

A null saved recipient stays null in the destination and first parcel-contact
snapshots, even when a customer name or saved-address label is present. Typed and
legacy recipient fallback remains unchanged. The existing
contact/preparation owner decides carrier eligibility; a frozen null is never
replaced by a fabricated fallback. In-use deletion uses the real saved pointer.
Saved contact, tax and free-text copied into a destination remain personal data.
Finite connected transfer carries the saved rows, pointers, immutable destination
rows and retained events under their existing classifications. Address-book
erasure does not erase immutable destination copies; this port adds no
export/erasure operation for destination rows. The new SQL routine grants
EXECUTE only to `service_role`; PUBLIC and browser roles remain closed.


### Customer delivery and payment preferences

The same `20261110240000_subscription_saved_address_selection.sql` forward adds
private scoped preferences and a delivery selector used by the renewal writer.
Use `createPostgresCustomerPreferencePort`, `createCustomerPreferenceSchemas`,
`createCustomerPaymentPreferencesHandler` and
`createCustomerDeliveryPreferencesHandler` from `@openlup/platform/shipping`.
Browser input/output types live in `@openlup/platform/shipping/contracts`.
Bind a server-authenticated principal/client pair and a structural query executor;
no connection or provider SDK is created. Handlers support GET/PATCH, use only
the authenticated user ID, validate strict request/response envelopes, and require
host authentication, responder and copy configuration. They mount no routes.

`CustomerPreferencePolicy` supplies exactly three payment values (canonical
families `instant`, `card`, `transfer`) and four provider values (`warehouse`,
`carrier`, `manual`, `simulator`). Each map must contain distinct nonempty values;
extra families refuse construction. These are bijective labels, not extra payment
methods or providers. SQL stores the closed canonical family and, for delivery,
the configured provider reference. The same policy must be used for reads and
writes. Scopes are `one_time`, `subscription` and `any`. Saves upsert one row per
client/scope and update its selection time; they do not touch payment instruments,
mandates, account events or provider state. Carrier and pickup fields retain the
fixed trim/length validation. A locker requires a pickup point, but its address
may be null when saved; incomplete locker addresses are skipped by renewal.

The renewal writer calls the private selector only when constructing fresh order
metadata. An explicit top-level `selectedDelivery` key (including null), or a
nested runtime-finalization selection, is preserved. Otherwise a complete
subscription preference wins over `any`, followed by the earliest qualifying
subscription order's selection. Only an object is copied. No trigger, raw
preference read grant or payment-selection change is added. The renewal owner's
claim, replay, delivery clamp and cycle scheduling stay unchanged: late delivery
extends the next cycle and never stacks deliveries.

`createPostgresCustomerDefaultsPort` binds a client ID established by the trusted
checkout identity owner, including a provisioned client without a linked account.
Do not bind it to an unverified request ID. Its required `readOrdererHints` port
returns billing-profile IDs ordered by default first, then latest update; this
change supplies no billing-profile store. The snapshot chooses scoped payment
then `any`, and default/most recent shipping or billing IDs (including `both`).
It returns redacted hints with `applied: false`; nothing is automatically applied
and no contact, free text, provider secret or delivery instruction is exposed.
The authenticated preference port also exposes this snapshot for its bound client.

Preference rows, client links and pickup history are personal data. Compose
`createCustomerPreferencePrivacyContributor` from `@openlup/platform/identity`
and require `customer-preferences` in the existing privacy registry, alongside
the identity/subscription veto and account-event owners. It exports exact rows
and erases only the subject's rows, using a preparation lock before identity row
locks. Waiting saves recheck ownership after unlinking. There is no automatic
retention period. Both tables are `block` classified for lead absorption;
service_role has only client-ID census SELECT at table level and EXECUTE on the
closed routines, with no raw preference access for browser roles.

Finite native capture carries exact preference rows. Qualified restore inserts
them after their clients and replay leaves them unchanged. Legacy installations
are capture sources. The smaller compatible-row copier is unchanged; a managed
source with nonempty preferences has no typed projection and refuses as an
unsupported relation. Restore does not apply defaults, select payment instruments
or activate a target.

### Customer billing profiles and frozen invoice buyers

Read [billing profile composition](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/how-to/build/account-and-support.md#manage-billing-profiles) and [immutable invoice buyer capture](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/how-to/build/invoicing.md#freeze-the-invoice-buyer).

Install the complete native catalogue through
`20261110270000_invoicing_duty_buyer_capture.sql`. Select
`createPostgresCustomerBillingProfilePort`, `createCustomerBillingProfileSchemas`
and `createCustomerBillingProfilesHandler` from `@openlup/platform/account-support`;
browser request/response/port types live in `account-support/contracts`.
Bind a host-authenticated principal/client pair, a structural query executor,
clock and tax normalization/validation policy. The fixed field limits and
10-digit weighted checksum cannot be widened by that policy. The handler
supports GET/POST/PATCH/DELETE, uses the authenticated identity, validates strict
requests/responses and takes host messages and a structural responder. It mounts
no routes and requires no PostgreSQL driver types in consumer signatures.

Default clear, profile write and account-event append are separate calls and
commits. A failed write can leave previous defaults cleared; a failed append can
leave the profile write committed. Repeated request identifiers are stored in
events and execute again. An owned-ID update refuses a missing/foreign row;
a delete of a missing/foreign ID acknowledges zero rows and records its event.
Verification level/source/evidence supplied by the customer is retained as data;
no registry verification workflow is performed.

Bind `createPostgresBillingInvoiceStore` from `@openlup/platform/invoicing` for
subsequent host fiscal composition: `readCapturedBuyer(orderId)` supplies the
immutable buyer, and the selected installer refuses facts that contradict it.
Full fiscal-fact installation is a separate call and cannot be the buyer freeze
point. The retained-source sweep also reaches the first-duty capture boundary.
A missing recorded destination refuses with `commerce_destination_unavailable`:
record the owned order destination before retrying capture while its fault is
still retryable. Handoff sources must name an order-owned shipment or refuse with
`customer_billing_shipment_mismatch`. Once the sweep marks the source `faulted`,
there is no supported operator reset/requeue command; escalate for an
invoicing-owned recovery procedure. No buyer or address
is fabricated. There is no second full invoice ledger, provider executor or scheduler.

`InvoiceBuyer` adds only optional `line2`, raw identifier and provenance fields,
so historical facts and existing typed consumers remain valid. Provider
projection preserves the second address line, source flags and profile/address
references when present; it adds no fields to historical input that lacks them.
The host still owns identifier normalization, fiscal kind, clearance, money,
lines and seller policy. A full-fact revision is immutable. Profile edits after
buyer capture cannot change an existing request, issued artifact or replay;
a later invoice request sees the new profile. Existing historical duties and installed
facts without a buyer component remain unchanged. This is no fiscal provider
qualification, invoice rewrite or automatic checkout application: checkout hints
remain explicitly unapplied.

Profiles (contact, tax/company identity, verification provenance and source),
events and frozen buyers are personal data. Register
`createCustomerBillingPrivacyContributor` from `@openlup/platform/identity` and
require contributor ID `customer-billing`. It exports exact profile/component
rows, erases only the subject's editable profiles, and reports frozen buyers as
retained under the invoicing owner's document-retention rule. Invoices remain
outside identity erasure; their owner supplies retention/processor handling,
without a default duration. Compose the identity/subscription vetoes and the
separate account-event retention contributor. Client-field clearing or cascade
does not cover these new rows.

Both new tables have closed owner access through routines; only service_role
receives routine EXECUTE. Profile rows are `block` classified for lead absorption,
with only client-ID census SELECT/policy. Browser roles have no table or routine
access. Finite native capture/qualified restore carries exact profiles and buyer
components, restores the latter after invoice duties, and replays without
rewriting them. Legacy installations are capture sources. The smaller compatible
row utility is unchanged; managed-source nonempty profiles without a typed path
refuse explicitly. No credentials or target activation are transferred. See the
[data owner](https://github.com/openlup/openlup/blob/main/docs/platform/DATA_AND_MIGRATIONS.md#customer-billing-profile-and-invoice-buyer-data).

### Offline fulfillment adapter certification

The kit certifies adapter behaviour against honestly built data fixtures. It
rejects missing, malformed or contradictory fixtures and contract-violating
adapter results. A caller deliberately using accessors, proxies or overridden
intrinsics to defeat their own certification is outside the threat model.
Snapshots, closed schemas and captured intrinsics reduce accidental misuse;
they are not an attestation.

`@openlup/platform/fulfillment/testing` exports the conformance runner, captured
adapter and scripted transport. One-argument calls retain baseline mode. Full mode
snapshots data before execution, validates closed schemas and credits only the
runner's invocation ledger: every supported certifiable capability needs an
executed contract-positive success and typed failure. Each copied result must
have the same kind as its independent fixture expectation and be deeply strictly
equal. Missing expectations, malformed branches, reused scenario indices and
empty positive witnesses fail qualification. Descriptor-based snapshots mitigate
accidental proxy, accessor and hidden-field misuse. Adapter
calls receive fresh input copies; sync success and throwing failure roles are
mutually exclusive. Unsupported cannot satisfy a supported operation's failure.

Executed refusal probes cover non-PDF formats, label create/void, provider-side
cancel, independent split, provider-owned reservations, snapshot-only stock
movements and pickup-point/locker execution, with unchanged provider-call counts.
Callable unsupported adapter operations also require refusal witnesses. Label
probes invoke adapter methods; named native limits invoke platform code. With
`snapshotOnly: true`, the runner executes the real stock-sync worker using its
own isolated snapshot-only provider/store. It accepts no caller worker callback.

The closed port-less list is `courierPickup`: unsupported records
`{ capability: "courierPickup", declared: "unsupported", probe: "no_port" }`
without a probe because no provider-reaching path exists. Supported fails with
`capability_not_certifiable`; supported provider cancellation also refuses because
its native path cannot demonstrate success. Pickup-point support needs its own
adapter success/failure witnesses. A contract pin forces reconsideration when a
courier-pickup port is added.

Transport handles are read-only `fake.calls` snapshots backed by the fake's
private log. Fault deltas belong to the indexed invocation; each claimed
submission requires exactly one provider call, and a pre-submission refusal or
replay requires zero. Status pairs execute in declared order using distinct
scenario indices. Only a captured adapter's factory brand permits `dispatch-only`,
which requires dispatch as its sole supported operation and earns no other
capability certification. Evidence includes mode, derived profile, capability
digest, ledger and port-less declarations. This validates data and recorded
invocations; it does not attest remote execution or establish host locks, durable
deduplication, cancellation races, replacement transactions or alignment.
See [certify a fulfilment adapter offline](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/how-to/build/fulfillment.md#certify-a-fulfilment-adapter-offline).

### Shipping rate-quote conformance (`@openlup/platform/shipping/testing`)

`@openlup/platform/shipping/testing` exports `runShippingRateAdapterConformance`,
`createScriptedShippingRateFake`, and `ScriptedShippingRateTransportError` for
offline certification of `CarrierRateQuotePort` adapters (declared on
`@openlup/platform/shipping` and type-only `@openlup/platform/shipping/contracts`).
Full mode requires authenticated `fake.calls` handles, validates integer
minor-unit currency fidelity and zero-I/O refusals, scans optional sensitive
canaries, and emits a deterministic `ShippingRateQualification` receipt.

### Communications conformance (`@openlup/platform/communications/testing`)

`@openlup/platform/communications/testing` exports
`runCommunicationsAdapterConformance`, `createScriptedCommunicationsFake`,
`ScriptedCommunicationsTransportError`, and `createInMemoryEmailTransport`.
Existing 1-argument baseline callers remain unchanged on both
`@openlup/platform/communications` and `@openlup/platform/communications/testing`.
Full mode (`{ mode: "full" }`) additionally enforces `guardEmailTransport`
egress admission, verifies authenticated transport fault handles (5xx, 401/403,
429, timeout, transport error), scans optional sensitive canaries, and emits a
deterministic `CommunicationsQualification` receipt.

### Shared adapter protocol primitives (`@openlup/platform/adapter-kit`)

`@openlup/platform/adapter-kit` exports zero-dependency protocol primitives for
provider adapters and recipes: `createHardenedFetch` (HTTPS origin pinning,
`redirect: "error"`, composed timeout signal, streaming byte cap, non-2xx body
cancellation), `createOAuth2TokenManager` (`client_credentials` and
`refresh_token` with single-flight deduplication and epoch-guarded
`invalidate`), `parseRetryAfter` / `createRetryAfterCooldown`, and webhook
verifiers (`verifyHmacSha256`, `verifyHardenedStandardWebhook`,
`verifyEd25519Signature`).

### Accounting, Observability, and Channel Conformance Kits

- `@openlup/platform/accounting` (`/contracts`, `/testing`): provider-neutral
  `AccountingLedgerExportPort`, zero-I/O balanced journal validator
  (`validateAccountingExportRecord`), and offline `runAccountingAdapterConformance`
  with authenticated fault handles (`AccountingQualification`).
- `@openlup/platform/observability` (`/contracts`, `/testing`): passive
  fail-open `TelemetryPort`, `createSafeTelemetryPort`, PII/secret attribute
  scrubbing, and offline `runTelemetryAdapterConformance` (`TelemetryQualification`).
- `@openlup/platform/channels/testing`: offline `runChannelAdapterConformance`
  and `createScriptedChannelFake` certifying `ChannelOrderSourcePort` webhook
  auth, `normalizedChannelOrderSchema` fidelity, and cursor pulls.

## Storefront continuation contracts

Status: current contract (experimental).

`@openlup/platform/storefront` is the browser-side home for the logic that keeps
a buyer's purchase safe across a lost response, a reload and a decline. It holds
types, three identity constructors, the recovery functions listed below, an
experimental continuation controller that composes them, and one constant of
markup anchor names. The functions and the controller reach storage, requests
and provider facts only through the host bindings a store passes in.

- **Identity roles.** A continuation identity names one purchase, a command key
  is the replay identity of one command and an attempt number counts payment
  attempts within a purchase. They are distinct types, and a plain `string` or
  `number` is none of them. The constructors return their argument unchanged
  and never refuse a value; which identities may be reused is decided by the
  host's identifier binding.
- **Bindings.** The store's client supplies storage, the submit transport, an
  identifier generator and a failure classifier as plain objects and functions
  (see [Binding](../../packages/core/docs/guide/glossary.md) in the glossary). The store keeps its storage
  names, serialization, wire spelling and provider facts.
- **Functions.** The first four keep the continuation record through the
  storage and identifier bindings; the fifth recovers a failed submit through
  the transport and classifier bindings; the last three, which are
  experimental, resume a pending provider action through the status binding,
  a clock and the provider facts:
  - `getOrCreateContinuationId` reuses the stored identity when the identifier
    binding accepts it, and otherwise mints one and stores it with the
    payload's fingerprint, and, unless told to continue unpersisted, returns
    `null` (nothing may be sent) when the record it wrote does not read back;
  - `readContinuationRecord` returns the stored record without an acceptance
    check;
  - `advanceAttempt` moves the stored record to its next payment attempt;
  - `clearContinuationRecord` clears the record, so the next purchase gets a
    new identity;
  - `recoverAmbiguousSubmit` replays the retained request once, unchanged,
    after a timeout or a transport failure, sends nothing after an in-flight
    refusal or an unrecognized failure, and returns an
    `AmbiguousSubmitRecovery` saying which happened;
  - `checkPendingResume` (experimental) keeps an expired marker without a
    status read, otherwise reads the status once and decides, and answers
    `unknown` rather than dropping or keeping the marker when the status could
    not be read;
  - `decidePendingResume` (experimental) turns one status reading into one
    `PendingResumeDecision` (experimental): drop the marker, reopen or follow
    the action, wait, keep the marker, or block a switch to another provider
    while an attempt that was not sent to its provider is still open;
  - `applyPendingResume` (experimental) runs exactly one effect for a decision
    and returns whether the submit must stop.
- **Controller.** `createPurchaseContinuation` (experimental) returns a
  `PurchaseContinuation` (experimental) that a store's UI renders from in any
  framework: `getSnapshot()` returns a frozen `PurchaseContinuationSnapshot`
  (experimental) that never carries the continuation identity, and
  `subscribe()` reports each new snapshot. It holds no timer and never reads on
  its own; each command is one step of the purchase:
  - `begin` reads the stored record into an `idle` snapshot and checks a
    pending provider action when one is stored;
  - `submit` sends the purchase under the key the host derives from the
    continuation identity and attempt, refuses a changed payload while a
    purchase may exist, sends nothing when the record cannot be stored, and
    replays a submit whose response was lost (a timeout or an uncertain
    transport failure) once under the same key;
  - `resume` reads the purchase by its key once and applies the answer;
  - `recordReturn` marks the buyer's return from a provider as waiting on the
    server, never as paid;
  - `startOver` asks the server to give up the purchase and clears the record
    only when the server answers that it is over.

  Only a declined answer for the stored attempt advances the attempt. Once a
  purchase is paid, the snapshot stays paid for that purchase until
  `startOver`; when another instance, such as another tab, starts a new
  purchase, the next command that reads the record shows the new purchase
  instead. An answer clears the stored record and pending-action marker only
  while they still belong to the purchase it answers. "Paid, activation
  pending" is a status of its own. The bindings object has no exported type
  name: a host names it as
  `Parameters<typeof createPurchaseContinuation<TPayload, TRequest, TResult, TOptions>>[0]`
  and a member as, for example, `…[0]["transport"]`.
- **Markup anchors.** Production markup reads its `data-openlup-*` attribute
  names and the action, state and field names from the constant instead of
  string literals. Names are only added; a wrong one is superseded, not renamed.
- **Maturity.** The whole entry is `experimental`. Names tagged `@experimental`
  stay outside a later stable promise of this entry until promoted on their own
  evidence. As with every export, a name is not removed once a release carries
  it, while its shape may still change in a minor release.

The entry is a leaf: it imports no other platform module and bundles for a
browser without Node built-ins. The declarations are in the
[API report](https://github.com/openlup/openlup/blob/main/packages/platform/api/storefront.api.md).

### Storefront verdict and proof-file contracts

Status: current contract (experimental).

A host, a production command and a proof harness read the same storefront
evidence from `@openlup/platform/lifecycle`, without importing test support:

- **Verdict.** `StorefrontVerdict` (format version 1) records one scenario
  run: its tier, channel, result, control, steps with the buyer's ledger after
  each, findings with four texts, the build identity and the harness inputs,
  including the outcomes the store's driver declared. `parseStorefrontVerdict`
  returns the typed verdict or a refusal (`storefront_verdict_invalid` naming
  the failing path, or `storefront_verdict_version_unsupported` naming the
  version found) and never throws. A `browser_ui` verdict requires `width`.
  `storefrontVerdictJsonSchema` is the same contract as frozen draft-07 data.
- **Proof file.** `StorefrontProofFile` (format version 1) names the
  configurations and widths to prove, local routes, auto-progress actions, the
  changed-payload policy, buyer overrides other than the e-mail, a recheck
  command and an optional relative adapter module. `parseStorefrontProofFile`
  and `storefrontProofFileJsonSchema` follow the verdict's rules; `host` is the
  one object a host may fill.
- **Digest.** `digestStorefrontFiles` is the one client-build digest:
  `sha256:` over a manifest of relative POSIX paths and their SHA-256, sorted
  by UTF-16 code units (not locale or UTF-8 byte order).
- **Open sets.** Tiers, channels, results, runs, phases, control, observer,
  build-source and adapter kinds, and finding codes accept values added later
  (`^[a-z][a-z0-9_]*$`); a reader keeps a default branch. Unknown fields are
  kept, except an own `__proto__` key, which is dropped. A result of
  `not_run` is missing evidence, never a pass.
- **Compatibility.** Within format version 1 fields are only added. Until the
  first release that carries the storefront runner, format version 1 may still
  be amended without a version bump; afterwards a removed field or changed
  meaning raises `formatVersion`.

Nothing here runs a scenario or reads a file. The declarations are in the
[API report](https://github.com/openlup/openlup/blob/main/packages/platform/api/lifecycle.api.md).

### Storefront test-support entry

Status: current contract (testing).

`@openlup/platform/storefront/testing` is test support for a storefront proof
harness. It runs under Node, beside the browser that drives the store's pages,
and never in a buyer's bundle: a browser bundle of the entry fails, and the
`storefront` entry cannot import it.

- **`StorefrontScenario`.** One buyer journey: its steps, the ledger safety it
  must keep, the progress it must reach and the control that must keep that
  progress from being reached, a create-request budget, one sentence each on
  stimulus, safety, progress and control, and `requires.outcomes`, the outcomes
  a run's outcome driver must declare for the scenario to be admitted. The
  step, safety and control language is at `testing` maturity, so its shape may
  change in a minor release with an upgrade note.
- **`StorefrontAdapter`.** A store's departures from the defaults: an `arrange`
  function up to the first buyer action, custom locators for actions and
  states, command matchers for create and read requests and the key header,
  auto-progress actions, routes and a recheck command. A field here overrides
  the proof file, which overrides the run's defaults.
- **`StorefrontObserver`.** Reads one run subject's ledger (orders, payable
  orders, orders holding stock, payment attempts and captures).
  `payableOrdersInDatabase` exists only when the observer reads a database
  exclusive to one run.
- **`PageHandle` and `createPageHandle(page, options?)`.** Wraps a Playwright
  page without importing a browser library: navigation, the current path
  without query, the width, anchor lookup and visibility, the visible
  `state:` and `action:` anchors, clicking, filling, request interception
  (`pass`, `withhold`, which delivers the request and fails the page's
  response, or `block`) and `settled({ quietMs, timeoutMs })`, which resolves
  once every intercepted request, followed through its redirects, has finished
  and `quietMs` passed with no new request, and otherwise rejects after
  `timeoutMs` naming the requests still open. An anchor is visible when its box is
  non-zero, the buyer can bring it into view, is not hidden (the browser's
  `checkVisibility` included, so a closed `details` element hides its content),
  is not fully transparent, and part of it survives clipping by the overflow
  boxes of the ancestors in its containing-block chain (a fixed or absolute
  anchor escapes those outside it; the page's root scroller never clips) and
  by `clip` and `clip-path`, with the element at that part's centre the anchor,
  a descendant or an ancestor of it. An anchor not already shown in full is
  scrolled into view before it is measured, and every scroll position is restored afterwards, instantly
  whatever the page's `scroll-behavior`. The handle reads no clock.

  Whether the buyer can bring an anchor into view is judged per axis before
  anything moves, walking its scrollers from the anchor outward: the overflow
  ancestors in its containing-block chain, then the viewport (whose overflow
  is the root element's, or body's while the root's is visible). A scroller the
  buyer can scroll (overflow other than `hidden` or `clip`) brings anything in
  its scrollable content into its range, so from there outward what must be
  shown is that range. A locked scroller must already show the anchor itself,
  or, when a scrollable scroller lies inside it, an anchor-sized part of that
  scroller's range. So an app shell, an `overflow: hidden` page or a body
  scroll lock hides an anchor below the fold, but not one inside a scrollable
  `main`, `#app` or modal. A container with nothing to scroll on an axis only
  clips there; the viewport always counts and does not move a fixed anchor.
- **`serializeStorefrontVerdict`.** Returns the verdict as two-space JSON with
  sorted keys and a line feed after `parseStorefrontVerdict` accepts it, so
  equal verdicts give equal bytes; it refuses a value JSON cannot carry
  (function, `undefined`, non-finite number, object that is not plain, cycle)
  instead of coercing it, and throws a `TypeError` with the refusal's four
  parts. A harness writes one file per run
  under `.context/storefront-verdicts/`; the entry writes no file.
- **`storefrontScenarios`.** The frozen scenario catalogue, by id; ids are
  never renamed.
- **`runStorefrontScenario(options)`.** Runs one scenario, given by id or as a
  scenario object shaped like the catalogue's entries, against a
  `PageHandle` and an observer and resolves `{ kind: "verdict", verdict }`,
  or with `stopAt` `{ kind: "stopped", stoppedAt, steps }`.
  Options: `scenario`, `page`, `observer`, `tier`, `profile`, `width`
  (required for `browser_ui` and equal to the page's width), `channel`
  (default `browser_ui`), `commands` (`create`, `read` and `keyHeader`, default
  `idempotency-key`), `proofFile`, `adapter`, `build` (`source` default
  `claimed`), `harness` (`runnerVersion`, the caller's claim, and
  `adapterDigest`), `runId` (8 to 40 letters, digits and hyphens), `clock`
  (`now()` in integer epoch milliseconds), `timeoutMs` (default 10,000),
  `quietMs` (default 3,000), `outcomes` (the outcome driver:
  `capabilities`, the outcome kinds it can produce, and
  `produce(outcome, { subject })`) and `stopAt`. Invalid options, including a
  malformed scenario object or outcome driver, reject with a `TypeError`
  starting `storefront_scenario_unknown` or `storefront_run_input_invalid` and
  its cause, fix and recheck, before anything is driven; a `stopAt` the
  scenario does not expect rejects `storefront_stop_state_unknown`.
- **`createPostgresStorefrontObserver(executor, options?)`.** An observer of
  `kind: "package"` over the platform's own tables, so a PostgreSQL-tier proof
  needs no store-written observer. `executor` is any object with
  `query(text, values)` over one database session, for example
  `asPostgresSqlExecutor(await pool.connect())` from `@openlup/platform/data`;
  the entry imports no database client. `ledger(subject)` finds the orders of
  the client whose e-mail equals the subject case-insensitively (the subject
  must carry no surrounding whitespace): `orders` in any status,
  `payableOrders` in `pending_payment`, `holds` orders with at least one
  `held` stock reservation, `attempts` simulator attempts and provider
  attempts on their settlement intents except those `blocked_preflight`
  (refused before reaching the provider; a `created` one counts), and
  `captures` captured simulator attempts and succeeded provider attempts, one
  per capture. Each count is its own subquery, so no join multiplies another.
  `exclusive: true` adds `payableOrdersInDatabase()`; set it only when the
  database is exclusive to one run. Every read is one statement in its own
  `BEGIN READ ONLY` transaction with `SET LOCAL row_security = off`, ended by
  `COMMIT` or, after any failure, `ROLLBACK`, so call the observer outside a
  transaction; `ledger` and `payableOrdersInDatabase` read separate snapshots.
  The reading role needs `SELECT` on `commerce_orders`, `clients`,
  `fulfillment_inventory_reservations`, `commerce_settlement_intents`,
  `payment_simulator_attempts` and `payment_provider_attempts` and must own
  them or have `BYPASSRLS`: the grants alone are not enough, because
  `clients` and `payment_provider_attempts` have row-level security, and a
  role it applies to would read zeros. With row security off PostgreSQL
  refuses such a read, and the observer rejects
  `storefront_observer_row_security`. A read outside its own transaction (an
  executor over several sessions) rejects `storefront_observer_session_invalid`;
  a count that is not a non-negative safe integer rejects
  `storefront_observer_count_invalid`, never zero. A host whose records live
  elsewhere supplies its own observer.

**Running a scenario.** A store whose pages carry the anchors and whose proof
file declares `routes.selectionEntry` for the scenario's purchase mode writes no
adapter: the default arrangement opens the selection entry, performs
`proceed_to_checkout` and fills each field anchor it finds from the buyer
values (`email` must resolve; it carries the run's subject,
`storefront-<runId>-clean@example.test` or `…-control@example.test`). After a
reload a declared selection entry is arranged again; otherwise an adapter's
`arrange` arranged the run and only the details are re-typed. The clean run
reads the subject's ledger first, then routes every request through one
interceptor that classifies it by the create and read matchers and records
whether each command reused an earlier key (the key value is compared, never
stored). A step ends only when the page has settled, and the runner then reads
the ledger, the visible anchors and the path; after the last step a settle
window waits once more and reads them again. The control run repeats the steps
under its own subject with the scenario's control: `block_read` blocks every
request of its commands from its step; `omit_action` omits its action and,
where the scenario says so, the outcomes after it; `other_policy` changes
nothing and must not show the progress of the changed-payload policy the proof
file does not declare. An arrangement that fails under the control is the
control's effect: the remaining steps are skipped and the settle window still
samples the page. The clean and control runs share the page and its browser
storage.

| Scenario | Stimulus | Safety | Progress | Control | Requires |
| --- | --- | --- | --- | --- | --- |
| `lost_response_reload` | The first place-order response is withheld after the server received it; reload; arrange again; place the order again | At most one payable order, one order holding stock, one capture | `awaiting_payment` offering `continue_payment` | `block_read` of `read` and `create` from the reload; negates `awaiting_payment` | — |
| `duplicate_submit` | Place the order twice while the first create is held | At most one payable order, one order holding stock, one attempt, one capture | None | None: `safety_only` | — |
| `lost_response_edited_payload` | As `lost_response_reload`, with the first name changed before placing the order again | At most one payable order, one order holding stock, one capture | `update_in_place`: `awaiting_payment` offering `continue_payment`; `refuse_changed`: `details_changed` offering `continue_payment` and `start_over` | `other_policy`; negates the other policy's state | — |
| `reload_pending_attempt` | Continue to payment; the attempt stays pending (`awaiting_authority`); reload; the pending attempt settles | No payment attempt after the step before the reload; one capture | `awaiting_authority` after the reload, then `paid` | `block_read` of `read` and `create` from the reload, outcomes kept; negates `paid` only | `pending`, `settled_after_pending` |
| `decline_retry` | Continue to payment; declined (`declined` offering `retry_payment`); retry; settled | At most one payable order, attempts at most declines plus one, one capture | `paid` | `omit_action` of `retry_payment`, the outcomes after it skipped; negates `paid` | `declined`, `settled` |
| `paid_pending_activation` | A subscription; continue to payment; the payment settles while activation stays pending | Clean run: never `paid` or `declined`, and no `awaiting_payment` once it showed `paid_pending_activation`. Control run: never `paid` or `declined` (awaiting states allowed). One capture | `paid_pending_activation` | `block_read` of `read` and `create` from the outcome, outcomes kept; negates `paid_pending_activation` | `activation_pending` |

The edited-payload progress follows the proof file's `changedPayloadPolicy`;
an absent or unknown policy reads as `refuse_changed`, and a clean run that
shows the other policy's progress is `policy_mismatch`. Each scenario also has
a create budget (3, 2, 3, 1, 1 and 1 creates per run); a run that sends more
stops with `request_budget_exceeded`. Whenever `state:paid` or
`state:paid_pending_activation` shows, the ledger must hold a capture and no
payable order. Anchors and the ledger are sampled when a step has settled and
in the settle window, so a state shown only for a moment inside a step and
gone before it settles is not seen.

**Outcomes and admission.** An `outcome` step asks the run's outcome driver
for one outcome: `declined`, `pending`, `settled`, `settled_after_pending`
(settles an attempt the driver left pending) or `activation_pending` (the
payment settles while subscription activation stays pending). A scenario runs
only when every kind in its `requires.outcomes` is one the runner knows and the
driver's `capabilities` declare; otherwise it ends `not_run` with
`tier_unreachable`, naming each missing outcome, before any page, observer or
driver call. Tier names do not decide admission. Every capability must be a
name (`^[a-z][a-z0-9_]*$`; another value is refused as invalid input), and one
the runner does not know is ignored; the verdict's `harness.declaredOutcomes`
records the declaration, so a store that declares fewer outcomes is visible to
every reader; a store's proof harness pins the declaration it requires.

Each outcome has a ledger effect, compared with the ledger at the end of the
previous outcome step (zero before the first): every outcome except
`settled_after_pending` acts on a new payment attempt, so attempts grow;
`settled_after_pending` needs at least one; a settling outcome (`settled`,
`settled_after_pending`, `activation_pending`) adds a capture, while
`declined` and `pending` add none. A rejected `produce` is `outcome_failed`
(cause `rejected`), and so is an outcome whose effect the ledger does not show
(`no_attempt`, `no_effect`): the run stops, and such an outcome never counts
as stimulus. The ledger has no decline or pending status, so a driver that
answers `declined` or `pending` without acting on a fresh attempt is not told
from a store that ignores the outcome (a stated limit).

**Auto-progress.** When the UI performs a scenario's omitted action by itself
and the effective `autoProgress` (adapter, else proof file) declares it,
neither run performs it: the clean run waits for the next expected state, and
the control becomes a `block_read` of status reads from the step before the
action, with the outcomes after it skipped. When the clean run still offers
the action at the end of the step after it and the next expected state is not
shown, the declaration is wrong: `auto_progress_not_performed` (`not_run`,
field `autoProgress`). Under an `omit_action` control, a
negated state reached after a status read was matched from the omitted action
on is `auto_progress_undeclared` (`not_run`; declare the action); reached
without one, it is `vacuous_progress`.

**Stop-at.** `stopAt: "checkout.<state>"`, for a state an expect step of the
scenario names (`checkout.awaiting_payment`, `checkout.details_changed`,
`checkout.awaiting_authority`, `checkout.declined`, `checkout.paid`,
`checkout.paid_pending_activation`), runs the clean steps until that state is
visible after a step, removes the interceptor and resolves
`{ kind: "stopped", stoppedAt, steps }` with the page left there: no control
run and no verdict. A state not reached rejects
`storefront_stop_state_unreached` naming the last step, as does a scenario that
is not admitted, before any call.

**Judgement.** Every failed check adds a finding with its run, step, the field
at fault where there is one, and texts saying what was observed, why and how
to fix it, and the recheck command (`recheck` from the adapter or proof file,
`{scenario}` replaced). The first failing group decides the result:

| Order | Check | Codes | Result |
| --- | --- | --- | --- |
| 0 | Admitted: every required outcome known and declared | `tier_unreachable` | `not_run` |
| 1 | Page, observer, arrangement and outcome driver worked | `page_failed`, `observer_failed`, `arrange_failed`, `outcome_failed` | `not_run` |
| 2 | No order before the arrangement; one after the first matched create | `observer_subject_unseen` | `not_run` |
| 3 | The first order appeared in a step with a matched create; every withhold applied; declared auto-progress was performed; every outcome shows its ledger effect | `stimulus_not_create`, `stimulus_not_applied`, `auto_progress_not_performed`, `outcome_failed` | `not_run` |
| 4 | Ledger safety in both runs and settle windows (also no attempt after its step, attempts per decline, forbidden states per run); with an exclusive database, payable orders added equal those of the subjects | `duplicate_order`, `duplicate_hold`, `duplicate_capture`, `second_attempt`, `forbidden_state_shown`, `order_outside_subject`; `observer_failed` when fewer were added | `failed`; `not_run` |
| 5 | The create budget kept | `request_budget_exceeded` | `not_run` |
| 6 | Each matcher used matched in the clean run, and for `block_read` a request of the blocked set after its start; each needed anchor resolved and was visible | `adapter_matcher_unmatched`, `adapter_anchor_missing`, `anchor_hidden` | `not_run` |
| 7 | The clean run reached its expected state | `policy_mismatch` (the other policy's state), `progress_not_reached` (another state shown), `adapter_anchor_missing` (none) | `failed`; `not_run` |
| 8 | A `block_read` control blocked a request; its negated state was not reached (within `quietMs` at the expect), also where the scenario forbids other states in the control run | `control_not_applied`, `auto_progress_undeclared`, `vacuous_progress` | `not_run`, `vacuous` |
| 9 | All hold | — | `passed`, or `safety_only` without a control |

A harness fault is never `failed` or `passed`. A run that exceeds its budget
stops before its progress and control are exercised, so it proves nothing
either way; a ledger violation seen before the stop still makes it `failed`.
Likewise, ledger harm a run proved before a fault or a stimulus check that
ends `not_run` (in the clean run before one in the control run, or at or
before its step in the same run) outranks it, so the result is `failed`.
Forbidden states are set per run in the scenario's `forbiddenStates`:
`control` lists the states the control run must never show, from its first
sample on (outcomes a page whose status reads are blocked cannot know; an
awaiting state stays allowed there, and the state the control negates is left
to `vacuous_progress`, as in every `block_read` scenario); `clean.ruledOut` lists the outcomes the
clean run must never show; and once the clean run has shown
`clean.afterShowing.state`, each state in `clean.afterShowing.regressions` is
forbidden too (cause `regression`). Each finding names its cause
(`unknowable`, `ruled_out`, `regression`).
The control's checks run over every recorded control step, also when the
control run stopped. A fault's text keeps its code and first sentence with
every URL replaced by `<url>`. `not_run` is missing evidence, never a pass.

**Trust.** A verdict produced on a developer's machine is a claim about that
build, not evidence for a release; only a verdict a CI run records for an equal
build identity is reused.

**Matching limits.** A command matcher sees only the method and the request
path, without query string or fragment, so a token in a query never reaches a
matcher or a verdict. A store whose operations share one endpoint (for example
a single GraphQL path) cannot tell create from read by matcher; a server-sent
event stream is one request the handle can pass or block as a whole, but not
message by message, and WebSocket frames are not requests at all; requests
answered by a service worker are not routed unless the harness blocks service
workers in its browser context; a cross-origin request is matched by path
alone; `settled` follows a redirect to the request the browser reports it
redirected to, and a hop the browser does not report is covered only by the
quiet window. An open stream, a long poll or a request in flight when the page
closes keeps `settled` pending until its `timeoutMs` (default 30,000), when it
rejects with `storefront_page_settle_timeout` naming each open request's method
and path. An anchor inside a shadow root is measured as covered: the walk
stops at the shadow root, so the handle does not yet see such an anchor as
visible.

**State anchors.** Each `data-openlup-state` value means one thing to the
runner:

| State | Meaning |
| --- | --- |
| `awaiting_payment` | An order exists and the buyer can pay |
| `details_changed` | The server refused changed details under the same purchase |
| `awaiting_authority` | Only a later status read can say how a payment ends |
| `declined` | The attempt was declined and the order stays payable |
| `paid` | Payment captured |
| `paid_pending_activation` | Payment captured, subscription activation pending |

The declarations are in the
[API report](https://github.com/openlup/openlup/blob/main/packages/platform/api/storefront-testing.api.md).

## Core grouped PostgreSQL schema probe

For PostgreSQL catalog inspection, import `buildGroupedPostgresSchemaProbe`,
`decodeGroupedPostgresSchemaRows` and `PostgresSchemaCatalogEntry` from
`@openlup/core/readiness`. The builder accepts the existing `SchemaObject`
identities and returns one SQL statement with bound values. Tables use
`to_regclass` and must be ordinary or partitioned; columns split the final name
component exactly as the scalar builder does and exclude system/dropped
attributes; functions use `to_regprocedure` with the exact signature (omission
means zero arguments). PostgreSQL retains responsibility for name resolution
and invalid-name errors. Duplicate requests retain separate one-based integer
ordinals; an empty request executes a valid empty catalog read.

Rows carry `ordinal`, boolean `present` and `shape`. The decoder requires exactly
one row per input, in ordinal order. Legitimate absence is `false` with SQL
`NULL`; presence requires nonempty JSON text parsing to a nonnull, nonarray object.
Parsed driver objects are refused.
Missing, extra, duplicate, reordered or noninteger ordinals, malformed presence,
inconsistent absence and invalid/nonobject JSON throw a bounded generic error
without catalog bodies. Extra row columns are ignored. JSON.parse property and
nested array order are retained without sorting, canonicalization or rebuilding; input objects and
rows are not mutated. Database/driver errors propagate to the host.

Each shape is `pg_catalog.jsonb_build_object(...)::text`, retaining PostgreSQL
jsonb field ordering as parsed by the consumer. Shape fields are: functions expose `definition`, `owner`,
`acl`, `config`, `securityDefiner`, `volatility`; tables expose `kind`, `owner`,
`acl`, `rls`, `forceRls`, `constraints`, `indexes`, `triggers`, `policies`; columns
expose `type`, `notNull`, `identity`, `generated`, `default`, `acl`. Catalog nulls
are retained. Constraint/index/noninternal-trigger aggregates contain definition
strings ordered by constraint name, index OID cast to regclass text or trigger
name, and remain null when empty. Policies use `pg_catalog.pg_policy`, ordered
by policy name, with `name`, raw role OID array `roles`, command code `cmd`,
boolean `permissive`, and expression strings/nulls `qual`, `check`; the aggregate
remains null when empty. Definitions come from PostgreSQL's `pg_get_*` functions
and column types from `format_type`.

The host executes and decodes the query through its own driver and owns
connection/TLS/role, any `READ ONLY REPEATABLE READ` snapshot, requirements,
independently observed identity and migration ledgers, digest policy,
invalidation and admission. Catalog shapes do not establish SQL behavior,
effective grants, recovery or authorization. The grouped helpers add no I/O,
transaction, retry or deadline and do not change `createSchemaProbe`,
`SchemaObservation` or readiness codes. A host maps decoder/driver failures to
its existing unknown policy. Focused decoder tests extend the existing
standalone readiness suite. Actual installed-tarball SQL and shape-order proof
runs in the existing Outbox disposable PostgreSQL tier in the source repository.
