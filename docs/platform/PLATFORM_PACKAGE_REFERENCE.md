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

Evidence (historical record, 2026-11-13):

[restricted PostgreSQL characterization](../../tests/postgres/commercePriceAuthorityRead.test.ts).

## Application file upgrade

This development-preview recipe uses the experimental `@openlup/platform/lifecycle`
export from the selected candidate or release that actually contains it. Work
in an existing disposable application outside the platform checkout, with Node
24 and that application's own exact package pins and authority. Keep real
brand, content, policy and provider composition outside the managed inventory.

For an app whose existing `generated/entry.mjs` contains exactly
`export const revision = 1;` followed by a newline, run from the app root:

```js
import { realpath } from "node:fs/promises";
import { planAppUpgrade, applyAppUpgrade } from "@openlup/platform/lifecycle";

const from = {
  version: "example-N-1",
  schema: { min: 1, max: 2 },
  files: { "generated/entry.mjs": "export const revision = 1;\n" },
};
const to = {
  version: "example-N",
  schema: { min: 1, max: 2 },
  files: { "generated/entry.mjs": "export const revision = 2;\n" },
};
const input = { root: await realpath(process.cwd()), from, to, schemaVersion: 2 };
console.log(await planAppUpgrade(input)); // Read-only: inspect actions/conflicts.
// State-changing: hold the app's exclusive maintenance window before applying.
await applyAppUpgrade(input);
```

