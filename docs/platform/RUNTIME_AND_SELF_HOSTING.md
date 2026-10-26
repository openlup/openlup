# Runtime And Self-Hosting

Status: development-preview contract. No recipe in this document is a supported production deployment or a stable installer promise.

## Runtime model

The accounting HTTP scheduler accepts an explicitly composed invoicing service
and passes it to the existing accounting runtime after HTTP method and bearer
authorization checks. It adds no cron or executor. Runtime enablement and service
readiness still precede the shared durable job lease.

The accounting reversal host delegates outcome handling to the invoicing helper
while retaining its three event adapters, provider selection and exact business
keys. The package helper hardcodes the donor's 10 s timeout. Disabled selection creates no handler. Invalid payloads discard;
persistence failures retry with the existing bounded reason. A processed reversal
may mean local pre-issue void, no invoice or a queued correction; it never proves
remote deletion, money reversal or document delivery. Correction execution needs
an explicit conforming recovery bridge; the old vendor method alone stays
unsupported before claim. No new job registration or default activation follows.

The Postgres local-document adapter now consumes `createPostgresInvoiceStore`
with the caller's structural executor and explicit local provider metadata.
Its request key, local document reference, status and replay remain intact;
this path supplies no fiscal facts and registers no invoicing worker.
For the native store, use separate autocommit sweep, prepare and finish calls.
The [native conformance witnesses](../../tests/postgres/invoicingNativeConformance.test.ts)
cover row/lease fences, scope, locked accounting and unchanged renewal state.
The combined P4 chain also installs the pinned payment-decoupling replacement;
independent collection never joins a payment or parcel transaction.

The reference payment-channel BFF retains its feature and mode admission gates,
and now supplies the package HTTP client to the same domain handler. Its local
simulator branch and disabled empty-channel response remain unchanged. Customer
setup routes continue through the host SDK builder, whose mappings now come
from the vendor subpath; this adds no route or browser exposure.

The [M06 shipping binding](../../server/runtime/public-reference/m06ShippingBinding.ts)
composes selected selection, address and flat-rate ports with host schemas and
authority. Native address writes remain refused. Native flat-rate save requires a
selected native rate port, a Core report in state `ready` and a same-database
`nativeRateSchema` observation of the shipping seed; the managed BFFs retain their flags and
authorization. Construction mounts nothing.

