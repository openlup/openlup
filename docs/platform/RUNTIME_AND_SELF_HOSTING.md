# Runtime And Self-Hosting

Status: development-preview contract. No recipe in this document is a supported production deployment or a stable installer promise.

## Runtime model

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

The [identity guide](IDENTITY.md#disposable-identity-reference) gives both opt-in
acceptance commands and their prerequisites. They own loopback services and
private captured mail; they do not attach to an adopter database. The identity
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
reconcile call with an empty external-provider allowlist. The reference server
retains its existing startup admission; identity readiness helpers are available
for separate host composition. Existing links continue, and new email association
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
public MCP deployment, or production activation. Public test selection and
second-runtime conformance remain future adoption work and are not supplied by
this preview.

## Provider and host boundaries

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
60..2592000). A direct host must call it before directory, persistence or
notification effects, then pass the parsed number to identity. Invalid values
throw `operator_invitation_ttl_invalid`. The reference invite runner composes
managed immediate activation and does not call this helper or enforce this TTL;
passing the optional setting into the Compose container does not activate the
direct lifecycle. The static profile mounts no operator route. Managed activation
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

## Preview posture

Development-preview source may be evaluated, but it is not a stable release,
an upgrade channel, or a supported self-host commitment. The stable-framework requirements must establish
a versioned release/BOM, a thin adopter application, conformance coverage,
upgrade tooling, public installation/build/test evidence, and compatibility
proof before those claims are available.
