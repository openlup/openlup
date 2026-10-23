# Platform package reference

Status: development-preview reference. These recipes retain the package's
experimental boundaries and establish no stable install or release claim.
Audience and purpose: adopters composing the identity and communications modules
from `@openlup/platform`.

This page holds the longer module recipes kept out of the packed README so the
package's documentation stays under its packed size cap. The
[package README](../../packages/platform/README.md) remains the package entry point.

## Identity import candidate

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
[identity owner page](IDENTITY.md). Both entries remain an
unpublished development-preview import candidate.

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

`COMMUNICATIONS_MIGRATIONS` projects three existing canonical units byte for byte:
comms outbox (position 2), transactional receipts (9) and communications control
plane (20). This sparse list is not a standalone migration chain. Apply the full
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
70; it remains a sparse inventory, not an installer. Missing schema/configuration
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

The experimental `@openlup/platform/invoicing` entry interprets explicit host
selection through `readInvoiceCapabilities`. Disabled activation and missing or
mismatched provider selection refuse before any host call. A ready descriptor
reports declared operations; it is not proof of fiscal readiness or host parity.
`@openlup/platform/invoicing/contracts` exports declarations only, with no browser
runtime values or server import edge. There is no new npm package or dependency.

Eleven compatibility helpers serve host facades: `runInvoiceIssueJob` takes managed
claim/preflight/provider/finalizer callbacks; `mapInvoiceClaimToProviderSnapshot`
and `mapCanonicalIssueLines` take saved facts and host labels/tax defaults;
`allocateChargedGrossTotals` and `allocateDiscountedGrossTotals` take gross totals;
`readInvoicePaymentEvidence` takes payment identity and a selected provider;
`createFulfillmentHandoffInvoiceHandler` takes the host descriptor, parser, policy,
request and error callbacks; `withAccountingInvoiceShadowTrigger` and
`withAutoDispatchAccountingInvoiceTrigger` take fulfillment/accounting ports,
provider selection, exact key functions and optional resolved channel policy.
`runInvoiceCorrectionJob` takes create/provider enable flags, claim, projection,
recovery-bridge create and fenced finish/fail callbacks, plus the claim-fence
predicate. `createInvoiceReversalHandlers` takes the enable flag, per-event
adapters and the reversal writer; it retains the donor's 10 s timeout.

The host supplies frozen order/buyer/line/tax/money facts, seller and jurisdiction
routing. Facts retain revision, ordered canonical line amounts, explicit
delivery/discount components, dates and references. `InvoiceIdentity` retains
original request keys. Amounts are
safe integer currency minor units; no FX, catalogue reread or zero-tax substitute
is supplied. Legacy line kinds and order-money headers can remain explicitly null;
the host cannot invent missing facts. The provider owns fiscal numbering; local references and nullable
external numbers remain distinct. Identifier, tax and rounding policy references
and the host fiscal verification seam carry policy, rather than country rules.

Issue and full-reversal correction use stable identities and immutable BEFORE
facts; full reversal has explicit zero AFTER totals. A bridge must prove the
parent and correction reference on recovery. Unknown remote outcome stays unknown;
only a complete exact lookup of the full scope can establish absence. A failed,
ambiguous or unsupported lookup cannot authorize another create. Local pre-issue
void is separate from unsupported remote void. Each store call is a local
transaction; remote I/O never belongs inside it. A late accepted issue retains
its external identity and atomically creates one compensation duty at finalization.

Every missing host binding returns typed `unsupported` before unsupported writes.
A recorded reversal that native SQL cannot fulfill returns `unsupported_recorded`.
Reversal `missing` means no M09 duty, never invoice absence: retain/retry the
intent and route legacy documents to the incumbent path. Local-only requests
retain provider selection, document ID, invoice reference, status and replay.
The required seams are facts, seller, fiscal policy, read-only M07 money,
artifacts/storage, registry, clearance observation, M04 delivery, payout item
recording/resolution, policy decisions and M12 account history. Registry evidence
retains identifier scheme, legal name, optional registration/address/tax evidence,
source, fingerprint and observation time; host validation/freshness/fallback do not
replace checkout truth or require a lookup for renewal.

Policy suppression enumerates `channel_issues` and `no_document`; an explicit
operator skip retains actor, reason and key. The executor decides policy before
installing facts, so suppressed orders get no local document. Readback consumers
merge host-recorded receipts (including recordedAt) with owed duties. Neither
receipt fabricates an invoice ID.
The owed-duty readback matches `invoicing_duty_readback`: order, capture faults,
duty/parent/document identity, state, attempts, closed diagnostic code and lease
chronology. Ready maps to owed and processing to claimed; unsupported obligations
remain visible. Empty duties and payment truth's `accountingRequested=false` do
not establish invoice absence. Capture faults remain separately observable.

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
P4's structural store leaves delivery unsupported until the host envelope is bound.
For uncertain sends, native passes
`p_receipt` NULL and retains a non-null receipt hint in `p_evidence`; managed
passes the hint as the provider message ID.
Provider acceptance does not prove inbox delivery. Uncertain send never authorizes
blind repeat send. Clearance is observation only, with
`not_submitted`, `pending`, `rejected`, `accepted`, `not_required` and `unsupported`
kept distinct; no submission or country-specific mapping is installed.

Payout evidence preserves distinct item references even for the same batch and
payment. Native uniqueness cannot silently merge them or replace nullable links;
a conforming host recorder/resolver is required. Account history preserves the
owner, order, parent lineage, signed correction totals and currency in a safe
projection, without buyer payloads, raw diagnostics or signed URLs. A found history
is the complete owned projection; incomplete reads return unknown. The host owns
customer authentication, operator authorization, retention and original key bytes.

Inspect the [contract](../../packages/platform/test/invoicing/contracts.test.ts)
and [carrier fit](../../packages/platform/test/invoicing/portFit.test.ts) witnesses.
These declarations install no worker, native store, SQL, provider, scheduler or
subscription writer. Physical delivery and renewal money never depend on invoice
availability; the later durable-duty executor must preserve that independence.

`createNativeUnsupportedInvoicePorts()` returns `{ host, store, provider }` with
all operations refusing `host_binding_required`, `retryable=false` and no possible
effect in the current call. It takes no executor or configuration and inspects no
input. The refusal cannot prove absence or settle an existing unknown outcome;
its owning duty must stay visible for a selected host adapter or operator.

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