M04 B2 exposes neutral Polish/EN invoice, role, inquiry and opt-out content through
`@openlup/platform/communications/contracts`. Reference invoice locale is an
optional construction choice with Polish default; the existing accounting runtime
still omits it. Explicit EN changes only content and the account-documents URL.
Role preserves existing output and selection. The public opt-out route uses the
selected locale for all seven display outcomes, with escaped brand/support/text
and correct document language; verification, durable suppression, HTTP statuses,
privacy headers and logging remain unchanged. Generic inquiry is a pure
presentation binding, not a new route/sender. Private-label inquiry and adopter
legacy copy/locale exceptions remain owned by their current hosts. See the
[B2 mapping ledger](plans/oss-m04-communications-triggers.md#b2-changed-expectations-and-preservation).

The [A1 reference binding](../../server/runtime/communications/a1ReferenceBinding.ts)
is separately opt-in: call `createA1ReferenceBinding` with `enabled: true` and a
lazy `loadHostInputs`. Without that literal opt-in it returns `undefined` before
loading inputs or runtime modules. The host owns credentials, egress policy,
callback observation/environment selection, marketing verification and shared
account state. Construction performs reference readiness admission; every
exposed effect rechecks that admission before effect work. Install only the
returned guarded ports through the existing transport and reference composition
seams. Select routes, schedules and inert handler descriptors explicitly; their
defaults are empty. Existing default/reference delivery wiring is unchanged.

The bounded delivery callable uses the native direct store with a six-entry
poll-event translation and closes the store on success or failure. It adds no
scheduler, executor, claim loop, subscription capability or recovery send. See
[canonical composition rules](CANONICAL_CONTRACTS.md#explicit-reference-adapter-composition)
for exact translation and refusal semantics. Synthetic offline fixtures and
locally packed consumers establish composition, not provider-account activation
or hosted duration evidence.

The native [communications lifecycle binding](../../server/runtime/communications/communicationsLifecycleBinding.ts)
is an explicit host-callable capability for `node-postgres` with `DATABASE_URL`.
It registers real network references, reconciles injected neutral observations,
dispatches injected membership work, exposes authorized recipient operations and
evaluates durable consent. It closes each capability pool on success or failure.
The full position-70 catalogue and trusted owner-authority connection are
prerequisites; verified human operator identity is additionally required for the
directory. C-compose adds selected native bridges for callbacks, reconciliation,
recipient operations and signed-token preferences. Native membership dispatch
requires an explicitly supplied provider and uses the existing job ledger and
sync worker; a missing provider refuses instead of selecting a silent no-op.
The native watchdog requires a selected readback function and reports unavailable
when that function or storage cannot be used. Managed thresholds and branches
remain unchanged. No default timer or deployment cadence is installed. Consent excludes managed frequency caps and
legacy contact-touching and is not a send-time fence. See the
[package recipe](PLATFORM_PACKAGE_REFERENCE.md#native-communications-operations-development-preview).

The reference BFF mounts `POST /api/bff/admin/identity/privacy/export` and
`POST /api/bff/admin/identity/privacy/erase` in the shipped entrypoint, including
managed bundles with an empty caller route table. Bundle-aware default entries
precede supplied entries and the managed route availability fence. Both handlers recheck live admin membership and require
an explicitly human actor; neither route is machine-write allowlisted. No-store
responses carry versioned coverage/receipt data or a structured `privacyCode`.
Both direct and managed routes retain risk `mutation` and the public default refuses them
with 503 / `adopter_policy_required` before reading request bodies or queries.
Both mounts also refuse before authentication or privacy bindings are created.
Direct and managed adopters reach them only through `#deployment-route-policy`, like every
admin mutation route, including invite, remove and admin `me`. Ordinary admin
routes reach dispatcher preflight exactly once with the original request, response
and route arguments. The two exact default privacy mounts run their preflight
internally after mutation-policy admission. An explicitly admitted identity
candidate dispatches its own policy-wrapped table and bound preflight without
substituting default privacy handlers. After policy admission, managed export
explicitly reports incomplete coverage and erasure refuses with
`MANAGED_PRIVACY_ERASURE_UNAVAILABLE` before any mutation.
Admin Settings adds an identity-only export/erase panel with explicit confirmation,
retained obligations and subject/session-bound in-memory readback. Direct erasure
uses one local transaction and leaves subscriptions unchanged. The existing `prune-challenges`
command now returns separate operator/customer counts and deletes at most 500 per
store whose expiry is strictly older than 24 hours. No scheduler is introduced.

Customer reconcile selects the bundle's identity path. Direct requests read only
the authenticated actor's existing linked contact and return `created:false` and
`linked:false`; an absent link is `ACCOUNT_LINK_CONFLICT`. Managed requests retain
the required email-trust policy, shared settings cache and 403/503 trust refusals.
Direct operator invite/remove route factories use the direct invitation directory
and store behind live human-admin authorization. The invite factory accepts a
notification port; delivery failure retains the invitation. Public policy still
denies before body reads or binding construction. See the
[identity composition contract](IDENTITY.md#responsibility-and-composition).


Managed operator invitation inserts active membership immediately. Authorization
and the public admin `me` source only read native membership; they do not activate
on first entry or compensate writes, and need no service binding for invitation
state. The admin `me` route retains its `mutation` deployment-risk classification:
the public default refuses it with 503 `adopter_policy_required` before handler
execution, even though membership lookup performs no activation. Removal retains
its actor-authenticated revocation RPC. Magic-link
eligibility requires active membership with a known role, with the existing
anonymous envelope, quota and padding. Pending/expiry semantics remain a managed
compatibility gap requiring a transactional store and a later reviewed managed
forward. Direct composition gains pending invitations and trusted human acceptance
with a new canonical SQL forward; direct human login remains unmounted and
machine authentication is unchanged. [Identity lifecycle](IDENTITY.md#operator-invitation-lifecycle)
owns the distinct results, retries and compatibility limits.


The platform separates browser delivery, a server-side application boundary, background work, durable data, and provider adapters. A host may choose how to run those pieces, but it must preserve the platform contracts: authenticated
requests reach the server boundary, durable writes use the canonical data
contract, scheduled work is observable and replay-safe, and provider adapters
remain explicit selections.

Browser-public configuration is build-time input. Sensitive server configuration
is runtime-only input and must not be embedded in a browser artifact. Hosts must
provide their own storage, identity, delivery, and provider configuration where
the selected capabilities require it.

The server health composition and public unsubscribe route read the root
manifest's `#email-presentation` selection and report that presentation's id
(the unsubscribe route uses the `x-email-presentation` response header). The
public selection is the neutral example. A host selecting another presentation
must make its import-map target available to its runtime; source-level
selection alone does not establish function packaging or deployment behavior.

The BFF entrypoints (`api/bff/[...path].ts` and the `api/bff-router.ts` rewrite)
dispatch through the unreleased `@openlup/platform` dispatcher, bound in
`server/runtime/bffDispatch.ts` with this application's settlement bootstrap,
admin preflight, and not-found envelope. Shared cron entrypoints
use the package's `authorizeCron` guard through `api/_cron/authorizeCron.ts`.
The package's Node runtime, scheduler and node host are not yet composed by the
public reference server; the module's composition change does that.

<!-- openlup-doc-impact {"unit":"bff","digest":"sha256-522c966a57eaea1fe0dcd4e7b12852b5ee9bb2bb974f4c0e10d71b547de5150c","reason":"Test-only delta. The admin magic-link route test now pins that null and unknown stored roles get the same padded, non-enumerating accepted response without a send, with quota unchanged. No route, invocation order, setting or runtime composition described here changes."} -->

Identity route files now compose [package handler factories](IDENTITY.md) with
this application's schemas, feature admission, limiter, redirect resolver and
observed request-ID reader. The neutral reconcile-account source has no
personalization hook. A route source does not add it to the default empty BFF
route table or the disposable reference profile's closed route set.

Magic-link route composition now passes configured origins to the identity
module's [shared strict default](IDENTITY.md#magic-link-redirect-policy).
Customer routes select nonblank `APP_BASE_URL`, otherwise
`CUSTOMER_AUTH_REDIRECT_ORIGIN`; admin routes select `APP_BASE_URL`, otherwise
`SITE_URL`. These values must be origins without paths, credentials, query or
fragment. Missing or invalid configuration returns 503
(`UPSTREAM_UNAVAILABLE`, reason `magic_link_origin_not_configured`) before
provider access, including on local and preview runtimes. No request host or
forwarded header supplies a fallback. Valid configured flows retain quota,
padding and non-enumerating responses. This source change activates no route.

The Auth mail endpoint passes the already-admitted maintained transport through
`createAuthEmailTransport` into the package hook. The bridge preserves the
sender/recipient envelope and legacy identifier projection. Signature verification,
content rendering, administrative control, send and persistence keep their
existing order. The endpoint adds no policy fallback or direct-delivery mode.


### Payment repair host bindings

| Surface | Host binding and authority |
| --- | --- |
| Buyer verify | The existing verify BFF supplies stored read/apply ports, provider registry, feature gate and observed responder to the package handler. Stored ownership precedes provider reads; browser outcome/attempt claims are ignored. |
| Buyer status/action | The status BFF retains the stored response schema and continuation credential. It projects the existing action carrier and supplies the existing rail capability mapping. Unknown rails refuse; the package rechecks the canonical attempt after provider readback. |
| Method collection | The setup BFF keeps authentication, token ownership, case lookup, callback and metadata. Its neutral method port exposes only ready transient handoff or unsupported; collection alone never repairs or charges a cycle. |
| Reference repair view | `ReferenceStorePage` mounts `ReferencePaymentRepairPage` after checkout; `PaymentRepairStatus` reuses the injected customer status poller. Exact file/specifier guardrail exemptions admit only the status-only `commerce/paymentStatusClient`, customer `commerce/paymentVerifyClient` and injected `payment/components/PaymentStatusPoller` modules; the broader `commerceClient` stays refused. Redirect handoff links render only for HTTPS URLs. Verify responses never prove payment; only stored paid status does. Native method setup is visibly unsupported without host collection/confirmation. The store is opt-in: a source-import scan proves no module outside its own test imports it, so no shipped default route mounts it. |

Method evidence registration data contains neutral provider references, method
kind and status. The host's `resolveMethodOwner` supplies the client and optional
subscription identity before projection; untrusted adapter ownership fields are
ignored. Without that resolver no reusable registration carrier is produced.
The native schema descriptor still refuses method setup. The direct truth
binding now supplies its host executor to `createPaymentServices`; each runtime
unit closes its scope after either result. `bindM07Payments` refuses unknown or
unavailable selections. The existing bundle composer has one optional payments
binder; it installs no cron or dormant-event handler.

`bindM07PaymentIngress` selects the package verified ingress only when explicitly
requested. No existing provider route is remounted. The reference store accepts
the adapter fingerprint on the first receipt and reads the winning stored receipt
instant on replay. D11 deliberately changes redelivery application and hooks to
reuse that first instant, preventing a later provider timestamp from shifting a
cycle. Missing durable receipt evidence fails closed. Historical rows retain
their evidence; this change adds no backfill or schema migration.

Missing audit bags supply no gateway failure diagnosis or alias activation fact;
recurring saved-method resolution still requires explicit consent. The profile
reader retains its existing default alias presentation, which is not recurring
execution authority. These four reader paths are tested directly even though the
opt-in selector mounts no live route feeding them.


## Self-host boundary

The platform target is portable PostgreSQL with a reproducible baseline and
ordered forward migrations. A managed database service and a self-hosted
database are deployment choices for the same data contract, not two business
implementations. Reference runtime profiles may be useful evaluation evidence;
they do not establish a complete provider matrix or general host certification.

A self-hosted evaluation must make its selected configuration, migration state,
background-work policy, storage boundary, and provider capabilities explicit.
It must fail safely when a required dependency is absent rather than silently
substituting a different business behaviour.

## Opt-in disposable subscription reference

The opt-in [M10 native subscription binding](../../server/runtime/public-reference/m10SubscriptionBinding.ts)
returns schema, readiness, one job descriptor and its guarded executor; it mounts
nothing. Supply a complete catalogue identity and Core readiness observation,
the existing population's durable job lease, native transaction lane, codec and
explicit M07 payment/correlation policy. Renewals, stock recovery and dunning
run under that one lease. A normal-due or stock-recovery row failure returns the
existing error result and leaves later rows runnable in that population run.
Disable the incumbent executor before selecting a
replacement. The default is off, and no current serving route changes. G23
captured cases survive a global alignment-mode rollback to off; disabling this
binding itself still requires the host's reconciliation/handoff procedure.
The [subscription recipe](ARCHITECTURE_AND_EXTENSIONS.md#composed-subscription-module)
owns replay, frozen-mandate and lifecycle-message semantics.

The inert M09 reference binding admits invoicing only when explicitly enabled,
selected and ready. Server startup checks an explicitly supplied invoicing
binding before opening its listener and mounts no invoice routes or schedules.
Explicitly selected module execution checks enablement and readiness before the
host job lease. Unselected accounting execution retains its existing in-lease
skips and failed-run recording; module
factories supply no cron, worker or environment reader. The native D7 removal
and payment-decoupling predecessor keep invoicing outside parcel and money
execution; invoicing cannot delay, stop or roll back those obligations.

The inert [M08 fulfillment binding](../../server/runtime/public-reference/m08FulfillmentBinding.ts)
selects one transaction lane, dispatch store, provider and readiness observer.
Activation is default-off and checked before worker invocation, including the
worker's stale-submission writes. The host supplies an authoritative reader
using the locked transaction and routes every contact, selection or withholding
edit through `editAuthoritative`, with actor and idempotency attribution and
host-owned authorization/replay receipts. The writer locks the native dispatch
identity and shipment, then synchronizes only revision, provider and withholding.
Disabled, capability-selection/readiness and unsupported-dispatch refusals take
precedence over the shared typed native refusal for missing preparation;
all precede worker invocation. Source edits
and context updates commit together; an error rolls both back. Credentials remain
host closures. Construction adds no route, schedule or automatic dispatch, and
the public reference server does not select this binding by default. Renewal
admission uses the [host store decorator](../../server/runtime/subscription/deliveryAlignmentRenewalStore.ts)
around the automatic runner's existing hook. A host that composes the native
automatic-renewal runner must wrap its store port with this decorator; until it
does, native delivery-alignment mode stays off or shadow. This boundary stops at
the decorator and supplies no runner composer, factory or production entrypoint.
Construction installs no route or schedule. It preserves the
static terms gate, skips admission for off with no non-terminal captured case,
and processes captured cases through native admission even after rollback to off.
Prepared attempts, existing cycles and dunning retries bypass new-cycle admission.
Native admission denials carry a typed deferral: the runner and batch report
`deferred`, leaving the operation claimed without a terminal refusal write. The
same schedule is offered again only after lease expiry, including after protect
release, manual-review resolution or auto alignment without an extension. Static
terms refusals retain their terminal behavior. The hook uses the runner’s
`occurredAt`; direct callers may omit it and use the decorator’s clock. Previously
refused operations and reservation-expiry recovery are unchanged. Enforcing
new-cycle inserts require the successful exact-schedule admission and consume
its receipt once.
Host status-map, normalized-fact and current-parcel facades delegate to
`@openlup/core/fulfillment` with their existing names; the status facade retains
private provider trace metadata. Account order UI imports core progress helpers
and types. The subscription browser inventory declares only the parsed core
fulfillment modules. The default and subscription client and SSR graphs, identity
clients for both auth providers, and installed core browser consumer exclude
platform fulfillment modules, the preparation binding and the account order screens.

The inert [payments binding](../../server/runtime/public-reference/m07PaymentBinding.ts)
selects injected truth services or verified ingress only by explicit host choice.
Unknown selections refuse and omission stays cold. No existing provider route or
schedule is installed. Selected ingress retains its adapter fingerprint and first
stored receipt clock on replay (D11); missing durable clock evidence refuses.
The direct truth host separately opens one database scope per runtime unit and
closes it after success or failure through the package binding.

The inert [shipping binding](../../server/runtime/public-reference/m06ShippingBinding.ts)
requires selected ports and host authority. Native address writes remain refused.
Native flat-rate save requires a selected native rate port, a Core report in
state `ready` and a same-database `nativeRateSchema` observation. Construct the
reference binding to obtain its merged contribution requirements and call
`observeNativeRateSchema()` at host readiness. This uses Core's schema probe to
check the position-72 `20261021200000_shipping_flat_rate_seed` ledger entry
and settings objects, regardless of later forwards. Evaluate Core readiness
with the caller's schema requirements, then reconstruct with that report and observation in `store`; close both bindings.
Caller-declared schema objects/version are retained, with seed objects added
once. A candidate label or unrelated report alone cannot enable saves.
Selection, validation and flat-rate fixtures do not certify a managed host.

The inert [M06 inventory binding](../../server/runtime/public-reference/m06InventoryBinding.ts)
selects one store and the reference provider validator. A host-injected normalized
stock reader feeds catalog bundle availability; native new-purchase reads remain
unsupported and are deferred to the native-backend parity round (owner 2026-10-21). Importing
the binding mounts no route, schedule or provider. Admin composition retains its
authorization and mutation flag; native adjustment remains refused.
The stock binding passes `createInventoryBindings(...).newPurchaseStockReadPort`
to M06's availability projection and binds the pure status ladder from browser
commerce. Physical-table fallback is still an explicit host choice, using the
single commerce/server projection; it cannot allocate or consume reservations.
The separate native SQL stock reader is not selected by this composition, and
private preview transport remains outside this move.

The separate M05 reference factories
[`m05CatalogBinding.ts`](../../server/runtime/public-reference/m05CatalogBinding.ts)
and [`m05CatalogSchema.ts`](../../server/runtime/public-reference/m05CatalogSchema.ts)
are explicit and inert. A host supplies its executor, verified identity binding,
registry, quote/offer/promotion callbacks, stock port and complete catalogue
identity. The factory selects the existing native envelope/draft, price-authority
and bundle stores, supplies the existing handler factories and closes its owned
bundle-write resources. Injected executor and identity lifetimes remain the host's.
The finite schema requirement includes selected relations, columns and exact
routine overloads; readiness still requires independently observed inventory,
database and complete migration identity. Schema presence proves neither SQL
semantics nor permission grants.

All read, mutation and activation flags default to disabled. Returning a handler
table does not register it: the shipped BFF caller table, browser pages, site
manifest, prerender and subscription profile remain unchanged. Publication reads,
publish, lifecycle writes and native acquisition acceptance remain unsupported.
The consumer proof uses the existing quote/offer and authorized draft readback
surfaces. The mounted admin/feed readback proof feeds the merged availability
builder (`createNewPurchaseStockAvailabilityPort`) from an injected port-boundary
stock reader double, so it proves the mounted readback, not native stock; the
native stock read is deferred to the native-backend parity round
(owner 2026-10-21), second after M05 bundle-1. No acceptance token, publication receipt
or real stock claim is made.


The communications browser profile is separately opt-in with
`OPENLUP_REFERENCE_PROFILE=communications`. Build it with the existing
`build:public-reference` entrypoint and relative, disposable output directories.
Its closed import inventory is `config/public-reference-communications-imports.json`;
the ordinary static profile does not include the panel. The selected page is
`/admin/communications`, with an in-memory admin-session input and authenticated
native evidence requests. No credential is stored in browser persistence.

A host constructs `createReferenceCommunications` with its actual routes, ports,
handlers and supplied schedules, then awaits `admitReferenceCommunications` using
an independently observed installed package inventory and complete schema-ledger
identity. `communicationsReferenceMount` accepts only an admitted candidate and
loopback origin; `startPublicReferenceServer` checks it before listening or binding
clocks. It refuses separately admitted identity/outbox candidates: their actual
contributions must be part of the one aggregate admission instead. Candidate
identity is rechecked on HTTP and schedule entry. Ordinary public deployment
policy, the default build, static routes and empty cron configuration stay inert.
No host cadence or live provider operation is authorized by building this profile.


An explicitly supplied identity candidate builds its handlers from typed ports
and snapshots its environment. Startup checks that environment against the host
and ambient process, then admits and dispatches the same policy-wrapped route
table, including supplied privacy handlers. Admin preflight uses the candidate's
operator authorization binding. This candidate seam adds no default or
subscription-profile routes. See [identity composition](IDENTITY.md#responsibility-and-composition).

The shared server also accepts an explicitly supplied identity candidate through
`startPublicReferenceServer({ identity })`. It awaits selected module, schema,
route, adapter and email-trust readiness before creating a listener. Supply a
trusted schema/migration observer and refresh candidate identity when artifacts,
configuration or schema change. Unknown observations refuse admission. This seam
does not select an identity browser profile or alter the default static or
subscription page sets. The legacy outbox placeholder cannot be combined with
identity module selection. Identity HTTP dispatch checks the selected deployment
policy before buffering input; the disposable policy remains an application
alias binding.



The separate identity selection uses `OPENLUP_REFERENCE_PROFILE=identity`, its
own closed browser imports and the existing customer/operator pages. The
server accepts an explicit composed identity runtime and awaits admission
before listening; absence or refusal prevents a listener. Its finite API
surface excludes checkout, provider and subscription mutation routes. Local
policy runs only under verified run/container/installation ownership, before
request-body adaptation. Inside that scope, the host dispatches the admitted
route table with its operator preflight; it does not rebuild or replace handlers.
The disposable bundle supplies package observations from its build module graph,
while startup still checks the selected bundle, schema and complete environment.
The default public route policy is unchanged.

The reference HTTP shell refuses percent encoding in the pathname and malformed
query encoding, validating query escapes once without rewriting or double-decoding them. In particular,
`/account/auth/callback?returnTo=%2Faccount` serves the identity document;
encoded path separators and traversal paths still return 404. Callback fragments
remain in the browser and are consumed by the selected authentication adapter.

The [identity guide](IDENTITY.md#disposable-identity-reference) gives both opt-in
acceptance commands and their prerequisites. They own disposable services and
captured mail; they do not attach to an adopter database. The direct database
and reference HTTP server bind to loopback; the managed Supabase stack publishes
its synthetic services, including the mail-capture API, on all host interfaces
for the run and requires a host not reachable from untrusted networks. The identity
runtime must provide schema, route, binding and email-trust admission; this
shell alone supplies no readiness claim. No runnable identity container image
or stable installation channel is established by this selection.


The subscription reference mounts English and Polish customer login, callback
and account routes through one customer auth provider and query client. Account
entry requires a linked own-profile read. Only GET `/api/bff/customers/me` is
added, using the identity handler with a bearer-bound customer client. Its CSP
adds exactly the validated local auth origin to `connect-src`; static reference
composition is unchanged. See [browser identity](IDENTITY_BROWSER_REFERENCE.md)
for routes, code fallback, persistence reset and logout behaviour.

The subscription profile supplies a managed email-trust policy to its existing
reconcile call with an empty external-provider allowlist. Without an explicitly
supplied identity candidate, the reference server retains its existing startup
admission; supplying one adds identity and email-trust readiness checks before
listening. Existing links continue, and new email association
fails closed after cache expiry. The profile retains its existing generic
`FORBIDDEN` (403) response for reconciliation refusals. Its stricter disposable
installation guard still runs first on routes and can return a generic 503
before reconciliation. The [local envelope conformance runner](IDENTITY.md#conformance-and-outstanding-evidence)
exercises package mappings separately without weakening that guard.


The default public reference remains a static, read-only site. An evaluator may
explicitly select a separate local Node + managed Supabase subscription profile
to exercise one synthetic recurring purchase, captured payment settlement,
confirmed local sign-in, own account readback and a renewal-date action. The
profile uses a closed route set and loopback origin; it does not start a worker,
external payment provider, external mail service or full self-hosted platform.
The adjacent [action-guard test](../../server/runtime/public-reference/subscriptionSelfServiceGuardrails.test.ts)
is collected by root Vitest. Its five cases check that shipping-address changes,
gifting, resume, cancellation and a missing action return 400 before creating a
customer client; this is handler refusal proof, not a live subscription journey.
See [Evaluate a subscription account](SUBSCRIPTION_REFERENCE.md) for the exact
setup, server command, operator setup and verification boundary.

The profile build must inherit `OPENLUP_REFERENCE_PROFILE=subscription` from the
owned environment. Invoke npm's CLI through Node with `--env-file`, as shown in
the evaluation instructions; Node's `--run` does not load that file for its
script. The resulting HTML carries `data-openlup-profile="subscription"`, which
the subscription server requires before serving browser routes. Build tests
pin both the subscription marker/entrypoint and the default static document.

The profile build resolves `@openlup/core` and `@openlup/platform` through its built package exports.
Its closed browser import list admits the corresponding `packages/core/dist`
modules; a missing core build or an undeclared first-party import refuses the
build. The setup command builds core before the profile, and the local Node
commands use the same default package resolution.

The setup requires a new owned directory, unique project id and free ports. It
replays the managed baseline with its two explicit local prerequisites and
seeds synthetic catalog, price, inventory, settlement settings and the
delivery-alignment control row. A
versioned local marker binds the generated configuration and baseline hash to
one opaque installation id stored in the live database. An interrupted setup
cannot resume on a replacement container before sealing; a sealed setup may
survive container recreation only when the durable database id matches. Before
selected-profile API operations, the server rechecks that live id and Auth's
email-confirmation setting. Keep the generated environment server-only and
preserve the database volume when restarting the Node process.

This is bounded development-preview evidence, not a production composition,
supported install, managed-host certification, or substitute for a complete
HTTP/browser acceptance run. The separate portable PostgreSQL migration lane
has not been installed or certified by this profile.

<!-- openlup-doc-impact {"unit":"reference","digest":"sha256-aca245296bae41d05957e53bf0bfa1a5e2977fd089ba1598927e515666e21eed","reason":"Import-only delta. The opt-in subscription reference account binding imports its account-link store factory from @openlup/platform/identity instead of a removed re-export file. Reconciliation, admission and the disposable runtime are unchanged."} -->

The Node reference start function accepts an admitted outbox candidate and a host schedule binding. For a selected rail it binds dispatch/prune before opening the listener; a refused candidate or absent schedule binding opens no listener. Host composition supplies its driver, lease, effect handlers, known vocabulary and migration observation. Immediate and scheduled work share the packed rail engine, with candidate identity checked at every entrance. The default static CLI selects no outbox adapter and provides no deployed outbox proof.

## Customer diagnostic history preview

Customer diagnostic history is a development-preview, default-off platform
module. It records a closed vocabulary of browser-observed transactional,
sign-in, and account actions. The browser payload accepts no free-form metadata
or raw form values. After successful authentication, the server may attach
canonical principal and customer subject identifiers; anonymous observations
remain anonymous.

Evaluation requires all of the following configuration:

| Setting | Boundary |
|---|---|
| `VITE_COMMERCE_CUSTOMER_DIAGNOSTIC_HISTORY_ENABLED=true` | Build-time browser opt-in. The default is `false`. |
| `COMMERCE_CUSTOMER_DIAGNOSTIC_HISTORY_ENABLED=true` | Server ingest opt-in. The default is `false`. |
| `CUSTOMER_DIAGNOSTIC_RETENTION_DAYS` | Required integer from 1 to 90 whenever server ingest is enabled. |
| `CUSTOMER_DIAGNOSTIC_INGRESS_KEY` | Runtime-only HMAC key of at least 32 characters. It must never enter a browser artifact. |
| `APP_BASE_URL` | Exact HTTP(S) origin accepted by the ingest boundary; paths, credentials, queries, and fragments are refused. |

The selected runtime must also configure its data lane. Portable PostgreSQL
uses `DATABASE_URL`; a managed data adapter uses its own server-only
configuration. Missing retention, ingress key, origin, or data configuration
fails ingest closed. Retained ingest is additionally refused closed unless
**both** retention locks below are open — the drain flag and the drain's control
row: an enabled collection without a proven drain is a configuration error on
every runtime, and the ingest boundary enforces that rather than documenting it.

The browser keeps the opaque segment credential in `sessionStorage`, with an
in-memory fallback, so correlation is limited to the current tab. Delivery is
best-effort: a timeout can follow a committed write and must remain an unknown
outcome rather than be retried as if persistence were absent. Version 1 and
version 2 coverage can coexist in one retained history.

Operator reads require an active platform operator and create an access-audit
event. The additive global diagnostic overview is available only with the explicit
`customer-diagnostic-history.v2` read contract. It is bounded to seven days,
groups retained observations by coverage version and action, and returns only
closed classifications plus up to three opaque segment IDs per bucket. It does
not turn browser observations into business truth or provide a customer-level
analytics interface. The support read route is separately default-off through
`COMMERCE_AGENT_CUSTOMER_READ_ENABLED`; enabling ingest does not grant read
access. These controls do not replace the host's retention, database access,
or incident-response policy.

### Retention drain

Retention is executed by a default-off job, not by a read-side filter. The job
`customer-diagnostic-prune` deletes expired events, expired access-audit rows,
aged admission buckets and orphaned segments in bounded batches, under the
platform job lease, and records each attempt in the job-run ledger.

| Setting | Boundary |
|---|---|
| `COMMERCE_CUSTOMER_DIAGNOSTIC_PRUNE_ENABLED=true` | Server opt-in for physical deletion. The default is `false`. Deliberately independent of the ingest flag, so a host can drain what it already stored while collection is off. |
| `platform_job_controls.enabled` for `customer-diagnostic-prune` | The second, separate lock. Both paired migrations seed the row disabled; an absent row would mint its own permission on first claim, which for a deletion job is the difference between a wired rail and an armed one. |
| `CUSTOMER_DIAGNOSTIC_RETENTION_DAYS` | The same 1–90 value the ingest uses. Expiry is stamped on each row at ingest, so changing it ages future rows only. |

**No hosted scheduler is required, and none is used.** The route
`/api/cron/customer-diagnostic-prune` is registered in the platform runtime
configuration but carries `hostedCron: false`, so it is absent from the hosted
provider's generated cron list and no database-side schedule exists. A host
points whatever clock it has at the route. Two lanes ship:

- **portable Node.** The in-process scheduler registers a direct handler for the
  job **only** on bundles whose `data` capability is `postgres`, so there no HTTP
  hop and no hosted scheduler is involved. On a Node bundle with any other data
  capability no direct handler registers and the same timer reaches the route
  over the HTTP compatibility bridge, which sends no identifying header — those
  runs are recorded as `unattributed_post` in the job-run ledger. The recorded
  invocation source is evidence of how the request arrived, never proof of which
  clock fired.
  ⚠️ **Advisory-lock caveat.** The Node scheduler's cluster lock is a Postgres
  advisory lock that is only created when `DATABASE_URL` is set; without it the
  scheduler falls back to a lock that always acquires, so **every instance
  fires**. On a multi-instance Node host the job's own `platform_job_controls`
  lease — not the scheduler lock — is what prevents a double run. The lease is
  sufficient; the point is that the scheduler lock is not what you are relying
  on.
- **external poke.** Any external timer may `POST` the route with the shared cron
  secret. A caller that ticks more often than the retention cadence should send
  the backstop header (`CUSTOMER_DIAGNOSTIC_PRUNE_BACKSTOP_HEADER` in the prune runtime) set to `freshness`, which makes the route answer
  `primary_fresh` without claiming when the last success is inside the freshness
  window. An external caller that does not identify itself still runs the drain;
  it is simply recorded as `unattributed_post` rather than as a named source.
  Identification is attribution, never authority.

On the portable lane the claim, each batch and the finish run as separate
transactions rather than one long-held one. The control-row lease, not a
transaction, is what excludes a second runner; a crash mid-drain leaves the
already-committed batches deleted and the remainder to the next run, which is
safe because deletion is idempotent.

This remains a portable, default-off preview: the paired PostgreSQL migrations
describe the data contract, but do not provide an installer, host certification,
public MCP deployment, or production activation. Root discovery includes the
[prune runtime](../../server/runtime/observability/customerDiagnosticPruneRuntime.test.ts)
and [job](../../server/domains/observability/customerDiagnosticPruneJob.test.ts)
falsifiers; follow [testing](../../CONTRIBUTING.md#test-scope-and-diagnostics) for
execution. Second-runtime and deployed conformance remain separate adoption proof.

## Provider and host boundaries

[ReferenceFulfillmentPage](../../src/pages/ReferenceFulfillmentPage.tsx) is an
opt-in operator read example with no default runtime importer or route. Mounting
requires a host-owned operator session and order identity; the existing detail
endpoint remains responsible for authorization. The page reads only on explicit
interaction and reports unavailable reads without claiming delivery. Its neutral
client projects status and tracking text only; it exposes no address, raw operation
payload, signed-label link or mutation. Commerce list/detail and overview require
host read callbacks; [native parity boundaries](ARCHITECTURE_AND_EXTENSIONS.md#native-parity-boundaries)
describe their shared typed refusal.

Reference payment composition now calls the experimental vendor-subpath
execution, reconciliation, HTTP, mapping and evidence helpers documented in the
[package reference-support surface](../../packages/platform/README.md#reference-support-surface).
Checkout, renewal, recovery/setup, channels, accounting payout SDK calls and
activation keep their host wiring and flags. The bank/code binding translates `petId` to the
package subject input and translates the outgoing account path/query and
simulator return path back at its injected transaction client. The fallback
payer label remains host-owned. Package no-charge errors reach prepared-attempt
retry/release as the same class; arbitrary transport failures stay ambiguous.
Default-off construction does no SDK/fetch/certificate work. This rebinding
adds no route, schedule, activation or environment setting.

Unused root payment webhook verifiers, notification normalization and test-only
draft mappers have retired after production-importer checks. The shared HTTP
helpers and unrelated mapper/readiness tests remain. Opt-in package payment
adapters retain their implementations and witnesses; no host composition or
provider activation changes. The [retirement ledger](plans/oss-a2-payment-adapters.md#o-p3b-1-unused-root-retirement-2026-10-22)
records the exact root cases and remaining adopter leg.



Communications server algorithms now delegate through the platform package. The
reference bindings still own the maintained HTTP mail provider egress/environment selection, origin defaults,
shared notification-control policy and the Auth renderer/observers. The existing
receipt transaction lane is passed through unchanged. This relocation adds no
provider SDK, deployment setting, route, scheduler or second outbox executor;
managed receipt service-scope and fixture construction remain in the reference
adapter.

`createOidcComposition` is an explicit direct-bundle option, supplied with the
existing environment reader's `IDENTITY_OIDC_ISSUER`, customer audience and
distinct operator audience. Retain its verifiers for the host lifetime and
register their readiness with identity admission. Invalid discovery/keys prevent
readiness; unavailable transport reports unknown. The host injects its installed
JWT library lazily. Managed bundles require native federation sessions. The
[OIDC recipe](IDENTITY.md#real-issuer-oidc-recipe) owns the disposable pinned
issuer, loopback-only ports, prerequisite refusal and cleanup contract; it is
outside default CI and changes no default browser or passwordless login flow.

For direct human operators set `OPERATOR_IDENTITY_AUDIENCE` distinct from
`CUSTOMER_IDENTITY_AUDIENCE`, with the existing customer identity issuer/key/JWKS
settings. In an application that mounts the supplied admin shell, select
`VITE_OPERATOR_AUTH_PROVIDER_KIND=direct` and pass that value to `AuthProvider`
as `providerKind`; absence
keeps managed auth and unknown selections refuse. Apply the complete catalogue
through the operator-challenges forward before enabling login. The explicit
`server/runtime/auth/operatorIdentityCommand.ts` commands bootstrap the first
administrator invitation and prune at most 500 old challenges. Neither runs at
startup. The bootstrap invitation expires after seven days; rerunning bootstrap
still refuses once any invitation exists. An active human administrator can
reissue an expired invitation. Without one, recovery requires the database
owner's audited deployment procedure; no bootstrap-reset command is supplied.
Preserve identity and audit history; see
[bootstrap recovery](IDENTITY.md#first-administrator-bootstrap).
Operator delivery defaults to discard; compose a separate delivery port
and use only the strict configured application origin for callback links.
The [identity guide](IDENTITY.md#direct-human-login) documents commands, tab-session
limits and required database acceptance. Existing machine credentials remain
separate and human login needs none. The bounded public-reference builds do not
mount the admin shell or provide a direct operator browser journey.

`readOperatorInvitationTtl` is an available direct-host composition helper for
`OPERATOR_INVITATION_TTL_SECONDS` (default 604800, inclusive integer bounds
60..2592000). A direct host must call it or the pure `parseOperatorInvitationTtl`
before directory, persistence or
notification effects, then pass the parsed number to identity. Invalid values
throw `operator_invitation_ttl_invalid`. The reference invite runner selects the
direct lifecycle for `node-postgres` and calls `parseOperatorInvitationTtl` before
constructing authentication, directory or store bindings. Managed bundles retain
immediate activation without enforcing this direct-only TTL.
The static profile mounts no operator route. Managed activation
requires the existing service-role configuration in addition to session
authentication. Failed persistence retains the provider identity and customer
link for reuse. Managed invitations store native active membership; no Auth
metadata grants access.


Provider SDKs, sensitive material, signatures, and wire formats remain behind
adapters. The platform stores canonical outcomes and may preserve sanitized
provider evidence, but a provider response is not itself the platform's durable
truth. Hosts can add adapters only through the contracts in
[Architecture and extensions](ARCHITECTURE_AND_EXTENSIONS.md) and
[Canonical contracts](CANONICAL_CONTRACTS.md).

The transactional commerce and fulfillment renderers use the root
`#email-presentation` import as their default while retaining an explicit
presentation argument for callers. A host that changes the selection must
verify its server module resolution and rendered output. The public source
does not declare a managed serverless packaging rule for this alias.

<!-- openlup-doc-impact {"unit":"infrastructure","digest":"sha256-2b0421c680adfaa93b6ea03f7da109126065fa9b89a550ca027f21bf63b3157a","reason":"Transactional renderer tests now exercise neutral default presentation plus explicit synthetic presentation/content inputs, retaining rendered transport outcomes and refusal assertions. No renderer, provider, host or import-map implementation changes."} -->

Canonical production hostnames come from
`config/site-routes.json.productionHosts`. Configure this list for an adopting
deployment before enabling live Tpay settlement: every callback must use HTTPS
and an exact listed host, without redirects. The watchdog uses the same list to
detect preview emails linking to production. An empty list admits no live Tpay
callback and gives the email check no production domains to recognize. See the
[pending preview upgrade notes](../../.github/VERSIONING_AND_EOL.md#pending-preview-upgrade-notes-public-coordinates)
for the accompanying `OPENLUP_` configuration rename.

Mail injection requires package-owned admission. New network adapters compose
`createGuardedEmailTransport` with a fresh explicit host policy and consume the
admitted recipient, credential and environment tag. Unknown/malformed decisions
refuse before sender entry. The maintained client already enforces its reference
sink/drop policy; its factory registers that implementation explicitly without
rerouting or changing wire/key semantics. Provider tags and arbitrary capture
claims grant no admission. The [transport contract](../../server/infra/email/README.md#contract)
explains the host trust boundary and local capture semantics.

## Preview posture

Development-preview source may be evaluated, but it is not a stable release,
an upgrade channel, or a supported self-host commitment. The stable-framework requirements must establish
a versioned release/BOM, a thin adopter application, conformance coverage,
upgrade tooling, public installation/build/test evidence, and compatibility
proof before those claims are available.

## Communications host bindings

The communications import changes implementation ownership, not installed runtime
selection. Reference Auth email binds the same renderer and environment observers;
The unchanged reference mail transport binds the same egress policy, origin defaults and shared delivery
controls. Existing schedules, BFF routes, cron admission, provider activation and
SQL installation remain host-owned and unchanged. Package contribution metadata
requires the host-selected schema and advertises only supplied handlers, schedules,
routes and required ports. No deployment configuration or second outbox executor
is introduced.

Concrete mail clients, callback verification/mapping, polling reads and send-ledger
adapters remain reference-owned; the package exports no mail-vendor factory.
The existing callback handler and polling worker now delegate admitted-observation
and bounded-scan sequencing to neutral package engines. The same routes construct
the same persistence ports: callbacks and poll reads still converge through one
atomic database RPC. Telemetry failure stays best effort; authoritative callback
failures remain retryable and polling retains its failure counters and fairness.
No runtime registration, SQL installation or subscription timing change follows
from this extraction.