The ordinal `2` is caller-supplied example evidence, not a database probe or an
OpenLup schema version. Observe the actual database and compatibility policy
separately. Keep immutable predecessor/candidate snapshots for interrupted
resume; repeat apply with those same snapshots. A divergent managed edit refuses
before writes and requires reconciliation; upstream-unchanged and unlisted files
remain application-owned. Do not infer dependency, migration/backfill or
deployment completion from file apply. Read the
[ownership and recovery limits](ARCHITECTURE_AND_EXTENSIONS.md#application-file-upgrades)
before using the primitive beyond this disposable app.

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

Reference bindings lazily load the PostgreSQL entry after bundle and connection
guards. No migration or privilege change accompanies this package boundary.
The reference privacy graph leaves marketing unselected, with coverage still an
open gap. The exported privacy ports and `MarketingPrivacyContributor` use local
structural types and identity's `./identity/contracts` types. Identity's public
surface is unchanged.

Evidence (historical record, 2026-11-13):

The real PostgreSQL witness applies the hash-checked manifest prefix through the
survey/newsletter evidence migration and invokes ports through a login granted
only runtime-role membership. The fixture owner serves setup, state inspection
and append-only trigger proof; separate runtime-role mutation assertions prove
privilege denial. Missing Docker fails that proof.

Their compatibility with
identity's contributor is checked in the marketing compiler witness, keeping the
`./marketing/server` declaration closure free of identity's main entry and the
optional `pg` peer.

## Identity import candidate

`createPostgresContactClientRegistrar` adds host-only guest contact resolution
through the existing identity entry. It inserts only unlinked contacts and
refreshes optional defaults and journey facts only while a contact is unlinked;
linked rows remain byte-identical. The result's `linked` and `created` fields must
never reach a browser. The host owns checkout admission, requester quotas and
retention. See [guest contact resolution](IDENTITY.md#guest-checkout-contact-resolution)
for typed refusals, exact email matching and subject-level erasure behaviour.

The OIDC API adds `createOidcIdentityVerifier`,
`deriveOidcPrincipalId`, `createPostgresAccountLinkStore` and
`identityOidcReadiness` from `@openlup/platform/identity`, which also exports
`OIDC_FAILURE_CODES` and `OidcFailureCode` for hosts. The browser-shared
`@openlup/platform/identity/contracts` entry excludes OIDC refusals.
Inject the host's selected JWT library through `IdentityJwtLibraryLoader`.
Discovery and rotating keys load only on verification or readiness. The opt-in
direct composition uses normal reconcile with an explicit email-trust policy,
authenticated actor reads and live operator membership. Managed storage requires
native federation sessions and refuses raw upstream-token composition. Run
`node tests/postgres/runOidcIdentityConformance.mjs` from the repository root with
its cached pinned issuer and local prerequisites; the [OIDC recipe](IDENTITY.md#real-issuer-oidc-recipe)
owns timing, refusal, session and certification boundaries. There is no schema or
default login flow change; existing static session verification and default
reference/browser flows retain their runtime behaviour.

The existing `IdentityJwtLibrary.jwtVerify` contract widens with optional
`currentDate?: Date` and `clockTolerance?: number` verify options and now returns
`{ payload: IdentityJwtClaims }`, whose claims interface includes a string index
signature. **Migration:** hosts implementing or typing their own
`IdentityJwtLibrary` or `IdentityJwtLibraryLoader` must accept the optional verify
options and return claims as `IdentityJwtClaims`.

The direct operator API adds `createPostgresOperatorIdentityStore`,
`createOperatorSessionService`, `createOperatorIdentityVerifier`,
`createOperatorAdminAuth` and `createOperatorAuthHandlers` to `./identity`.
`./identity/contracts` exposes strict operator challenge/session schemas and
`OperatorBrowserAuthPort` without a server or provider import. Challenge delivery
and session signing use the existing structural ports. Operator handlers send
the padded generic acceptance before awaiting mailbox delivery, keeping delivery
latency out of the response. Custom HTTP composition uses the session service's
optional acceptance callback for the same ordering. Restoration reads preserve
in-flight browser redemption; explicit sign-out still cancels it. Active operator
login needs no pending invitation and preserves membership and invitation history. The new store's public
signature exposes no driver types and loads its optional driver only on use.

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

Creating a client/contact records commerce contact data, not an authentication
identity. Creating an auth user provisions a principal. Neither a typed address
nor a soft-account link proves mailbox ownership; reconcile may create a contact
for an existing authenticated principal without creating that principal.

Customer soft-account provisioning now creates unconfirmed auth users
(`email_confirm:false`). The soft-account linker retains create-first lookup,
normalized duplicate recovery and conditional linking. Checkout and paid-order
retry are adopter composition that must call the linker. Failed links retain
the provisioned identity for retry. Customer magic links keep
`shouldCreateUser:false`: captured mailbox proof confirms that existing user;
unknown addresses cannot sign themselves up through this path.

The managed link store requires an injected `emailTrustPolicy`, assessed before
creation or linking an existing identity by email. Unsafe or unavailable settings
return a non-fatal soft-account refusal (`EMAIL_TRUST_ENVELOPE_REFUSED` or
`EMAIL_TRUST_SETTINGS_UNAVAILABLE`) without creating an identity or link. Matching
existing links retain their replay behaviour. The reference adapter binds managed
settings assessment regardless of the selected bundle.

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


The `./identity` server entry imports the existing identity engine, authorization,
profile readers, session adapters and BFF factories into one capability. Its
`./identity/contracts` entry is declared browser-safe and currently exposes the
customer auth port, value types and provider parser. Runtime-schema extraction
is pending the contracts-boundary choice described in the
[identity owner page](IDENTITY.md). Both entries ship in the published package
as an experimental development-preview capability.

Application composition supplies SDK clients/loaders, feature admission, redirect
policy, rate limiting, messages, sender and deployment URLs. Factories use the
foundation BFF envelope and accept the application's observed request-ID reader.
The module depends only on the declared foundation entries, without changing the
artifact's rail kind. Its schema contribution requires a host-selected inventory;
its seven SQL files are verbatim projections at canonical positions 11, 12, 29,
60, 67, 68 and 69, not an independent migration chain. The owner page maps the characterization
witnesses and records the remaining evidence.

Identity authorizes stored operator roles only when they are `admin` or
`distributor`; null and unknown values return `FORBIDDEN` (HTTP 403). The reference
admin-profile reader reports those rows as non-admin, and admin magic links do
not send for them while retaining the generic accepted response, padding and
quota. Adopters needing legacy role mapping must do it in their own adapter
before passing the role to the package; there is no package fallback option.

Both managed contact stores match normalized addresses case-insensitively,
including mixed-case stored contacts. Literal matching uses an anchored, escaped
`imatch` database prefilter plus an exact `email.trim().toLowerCase()` comparison
with the normalized input. Unicode regex folding alone cannot establish identity.
Both lookups select email and fetch at most ten candidates. Soft linking selects
the oldest accepted contact; reconciliation requires a single accepted contact
and throws the existing multiple-row error if several remain. A match beyond the
candidate bound is not selected. Injected structural query clients must implement
`filter(column, "imatch", value)` and the bounded array query. The direct customer
challenge already compares `lower(email)` to normalized input; no migration is
needed.

Magic-link factories default to the shared strict origin resolver. Pass
`redirectOrigins: ["https://example.com", "https://secondary.example.com:8443"]`;
the first configured origin builds the callback and every entry must be an exact
HTTP(S) origin, without credentials, a path, query or fragment (a root trailing
slash is accepted). Request headers never authorize an origin. Missing or invalid
configuration returns BFF `UPSTREAM_UNAVAILABLE` (503), with details reason
`magic_link_origin_not_configured`, before provider access. Customer `returnTo`
is normalized to a same-origin relative path; unsafe targets are omitted for the
callback's default landing page. An adopter needing its existing policy can keep
passing `resolveOrigin`; that explicit injection overrides the default. See the
[identity redirect contract](IDENTITY.md#magic-link-redirect-policy)
for reference configuration and migration.


### Operator invitations

`identity/contracts` exposes distinct direct pending-invitation and managed
active-membership results. Matching runtime schemas remain in the server entry.
The admin-action port returns `OperatorInviteResult`, a union of those results.

`createDirectOperatorInvitationStore` provides the new pending, active, expired and
revoked lifecycle in its trusted PostgreSQL transaction lane, including ordered
membership locks and atomic membership/audit writes. Direct callers inject the
store and a parsed TTL. `createDirectOperatorIdentityDirectory` commits principal
creation/reuse separately. Apply the complete direct catalogue through position
67; the byte-identical package projection is for inspection and composition, not
a standalone fresh chain. Direct human acceptance is a trusted command,
unmounted from machine authentication.

Managed hosts use `createInviteAdminUserGateway().activateMembership` in
`runInviteAdminUserUseCase`. Insertion immediately creates active `admin_users`
membership with invitation provenance; it omits `is_machine_actor` and relies on
the database default false. The result carries principal ID, role, active state
and `MEMBERSHIP_CREATED` or `ALREADY_ACTIVE`, without pending timestamps or an
invitation ID. Identical repeats and concurrent insert losers return the existing
membership without a second notification. Role differences conflict; revoked
members refuse with `MANAGED_REINVITE_UNSUPPORTED`. Failures retain identities
for retry, including after notification failure. No Auth metadata store,
first-entry acceptance, expiry or compensation is used. Magic-link eligibility
requires active membership and a known role. Authorization, removal and admin
`me` retain their actor bindings without a service key for lifecycle state.

**Migration:** direct hosts can adopt the new pending lifecycle by applying
`20261018120000_identity_operator_invitations` after the existing direct catalogue
and composing the store, trusted human acceptance and parsed TTL. Existing
memberships are preserved. Managed immediate activation is retained; managed
consumers must now parse the structured active result and its
`MEMBERSHIP_CREATED`/`ALREADY_ACTIVE` codes instead of message-only success.
Duplicates return existing membership rather than `ALREADY_ADDED`, and
notification failure returns 503 `INVITATION_NOTIFICATION_FAILED` while keeping
membership active. Managed pending/expiry remains a compatibility gap requiring
a separate transactional store and reviewed forward. No managed SQL, RPC or SDK
dependency is added. See the
[identity lifecycle owner](IDENTITY.md#operator-invitation-lifecycle).

The managed chain's identity capabilities forward
`20261018160000_identity_service_role_capabilities.sql` grants `service_role`
SELECT(email) and INSERT(id, email, role, membership_state, membership_provenance,
membership_accepted_at) on `admin_users`.
The opt-in managed conformance replays the complete committed chain with ambient
default ACLs removed and adds no grant. It proves immediate activation,
repeat/concurrent recovery and revoked-member refusal under the shipped grants.
It does not establish managed/direct lifecycle parity.

With a fresh local managed stack running, export its API URL, service key and
PostgreSQL owner (`supabase_admin`) connection URL as `OPENLUP_MANAGED_CONFORMANCE_URL`,
`OPENLUP_MANAGED_CONFORMANCE_SERVICE_KEY` and
`OPENLUP_MANAGED_CONFORMANCE_DATABASE_URL`, then run from the repository root:

```sh
npm --workspace @openlup/platform run build
node --import tsx tests/postgres/operatorInvitationManaged.conformance.ts
```

The module refuses non-loopback endpoints, an already-installed public schema,
and existing synthetic fixture identities. It retains synthetic identities;
discard the disposable stack after the run. Its database owner connection must
be able to replay the committed prerequisites, baseline and ordered forwards.

## Personal data

The experimental identity entry exposes `createPersonalDataContributorRegistry`,
`createIdentityPersonalDataContributor`, `createPrivacyOperations`,
`exportPersonalData`, `erasePersonalData`, `createPrivacyExportHandler` and
`createPrivacyEraseHandler`. Browser requests, versioned contributor documents and
receipts come from `@openlup/platform/identity/contracts`. Register every required
contributor explicitly, with its owned fields, assessment, erase/retain operation
and remote/retention obligations. Missing required owners refuse erasure; export
reports missing coverage. This capability erases identity-owned data only.

Direct hosts compose `createPostgresPrivacyUnitOfWork` and
`createPostgresPrivacyStore` with the identity contributor and their domain vetoes
using the same executor. The reference subscriptions contributor holds a relation
lock through commit, refusing active and paused subscriptions without changing
them. `IdentityPrivacyPolicy.retainedContactFields` names explicit retention
owners for populated opaque columns; unknown ownership refuses. The reference
retains lifecycle/acquisition fields, and refuses nonempty metadata or external
references until an owner declares their disposition.

Migration: apply the complete direct catalogue including
`20261018190000_identity_privacy_erasures` before using privacy or the updated
customer challenge store. The forward appends one receipt table at position 69
without grants or stored functions. Direct erasure pseudonymizes identity-owned
fields, deletes challenges and outstanding invitations, uses guarded membership
revocation, clears only the selected contact's direct principal link, and commits
an idempotent audit receipt atomically. Contact IDs and managed auth links never
change. Failed writes roll back. Retained audit references are pseudonymous, not
an assertion of anonymization. Already-issued tokens may remain valid until expiry.
Customer challenge issuance and redemption reject a receipt for either the
contact or principal under the same transaction-held challenge relation lock as
erasure, including late challenges inserted after cleanup. Hosts must use the
package adapters; calling the retained raw challenge SQL functions directly
bypasses this erasure receipt fence.

Managed hosts compose `createManagedPrivacyStore` with their structural service
client for export. Coverage explicitly excludes inaccessible country and
identity history/receipt fields. Managed erasure refuses with
`MANAGED_PRIVACY_ERASURE_UNAVAILABLE`: a managed adopter must provide its own
erasure path. The committed grants and structural client cannot provide the
required mutations and atomic receipt. This change adds no managed forward or
erasure grants. Provider identity is never deleted; any future composed provider
erasure must disable it after committed local success. The managed refusal here
occurs before reaching any provider mutation.

The reference mounts authenticated human-admin export/erase POSTs and an Admin
Settings readback panel. Direct and managed mounts require the adopter deployment
policy under admin mutation risk; the public default returns
`adopter_policy_required` before body/query reads, and direct mounts also refuse
before authentication or privacy binding construction. The shipped dispatcher mounts
both routes for managed bundles even when its caller supplies no routes. After admission,
exports and receipts stay in memory with no-store
responses. The maintenance `prune-challenges` command prunes separate bounded
operator/customer batches. See [identity privacy](IDENTITY.md#identity-personal-data)
for refusals, token limits and retained obligations.

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


Reference startup can compose identity through `createReferenceIdentity` and
`startPublicReferenceServer({ identity })`, with explicit route functions,
selected adapters, trusted schema/migration observation and the bundle-specific
inventory. It consumes email-trust readiness before listening, and rejects
unknown or unsatisfied candidates. Direct reconcile reads the existing actor
link; direct invite/remove select the pending-invitation stores. The default
static reference and browser page sets remain unchanged. See the
[composition contract](IDENTITY.md#responsibility-and-composition).

Both identity entries already belong to the public export map and build output;
artifact availability does not imply registry publication or release activation.
The cold installed-artifact consumer imports both entries without optional peers,
compiles contracts without driver types, and invokes every driver-owning direct
identity adapter for its missing-peer refusal. Managed factories consume
structural clients. Server declarations compile after peer selection. Full
installed-artifact and database proof require the existing supervisor-run package
consumer command and an owned disposable database.

The managed identity service-role capabilities forward in the committed chain
supplies client link writes and operator membership insert/email-read
permissions; the local conformance runners add no fixture grant. No migration is
added by reference composition.


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

`blocked` returns failure; explicit `drop` returns terminal suppression with no
send, no identifier and an ineligible sent timestamp. Arbitrary injected objects
are refused by `guardEmailTransport`; a provider name or copied capture shape
cannot establish admission. Package-created capture retains its ordered envelopes
and synthetic identifiers with no network effect. Capture acceptance remains
local acceptance, never evidence of external delivery.

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

Compatibility facade helpers retain host-specific keys, diagnostics, accounting
and fulfillment translations, and the reversal handler's 10 s timeout. Keep
reference facade wiring and carrier-fit details with their owners.

Evidence (historical record, 2026-11-13):

The seller-forward SQL freezes first-claim seller using `revisionRef` as the
wrapper revision; P7 owns host composition under the
[invoicing phase obligations](plans/oss-m09-invoicing.md#phase-obligations).
For uncertain sends, native passes `p_receipt` NULL and retains a non-null receipt
hint in `p_evidence`; managed passes the hint as the provider message ID.

Inspect the [contract](../../packages/platform/test/invoicing/contracts.test.ts)
and [carrier fit](../../packages/platform/test/invoicing/portFit.test.ts) witnesses.

Use [the conformance witnesses](../../packages/platform/test/invoicing/adapterConformance.test.ts)
for offline examples.

### Invoicing read helpers

Moved to [Compose invoicing](../../packages/core/docs/guide/how-to/build/invoicing.md#deliver-documents).

Keep CTL-M09-3's 191000 SQL pin and managed facade key and diagnostic bytes with
the adapter owner. The reference history shim translates legacy columns without
changing its public DTO; operator HTTP/UI diagnostics use closed codes and omit
provider free text. Runbook URLs remain host inputs.

The reference payout facade selects the injected item-capable port when supplied;
otherwise its accounting control port preserves donor calls and aggregate counts.
Package counts accept only item-level receipts, so they may differ from legacy
host counts.

Evidence (historical record, 2026-11-13):

The
[native delivery contract](../../tests/postgres/invoicingDelivery.test.ts) exercises
store/job results and durable state against the pinned SQL, including retry and
terminal outcomes; it makes no live transport or inbox-delivery claim.

### Captured native invoices

Moved to [Compose invoicing](../../packages/core/docs/guide/how-to/build/invoicing.md#capture-sandbox-invoices).

Evidence (historical record, 2026-11-13):

No managed adapter behaviour, database object or grant is changed. The existing
qualified runtime table permissions suffice.

The [installed/native witness](../../tests/postgres/invoicingCaptured.test.ts)
exercises the packed entry through a restricted login; it is local sandbox proof,
not live-provider or hosted qualification.

## OMS composition

Moved to [Compose order management stores](../../packages/core/docs/guide/how-to/build/oms-stores.md#choose-the-imports).

Reference identity/provider projections and schema extensions remain
application-owned. Preserve the structural RPC/query split rather than making a
reference projection a generic platform contract.

### Native OMS and support stores

Moved to [Compose order management stores](../../packages/core/docs/guide/how-to/build/oms-stores.md#choose-the-imports).

Source reference facades share the promoted stores' account/support error
constructors. Moving read contracts adds no diagnostic store or route;
diagnostic storage, admission and governance retain their separate owner.

Evidence (historical record, 2026-11-13):

The [installed-store witness](../../tests/postgres/m19StorePromotion.test.ts)
selects compiled tarball exports and the complete `qualified-v2` chain with a
restricted runtime login; [identity assertions](../../tests/postgres/m19StorePromotionIdentity.test.ts)
cover reference facades and refusal constructors. Their presence is not a passing
qualification result; the [task record](plans/oss-m19-g12.md) carries executed proof.

## Account and support contracts

Moved to [Compose account and support services](../../packages/core/docs/guide/how-to/build/account-and-support.md#choose-the-imports).

The reference host forwards `commerceOwner.services` directly; wrapping them in
another M11 binding would duplicate native operations. Keep source facade/UI
assembly with the reference host. Reference route selection rejects an unselected
callable with `account_support_entry_operation_required`. See the
[runtime recipe](RUNTIME_AND_SELF_HOSTING.md#opt-in-disposable-subscription-reference).

Evidence (historical record, 2026-11-13):

Owner refusal unions, optional fields, readonly fields and nullability
are preserved by local structural declarations with executed owner-equality tests.

The [module design](plans/oss-m12-account-support.md) records R1's unchanged slice,
verification boundary and unimplemented later phases. It grants no activation,
release or adopter cutover authority.

### Bounded account and support reads

Moved to [Compose account and support services](../../packages/core/docs/guide/how-to/build/account-and-support.md#bind-reads-to-the-customer).

Keep `createM12AccountReadSelection` and `createM12SupportReadBinding` as separate,
explicit-host, default-off reference selections. Native support authorization
precedes scoped PostgreSQL driver entry; scopes close after success, null and
failure. Diagnostic authorization and machine-read governance precede diagnostic
scope entry, with `operatorId` from the trusted actor. Inline order expansion
reads its summary only. A45/A46 token handlers remain in reference source.

Evidence (historical record, 2026-11-13):

No route is mounted; source
route adoption remains pending P7, and no archive, detail/activity panel,
subscription/recovery/contact/link controls or activation is supplied by R2.

Native repair authorization/scheduling is a
[registered follow-up](plans/oss-m12-account-support.md#follow-up-register).
The [default-off recipe](RUNTIME_AND_SELF_HOSTING.md#opt-in-disposable-subscription-reference)
selects no browser route; native start and browser key retention remain
R5 limits.

### Operator recovery selection

Moved to [Compose account and support services](../../packages/core/docs/guide/how-to/build/account-and-support.md#select-operator-recovery).

`createM12OperatorRecoveryBinding` selects package exports only with
`enabled: true` and complete ports. The reference `AccountSupportRecoveryStatus`
displays the partial result/capability refusal; neither file mounts a route.

Keep that lock policy with the SQL owner; see
[migration compatibility](DATA_AND_MIGRATIONS.md#compatibility-lifecycle).

Evidence (historical record, 2026-11-13):

On the qualified runtime, support subscription commands take the term-line row
lock through the shared lock and conflict completion forward, which admits no
actual update.

## Marketing SEO and content slots

Moved to [Compose SEO and content slots](../../packages/core/docs/guide/how-to/build/seo-and-content-slots.md#choose-the-imports).

Evidence (historical record, 2026-11-13):

The cold installed consumer exercises the runtime
entry and compiles its content types.

## Native bundle admin writes

Moved to [Compose native bundle writes](../../packages/core/docs/guide/how-to/build/bundles.md#choose-the-imports).

Reference error paths must re-export the shared `BundleRpcError` and
`DomainRpcError` constructors, preserving instanceof and the existing SQLSTATE
mapper. Keep bundle rules out of transport adapters.

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

The existing conformance runner checks
these declared capabilities using host-owned offline fixtures. Restricted-role
PostgreSQL evidence is separate from offline conformance and installed-tarball
proof. Native list/detail reads still return `host_binding_required`; they wait
for destination and reservation facts in a separate change.

## Native operator shipment commands

Moved to [Compose native fulfillment](../../packages/core/docs/guide/how-to/build/fulfillment.md#bind-operator-commands-and-reads).

## PostgreSQL checkout recovery tokens

Moved to [Recover abandoned checkouts and payments](../../packages/core/docs/guide/how-to/build/checkout-recovery.md#issue-a-recovery-token-for-an-admitted-checkout).

## Checkout recovery waves and expiry

Moved to [Recover abandoned checkouts and payments](../../packages/core/docs/guide/how-to/build/checkout-recovery.md#schedule-reminders-and-expire-abandoned-checkouts).

The [forward](../../db/platform/migrations/20261110100000_checkout_recovery_waves.sql)
retains existing function headers/ACLs. New routines revoke PUBLIC/browser
execution; only the selected entry points grant service-role execution. The
scoped `commerce_checkout_recovery_wave_delivery_authorize` wrapper exposes the
existing owner-authorized automatic reminder check without widening its ACL or
admitting operator/buyer flows. No raw table grant is added.

Evidence (historical record, 2026-11-13):

The [PostgreSQL witness](../../tests/postgres/checkoutRecoveryWaves.test.ts)
exercises legacy and both qualified runtime profiles. It does not establish a
running scheduler, browser journey, network delivery, real-provider prepared
storage or expired-order recreation. The current native payment attempt store
remains sandbox-only. Starter bindings and recreation consumers are separate
obligations.

## Operator order payment links

Moved to [Recover abandoned checkouts and payments](../../packages/core/docs/guide/how-to/build/checkout-recovery.md#give-an-operator-a-payment-link).

Evidence (historical record, 2026-11-13):

The [PostgreSQL witnesses](../../tests/postgres/operatorCheckoutPaymentLink.test.ts)
exercise legacy and both qualified runtimes; the [command characterization](../../packages/platform/test/commerce/operatorCheckoutPaymentLink.test.ts)
retains bounded failures and effect ordering. These sources do not establish
hosted, browser or provider qualification.

## Customer checkout recovery entry points

Moved to [Recover abandoned checkouts and payments](../../packages/core/docs/guide/how-to/build/checkout-recovery.md#add-customer-recovery-entry-points).

Evidence (historical record, 2026-11-13):

The [PostgreSQL witnesses](../../tests/postgres/customerCheckoutLinks.test.ts)
cover legacy and both qualified runtime generations; they establish no hosted,
browser or real-provider qualification.

## Checkout recovery inspection

Moved to [Recover abandoned checkouts and payments](../../packages/core/docs/guide/how-to/build/checkout-recovery.md#inspect-a-link-before-showing-recovery-controls).

The additive schema has nullable recovery-root and immediate-predecessor order
links, restrictive unvalidated self-FKs and a unique non-null predecessor index.
Historical links stay null, with no backfill. The inspection contribution is
read-only; the later recreation routine writes lineage.

Evidence (historical record, 2026-11-13):

See the [PostgreSQL witness](../../tests/postgres/checkoutRecoveryInspection.test.ts)
and [composition characterizations](../../packages/platform/test/commerce/checkoutRecoveryInspection.test.ts).

## Expired checkout recreation

Moved to [Recover abandoned checkouts and payments](../../packages/core/docs/guide/how-to/build/checkout-recovery.md#recreate-a-technically-expired-checkout).

This mechanism adds no route, UI, token issuer, recreation guidance or real-provider
qualification. Those remain separate host composition and payment-owner work.

Evidence (historical record, 2026-11-13):

The [PostgreSQL witnesses](../../tests/postgres/checkoutRecoveryRecreation.test.ts)
cover legacy and both qualified runtimes.

| Profile limit | Current refusal | Closure |
| --- | --- | --- |
| Native real-provider attempt persistence and recovery evidence | `native_prepared_attempt_store_unsupported`; recreation is qualified only for the sandbox owner | N6 portable real-money payment-owner round, with its own SQL admission and provider evidence |

## Atomic checkout payment guidance

Moved to [Recover abandoned checkouts and payments](../../packages/core/docs/guide/how-to/build/checkout-recovery.md#show-payment-recovery-guidance-from-one-snapshot).

Evidence (historical record, 2026-11-13):

Handler-level
PostgreSQL witnesses cover opt-in, legacy responses, read failure, revocation and
an activated checkout without falling back from the atomic read.

See the
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
