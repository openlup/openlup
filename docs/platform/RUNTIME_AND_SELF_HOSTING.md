# Runtime And Self-Hosting

Status: maintainer page: how to change OpenLup. Reader guidance lives in the [OpenLup guide](../../packages/core/docs/guide/README.md); sections marked "Evidence" are frozen historical records.

## PostgreSQL connection recipe

Moved to [Connect to PostgreSQL](../../packages/core/docs/guide/how-to/operate/connect-postgresql.md#assign-connections-by-work).

Evidence (historical record, 2026-11-13):

The [qualified composition witness](../../tests/postgres/m14QualifiedComposition.test.ts)
uses the real complete selected installation, pooled request work and restricted
runtime lock sessions. Its deterministic backend-switch/reset cases use real
PostgreSQL sessions, not a PgBouncer deployment; they prove observed-violation
refusal before the job body. This is local PG16 evidence, not hosted Neon/RDS
qualification. The separate [restricted-bootstrap witness](../../tests/postgres/m14QualifiedAdminComposition.test.ts)
uses the same consumer seams with both fixed role modes and a non-superuser
trusted migration administrator. Its local session-switch refusal is not a
PgBouncer deployment or hosted endpoint qualification.

## Recipe conformance runner

The source-only preview runner composes the existing restricted installation,
connection and released-schema witnesses:

```sh
node tests/postgres/runM14RecipeConformance.mjs --target self-host --credentials /external/recipe.json --receipt /external/new-receipt.json
```

Build the workspace packages first with `npm run pretest`. The runner requires
Node 24, npm 11.19.0 and an absolute credential-file path outside Git checkouts,
owned by the invoking user with mode 600. It never prints credentials, that path
or raw child output. Receipt destinations must be new files. The credential
JSON has `schemaVersion: 1`, `target: "self-host"`, `region: "local"`,
`disposable: true`, `localNodeImage` naming an already cached immutable image ID
(`sha256:<64 lowercase hex>`) with Node 24.21.0, and `previousApplicationPath` pointing to the installed
`@openlup/platform@0.23.0` `dist/payments/index.js` entry. Its `installations`
object has exactly `installer-managed`, `operator-provisioned` and `schema`.
Each contains `disposable: true`, the expected PostgreSQL `systemIdentifier`,
`connectionString`, PEM `ca` and an operator-declared `ociDigest` in
`sha256:<64 lowercase hex>` form. The runner records the declaration but cannot
independently inspect an external host's image. Keep the entire file external;
never put real values in an issue, receipt or source file.

The local self-host target also needs Docker Compose, installed Playwright
Chromium, the cached pinned Keycloak image from the [identity recipe](IDENTITY.md#real-issuer-oidc-recipe)
and the cached Versity image pinned in `docker-compose.yml`. The witnesses do
not pull images. The Node/OCI fixture builds two local application images from
the declared cached Node image and removes those owned images after its run.
It uses a temporary restricted runtime login and generated scheduler secret;
neither enters an image or receipt. Its local PostgreSQL endpoints must be
loopback addresses; the OCI fixture reaches that same endpoint through the
container host bridge while retaining the declared CA and hostname verification.

This command mutates all three installations. Each must be a separate fresh
PG16 cluster with a verified TLS endpoint. The URL explicitly supplies its
bootstrap login and database (the local reference uses `postgres` for both). The bootstrap prepares separate restricted
migration, runtime and restore identities in the existing witnesses; this is not
a claim that hosted control-plane users have identical authority. Admission
checks every system identity and fresh catalogue before the first installation
write. The strict local catalogue check permits only the selected ordinary
database alongside PostgreSQL's two templates, and refuses extra user schemas,
public objects, extensions, non-bootstrap user roles or another active client
session at admission. The explicit disposable declaration remains the operator's
target ownership assertion; the point-in-time check cannot prevent a later
connection. A wrong TLS hostname
must also be refused. No reset or target teardown
is implicit: the operator owns these disposable clusters and their removal.
After a partial failure, use new fresh installations rather than rerunning over
a used catalogue.

The JSON receipt records the two fresh bootstrap modes, fixed inventories,
sealing/replay/refusals, connection limits, role denials, pooled requests,
read-only transactions, lock contention and deterministic bad-affinity refusal.
The schema section runs the actual released legacy predecessor, real backfill,
killed inside/between-unit transactions, resume/replay and compatible previous
application read/replay. It does not roll the database schema back. The
previous-application proof creates a temporary login with a per-run random
password, then attempts to remove its grants and role on normal exit or handled
failure. A cleanup failure or abrupt process kill still requires operator
teardown. For `self-host`, the runner then calls the landed portable catch-up and
older-snapshot journeys, real Keycloak lifecycle, local S3 and Node/OCI fixtures.
Only their executed success and owned cleanup yield `COMPLETE`, meaning a
**local self-host recipe receipt**. The transfer section keeps the managed first
leg `PENDING-ON-8D-2`; the additional hosted provider pair remains pending. The
recovery section carries actual snapshot age, effective RPO, scoped RTO, counts,
readiness and residual uncertainty: declared-scope fixture measurements, not an
SLO or hosted claim. The source and compiled artifacts must remain unchanged
through every phase.

The S3 section observes two real local gateway accounts, authorized readback,
anonymous/cross-account refusal, bounded-size and content-version refusal,
deletion and the pinned gateway's actual version/lifecycle responses. Its older
backup keeps the erased bytes while a later host-owned erasure obligation
excludes that key from the private filesystem restore inventory; the target
must read the retained object and refuse the erased key. This does not add
automatic privacy policy to the copier or equate gateway IAM with customer RLS.
The fixture uses separate owned tmpfs IAM and versioning roots, exercises native
version/deletion operations in a separate versioned bucket and retains the
transfer adapter's refusal of native version-history transfer. Unobserved
elapsed lifecycle expiry remains explicitly unproved; hosted S3 stays pending.

A separate `--target s3` invocation selects only hosted storage through the
same runner; unrelated recipe sections remain pending. Its external mode-600
JSON declares `schemaVersion: 1`, `target: "s3"`, `disposable: true`,
declared `region` matching `^[a-z]{2}(-[a-z]+)+-\d+$`, `bucket`, a unique `prefix` of the form
`m14-10o/<runId>/`, absolute external `lifecycleStatePath`, and exact
`sourceCommit`/`sourceTree` Git identities. Other fields, endpoints, explicit
keys and other namespace forms refuse. Run on the authorized Linux VM using
its instance role through the SDK's instance-metadata path. The worker clears
inherited environment and points shared AWS config/credential reads to `/dev/null`,
so a local profile or credential process cannot supply the receipt. Transfer an exact Git
archive, reconstruct its tracked index without credentials, and verify that
index tree against the declaration before running. Build workspace packages
first. The archive's original commit is operator-declared; the runner checks
the actual index tree and unchanged source bytes. Exact target identities stay
private; the receipt uses a neutral target label.

If the private lifecycle continuity file is absent, the runner first requires
an empty owned prefix, creates the two seed keys and saves their identities.
A partial seed failure requires exact-prefix inspection and cleanup; it never
automatically recreates a seed. Existing continuity files must be regular,
user-owned, mode 600 and single-link; symlinks refuse. The file records the run prefix, UTC clock start,
two dedicated keys and their exact version identities, including three
noncurrent versions, plus planned checks. It is not a passing receipt. The first
runner admission must observe all seeded noncurrent versions and the retained
latest versions/marker. At each start the runner reads back an enabled applicable
one-day noncurrent-expiry rule. It records PENDING-OBSERVATION until at least
24 elapsed hours, a fresh check against surviving provider seed timestamps,
a listing of zero noncurrent versions and explicit
NoSuchVersion readbacks for every seeded old version, while
retained latest objects/marker still exist. Resume the same declaration around
T+26h and T+50h with new receipt destinations. A rule readback alone cannot PASS.
After observation, every version and marker under the entire prefix is removed
and zero of each is read back. Pending runs clean the functional subprefix and
retain only the two lifecycle keys for the later observation. A killed process
requires operator inspection and exact-prefix cleanup before another run.

The `s3` and `hostedRecipes["10O"]` sections report the same executed storage
result. Pending lifecycle keeps both PENDING-OBSERVATION; functional successes
do not promote it to PASS. A final PASS includes whole-prefix cleanup and means
**hosted S3 recipe receipt (single synthetic bucket, one region)**, never
production qualification or an SLO. The [adapter owner](../../server/adapters/README.md#s3-object-source-preparation)
describes the serving, host-grant, size/type and erasure proof limits. This
source declaration does not itself record a successful hosted run.

The host section uses distinct immutable A/B application images, actual HTTP/UI
and restricted-runtime readback, durable immediate/scheduled outbox work,
captured delivery commands and filesystem bytes. It checks restart, an admitted
callback held through drain and A→B→A readback without duplicate delivery.
Effort records wall time, witness launches, interventions and owned-resource
absence. Operator provisioning, dependency/image caching, the three declared
database clusters and the previous application artifact remain outside owned
fixture teardown; the operator must remove those disposable inputs separately.
The receipt is source proof, not hosted or production qualification.

The fixed `hosted-node` selection calls the same `runSelfhostHost` lifecycle
witness against one operator-owned synthetic VM. Its external mode-600 JSON
has `schemaVersion: 1`, `target: "hosted-node"`, `disposable: true`, a declared
AWS-format `region`, declared public HTTPS DNS `origin`, cached immutable
`localNodeImage`, exact archived `sourceCommit`/`sourceTree`, and `database`
containing only loopback `connectionString` and PEM `ca`. The operator prepares
that disposable TLS PG16 using the existing restricted-install witness; RDS is
not used. `certificatePath` and `keyPath` name external ordinary owner-only
mode-600 files, mounted read-only into the application containers. Extra fields,
mutable images, non-HTTPS or IP-literal origins, reserved DNS names, remote
databases and source drift refuse. The origin permits only the root path, no
userinfo, query or fragment, and the default HTTPS port or explicit 443.
Admission rejects even empty userinfo syntax before URL parsing, then normalizes
accepted inputs to the canonical origin before the witness appends route paths.
The receipt records the HTTPS scheme and public-DNS class, never the hostname.
No credential, private path or endpoint is included in the public receipt.

On the VM, archive the exact source, install dependencies and build packages
before invoking the same command with `--target hosted-node`. Install Playwright
Chromium into `.context/scratch/hosted-node-receipt/browsers`. The fixture uses
the deployment-owned HTTP runtime `listen` seam for native public TLS and a
namespaced host-network container on port 443. Ordinary Node and Chromium
certificate and hostname verification remain enabled. The image carries the
bundled application source, while database inputs, filesystem state and TLS
keys stay outside the image. Existing restart, drain and A→B→A assertions run
over that public HTTPS origin. The runner returns `PASS_HOSTED_NODE` and a
`hostedRecipes["10H"]` PASS only after those assertions and owned fixture cleanup.
Its claim is **hosted Node/OCI recipe receipt (single synthetic VM)**, with no
production qualification or SLO. Operator timing, database/certificate/source
teardown and public-port absence require separate recorded readback; the runner
removes only its own host containers, images, role, events and private state.
The independent Netlify/PaaS candidate stays `PENDING`, owner `10H-paas`, reason
`access not provided`. Missing access establishes no measured rejection.

The `rds` selector requires `layout: "serial-cluster"` and a declared AWS region. Its three
installation entries name the same password-free URL, CA, `passwordEnv` and
expected `incarnationSha256`. Supply that named variable only in the invoking
process (`PGPASSWORD` or a name of the form `M14_<NAME>_PASSWORD`); runtime control
variables such as `NODE_OPTIONS` refuse. The runner forwards only that variable
from its environment, adds its own worktree-scoped temporary directory, and
starts the isolated worker. Schema children receive their restricted connection
through stdin and inherit no bootstrap password. No password belongs in the
declaration. Its accepted fields are `schemaVersion`, `target`, `disposable`,
`region`, `layout`, `installations` and `previousApplicationPath`. Each
installation accepts `disposable`, `connectionString`, `passwordEnv`,
`incarnationSha256` and `ca`; undeclared fields refuse at either level.
The incarnation digest binds
the JSON array of observed server address, port, postmaster-start text and
bootstrap database OID text. It requires no `pg_control_system` privilege, is
weaker than a system identifier and refuses after an incarnation change.
Managed image identity has no OCI claim.

The private-network worker checks both accessible baseline databases (the URL
database and `postgres`) before each phase. Only those databases, the provider's
`rdsadmin` database and the current test-created database may exist. Only the
fixed stock RDS roles and the declared bootstrap may supplement PostgreSQL's
predefined roles. Other client sessions refuse except `rdsadmin` sessions in
the `rdsadmin` database. These are bounded provider exceptions, not arbitrary
declaration-supplied catalogue exclusions. The worker creates a unique test
database for each phase, removes it and its test roles, reads back absence and
rechecks freshness before continuing; it never force-disconnects other sessions.

Both installation modes carry the declared `target` and `layout` into 8C
admission. Only the RDS serial-cluster selection admits provider authority
without an elevated flag through declared `rds_superuser` membership. All other
declared names still require elevated flags, including the other seven stock
roles. The eight-name stock inventory is shared with the freshness check and
excludes predefined-role edges only when both member and grantor are declared
stock RDS roles. RDS schema proof
uses the canonical restricted-generation prefix before
the existing invoicing backfill, its real inside/between-unit kills, resume and
previous application read/replay. This is not a released restricted-generation
upgrade lineage; the existing released legacy path still requires SUPERUSER
and remains the self-host proof. The restricted schema phase leaves its temporary
application role and grants to the outer owned-database teardown; database drop
removes the object dependencies before role removal and absence readback.
Direct CA/hostname verification and wrong-host
refusal are mandatory. The runtime client pool and deterministic affinity
refusal do not qualify a hosted pooler: report "no pooler provisioned".

Only executed initial phases and test-owned cleanup can produce
`hostedRecipes["10R"].status: "PASS"`, with claim "hosted RDS PG16 recipe receipt
(single synthetic instance)". Transfer and recovery remain PENDING, owner 10P.
Other hosted sections and `neon` remain pending their own receipts. This is
workspace source proof, not production qualification, an SLO, installed-current
package support or a stable-framework qualification. The
[RDS task record](plans/oss-m14-hosted-rds-receipt.md) records observed evidence;
source availability alone establishes no hosted PASS.

The separate `hosted-oidc` selection calls the same real-issuer lifecycle witness
with a declared disposable HTTPS origin. Its declaration and teardown duties
are in the [identity recipe](IDENTITY.md#real-issuer-oidc-recipe). Only the OIDC
and hosted 10I sections pass after executed proof; all database, transfer,
recovery, storage and host sections remain pending in that receipt. The local
supporting database and browser do not establish hosted database qualification.
TLS uses ordinary certificate-chain and hostname verification. Operator-owned
VM containers, certificates and listeners need separately recorded teardown.
This also removes any residual realm state after failed issuer provisioning.

## Runtime model

Moved to [Run OpenLup on your own host](../../packages/core/docs/guide/how-to/operate/self-host.md#compose-the-host), [Shut down a host cleanly](../../packages/core/docs/guide/how-to/operate/shutdown.md#drain-before-disposal).

For a managed-source acquisition cut-over, configure the reference target's
`OPENLUP_ACQUISITION_DRAIN_STARTED_AT` as a fixed UTC ISO instant and
`OPENLUP_ACQUISITION_DRAIN_MAX_SECONDS` as a positive integer no greater than
604800. Deploy the same values to every target process before activation.
The partner submit/transition, survey submit and newsletter consent BFF command
paths refuse at their route entries before authentication or signature work,
with HTTP 503, `Retry-After` and `acquisition_legacy_drain` while
the declared interval is active; read paths remain available. Setting
`OPENLUP_ACQUISITION_DRAIN_ENDED_AT` to a UTC instant at or after start
explicitly ends the drain when that instant is reached. A later end cannot
extend the configured maximum. A future start is invalid on a serving target;
the operator must correct the cut-over instant before activation. Incomplete or malformed cut-over configuration
fails closed before that maximum. After the drain, commands enter a new
target-key namespace; the target
does not compare retained source-keyed receipts. The host must separately prove
source quiescence, consistent rollout and item 8 retention of source history;
these environment values do not certify any of those facts. See the
[managed mapping task](plans/oss-m14-managed-identity-mapping.md).

Acquisition and transfer handover composition belongs to the
[transfer owner](ARCHITECTURE_AND_EXTENSIONS.md#existing-store-transfer-and-recovery)
and [managed mapping task](plans/oss-m14-managed-identity-mapping.md).
Local tokens and pre-dispatch generation checks do not exclude an old runtime
at provider I/O; host-enforced egress fencing and effect reconciliation remain
required before target activation.

The reference control-plane binding owns bundle selection, admin authorization,
client lifetime and the capability-local operator ID; the watchdog delegates to
the package persisted-job tick. The
[operations boundary](ARCHITECTURE_AND_EXTENSIONS.md#operations-and-diagnostics)
owns these composition responsibilities. The captured portable operations
binding selects evidence, alert/readback, pipeline, authorization and heartbeat
ports; its local capture mode is not hosted delivery/readback.

Marketing reference routes compose `@openlup/platform/marketing/server` with the
host BFF responder, authorization and persistence. Keep the existing guard,
schema, operation and response order, retired route admission, signed newsletter
ingress and notification presentation at their source owners. Browser validation
uses the marketing entry; DTO-only imports use its contracts entry. Rich joins
and historical adapter signatures remain application-owned.

Reference analytics composition owns consent signal/storage names, event prefix,
container reader, route paths, suppression diagnostics and deployment sink.
The server-only `createAnalyticsContextHandler` requires explicit enablement,
persistence, bearer/subject verification, cryptography, cookie and client-ID field
names, and BFF responder. There is no default persistence, portable context SQL
or reference context route; context failure never gates commerce.

The accounting HTTP scheduler receives an explicitly composed invoicing service
after method and bearer checks. The reversal binding retains its event adapters,
provider selection and business keys; correction execution requires a conforming
recovery bridge. The local-document adapter supplies a structural executor and
local provider metadata to `createPostgresInvoiceStore`. Native sweep, prepare
and finish remain separate autocommit calls.

The reference payment-channel BFF owns feature/mode admission and supplies the
package HTTP client to the domain handler. Customer setup retains the host SDK
builder and vendor-subpath mappings.

The [M06 shipping binding](../../server/runtime/public-reference/m06ShippingBinding.ts)
composes selection, address and flat-rate ports with host schemas and authority.
Native address writes require a complete selected
[saved-address port](../../packages/platform/README.md#saved-customer-address-book).
Native flat-rate save requires the native rate port, a ready Core report and a
same-database `nativeRateSchema` observation; managed BFFs retain their gates.

The [A1 reference binding](../../server/runtime/communications/a1ReferenceBinding.ts)
is explicitly opt-in and loads host inputs lazily. Its host owns credentials,
egress policy, callback/environment selection, marketing verification and account
state. Install only its returned guarded ports through the existing composition
seams, selecting routes, schedules and inert descriptors explicitly. The bounded
delivery callable uses the native direct store, closes it on either outcome and
adds no executor or recovery send. The
[canonical composition rules](CANONICAL_CONTRACTS.md#explicit-reference-adapter-composition)
own its translation and refusal semantics.

The native [communications lifecycle binding](../../server/runtime/communications/communicationsLifecycleBinding.ts)
is a host-callable `node-postgres` capability. Compose the complete catalogue,
trusted owner-authority connection and verified human operator for its directory.
Native membership dispatch needs an explicit provider; native watchdog readback
needs a selected read function. Each capability closes its pool. The
[package recipe](PLATFORM_PACKAGE_REFERENCE.md#native-communications-operations-development-preview)
owns the selected bridges and their limits; no default timer is installed.

Reference identity privacy routes retain human-admin authorization, mutation
policy admission before body reads or binding construction, no-store responses
and dispatcher preflight. Direct and managed policy selection remains behind
`#deployment-route-policy`; the public default refuses with `adopter_policy_required`.
Managed export reports incomplete coverage and managed erasure refuses before
mutation. Direct erasure leaves subscriptions unchanged. The admin panel owns
confirmation and subject/session-bound readback; challenge pruning adds no timer.

Customer reconcile selects the bundle's identity path. Direct requests use only
the actor's linked contact; managed requests retain email-trust policy and shared
settings. Direct invite/remove factories compose the invitation directory/store
behind human-admin authorization and retain invitations when delivery fails.
Managed invitations still create active membership immediately; native membership
reads do not activate it. Pending/expiry semantics remain a managed compatibility
gap. The [identity owner](IDENTITY.md#operator-invitation-lifecycle) owns results,
retries and the direct pending-invitation lifecycle.

The server health and unsubscribe bindings read `#email-presentation` and expose
its ID. A changed selection needs runtime module resolution and packaging proof.
The BFF entrypoints delegate to the package dispatcher through
`server/runtime/bffDispatch.ts`; shared cron entrypoints use `authorizeCron`.
Company lookup and hidden address routes keep their environment, gateway,
availability and handler construction order.

Identity route files supply application schemas, admission, limiter, redirects
and observed request IDs to [package handler factories](IDENTITY.md). A source
route does not add itself to the default empty table or closed reference set.
Magic-link composition uses the [shared strict origin policy](IDENTITY.md#magic-link-redirect-policy):
customer origins select `APP_BASE_URL` then `CUSTOMER_AUTH_REDIRECT_ORIGIN`, admin
origins select `APP_BASE_URL` then `SITE_URL`. Invalid or absent origins refuse
before provider access; request hosts supply no fallback. The Auth mail bridge
preserves its admitted transport, envelope and verification/render/send/store order.

Evidence (historical record, 2026-11-13):

The [native handover fixture](../../tests/postgres/runM14EffectHandover.ts)
uses actual restricted-runtime dispatch and review HTTP/storage composition in
four owned local processes. Its default crash-boundary mode observes the binding's startup and natural30s
interval, admits raw bodies before the same-grant held finalize, and releases
real filesystem operations after network exclusion. The host then removes the
exact processes. Because a severed client socket can leave a server transaction,
its disposable migration owner may terminate only previously observed actor
backends whose PID, start time, database, principal and actual boot-bound
application name still match. Unknown clients or reused identities refuse;
there is no terminate-by-user/prefix, database restart or lease/time manipulation.
The coordinator closes its source mutation clients before the final read-only
capture and permits no later source business write, gate release or recreation.
Target composition follows verified graph and complete private-root publication.
The optional `--catch-up` mode drains admitted media I/O before egress exclusion
and retains a separately admitted partial upload. Its restricted M obtains no
extra backend-inspection grant: the existing fixture bootstrap administrator
observes and retires exact source sessions, then closes that pool. Final
catch-up capture/census uses a new bootstrap-principal session configured
read-only by default and closes it before target publication. Default mode
instead uses its migration-owner capture session. The
[transfer owner](ARCHITECTURE_AND_EXTENSIONS.md#existing-store-transfer-and-recovery)
owns preliminary-generation refusal and the final DB/object/access/drain/effect
barrier; it is a finite local journey, not an adopter-host fencing service.
The opt-in `--managed-catch-up` mode maps the stock-PG17 managed-compatibility fixture into
that source installation. Its declared setup writer ends before final read-only
capture; no managed Auth or Storage HTTP service starts. Typed catalog,
consent and settlement facts are read back at both local PG16 targets.
History-only settlement and expired-key rows stay in the operator source archive;
managed Storage remains outside that three-installation journey. The separate
[managed Storage witness](../../tests/postgres/managedStorageTransfer.proof.ts)
projects the finite operator-only cohort into a private filesystem store and
copies the final objects onward through the existing portable object path.
Native H1/H2 retirement and egress exclusion then run for the portable leg.
This does not qualify a hosted managed source or a complete adopter writer
inventory. The opt-in real-source witness supplies a fresh pinned managed
stack to the same assertions and complete journey; required first-leg Vitest
tests use the compatibility fixture and require no Supabase CLI.
The `--older-snapshot` mode retires the media application earlier, before saving
the consistent DB/private-media backup. Its three admitted dispatches have a
fixed 63-second release deadline to enclose the measured 60-second snapshot age;
the default and catch-up deadlines remain 30 seconds. After induced failure,
the same terminal retirement prevents the exact old executor from restarting
after ownership transfer. Target effects and serving remain closed through
restore, later privacy replay and authenticated reconciliation. Its scoped RTO
includes actual serving and ordinary-job readback and permits one visible fenced
uncertainty; it establishes no host SLO or hosted provider qualification.
The 60.081-second RPO is the chosen snapshot age; the 87.345-second scoped RTO
conservatively includes quiescence and the wait. These are declared-scope
fixture measurements, not an SLO or hosted claim.
This finite synthetic host profile reports only its selected local readiness: other modules/jobs/webhooks/operators, effective
adopter ACLs, provider qualification and whole-store RTO remain separate.

The [package handler characterization](../../packages/platform/test/operations/controlPlaneHandler.test.ts)
pins the injected authorization/port boundary used by this reference composition:
authorization before malformed-body parsing, method/command refusals, replay
receipts, unchanged heartbeat forwarding and safe invalid-result/upstream errors.
These synthetic handler cases supply no deployment, session-provider or live-store
qualification; the host still owns those bindings.

The [composed witness](../../server/runtime/public-reference/m14OperationsBinding.test.ts)
executes domain/job evaluation, capture, alert readback, selected-sink backoff,
failure backoff, unknown liveness, authorization and safe correlated logs with
in-memory host ports. It does not qualify a database adapter, installed npm
default or remote log drain. Missing remote log/delivery observations remain
unverified; selecting an adapter alone supplies no such evidence. See the
[operations owner](ARCHITECTURE_AND_EXTENSIONS.md#operations-and-diagnostics)
and [bounded task](plans/oss-m14-portable-operations-defaults.md).

The
[package witness](../../packages/platform/test/marketing/analyticsContext.test.ts)
uses in-memory persistence without a live provider.

The [native conformance witnesses](../../tests/postgres/invoicingNativeConformance.test.ts)
cover row/lease fences, scope, locked accounting and unchanged renewal state.
The combined P4 chain also installs the pinned payment-decoupling replacement;
independent collection never joins a payment or parcel transaction.

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

Synthetic offline fixtures and
locally packed consumers establish composition, not provider-account activation
or hosted duration evidence.

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

Moved to [Run OpenLup on your own host](../../packages/core/docs/guide/how-to/operate/self-host.md#compose-the-host).

Application-file lifecycle maintenance belongs to the
[snapshot owner](ARCHITECTURE_AND_EXTENSIONS.md#application-file-upgrades);
database compatibility and runtime admission remain separate checks. The
[legacy role-observation owner](DATA_AND_MIGRATIONS.md#legacy-fresh-bootstrap-role-observation)
defines `inspectLegacyPostgresInstallRoles`: its finite observations create no
role or schema and do not establish installation readiness or host support.

## Opt-in disposable subscription reference

The unmounted [M17 channel recipe](../../server/runtime/public-reference/m17ChannelBinding.ts)
returns null before reading any host binding when its separate enable argument is
false. Managed selection requires explicit owner clients, accepted currencies,
actor and current live job IDs, connector/token/body policy, and a historical
bundle read port. Ordinary bundles use M05's active catalog adapter; historical
purchases use original locked BOM, SKU identities and digest without filtering on
current activation. A current catalog response is insufficient historical evidence.
The host must preserve timestamp precision in its read-only historical projection.

Its page callable records the page and every capture before committing progress,
then consumes the original capture/ledger through exposure conversion and the
existing ingest saga. An accepted event must match its stored event-specific
capture before replay; omitted retained rows use the server-pinned original,
while supplied rows must match exactly. Accepted aliases still consume the
original obligation without reading current historical catalog facts.
Only settled/replayed outcomes reach seller ACK; false ACK
leaves captured purchased settled debt pending and recoverable until ACK.
Ordinary normalized ingest retains a donor retry gap: an interruption after its
settled-ledger write and before done cannot currently complete automatic retry.
Recovery selects pending captures independently of
fresh discovery and uses the supplied current live job for any new physical effect,
while the capture's original execution bytes remain unchanged. The host owns job
admission and lease liveness; this factory creates no scheduler or mounted route.
Portable selection exposes only the existing parameterized capture/read/CAS store
and refuses consumption with `channel_purchase_physical_unavailable`. Privacy
lifecycle and jobs are unavailable; simulation stays off. The adjacent
[guard tests](../../server/runtime/public-reference/m17ChannelBinding.test.ts)
cover disabled and portable selection. The [reference proof](../../tests/postgres/m17ChannelReference.test.ts)
uses a local managed compatibility database and actual imported locked rows;
it does not establish hosted managed or real-provider qualification.


The [market source recipe](../../server/adapters/market-packs/marketRecipe.ts)
is opt-in and unmounted. Supply language, configuration and constructed provider
ports explicitly; directory lookup is optional. The reference descriptor imports
today's application constants without changing ambient currency initialization.
Configured settlement, pricing region and fiscal facts remain independent of
language. The bilingual [message table](../../src/public-reference/i18n/marketResources.ts)
is data only: it installs no i18n instance, route, fallback or language default.
Unknown recipe language refuses explicitly; existing callers keep their own
selection and fallback behavior. Synthetic/unsupported/manual examples prove
existing service branches without provider IO. This is no foreign fiscal,
registry, licensed directory or production-host qualification.

The [reference binding](../../server/runtime/public-reference/referenceMarketBinding.ts)
selects that recipe explicitly and remains unmounted. Its default uses the
public reference's existing language and settlement facts; the message module
still creates isolated i18n instances with its existing fallback. Company
lookup and address schema facades use the package engines while provider mode,
environment reading, gateway order and invoice mapping remain with the host.
Constructing the binding calls no provider or directory and leaves manual
shipping available.

The [M15 risk recipe](../../server/runtime/public-reference/m15RiskBinding.ts)
is default-off and mounts no BFF route. A selected host supplies the existing
managed or native package ports, trusted admin authorization/actor mapping,
mutation policy, version, schema requirement and readiness observer. Only
explicit `selectedRoutes` are advertised. Unknown/unsatisfied schema readiness
returns unavailable before admin authorization or retries paid processing before
evidence and fulfillment; disabled selection observes no schema or risk port.
Pass the recipe's `outboxRisk` once into the existing commerce dispatch registry.
Its risk contribution has no event handler or schedule, so no second
`commerce.order.paid` executor exists. Checkout keeps its existing optional
blocklist callback; this recipe changes no checkout admission or flag.

The [reference witness](../../server/runtime/public-reference/m15RiskBinding.test.ts)
characterizes allow/review/block/retry/fatal through that registry. Shadow
review/block can acknowledge without fulfillment even when SQL opens no hold.
Admin factories retain method → authorization → mutation policy (decisions only)
→ strict schema → port → response-validation order. The host responder preserves
request references and error envelopes; clients and the hidden UI remain source
consumers. The [browser witness](../../src/public-reference/riskReviewRoutes.test.tsx)
pins the captured escalated UI refusal even when the server's action eligibility
allows actions. Managed replay still projects `false`; no policy correction,
route activation or privacy/portability integration is implied.


The [portable Node serving entry](../../server/runtime/public-reference/serve.ts)
also accepts an explicitly constructed operations binding on its ordinary
reference host. That selection mounts only the existing alert and pipeline
admin read paths; it requires `APP_BASE_URL` for exact Host admission. The
existing observed-route wrapper starts on the decorated raw request, so policy
and alert method refusal precede adaptation and authorization. Adaptation and
preflight failures retain bounded errors and safe correlated request logs. The pipeline path
retains its public mutation-policy refusal; the alert path supplies admin
readback through its typed handler.
It refuses combination with another reference profile or identity admission.
The watchdog remains a trusted scheduler callable and gets no public cron route.
Omitting the selection preserves the static reference's existing route surface.
See the [captured operations recipe](#runtime-model) for ports and proof limits.

The unmounted [SEO head adapter](../../src/public-reference/seoHead.tsx) renders
`@openlup/platform/marketing` head descriptors through the host's
`HelmetProvider`. Its synchronous Helmet commit works in hidden documents;
after client commit it removes unmanaged shell canonical/alternate links only
when the host supplies `renderMode="csr"` and passes the
serialized JSON-LD into the script element unchanged. The host
selects placement; this adapter installs no serving route. Its
[synthetic browser witnesses](../../src/public-reference/seoHead.test.tsx) cover
hidden commits, hostile script data and duplicate or contradicting canonicals.

The inert [M11 commerce binding](../../server/runtime/public-reference/m11CommerceBinding.ts)
selects existing package callables and the native checkout-recovery adapter only
with `enabled: true`. Every callable checks the supplied Core readiness report:
only `ready` admits work; `unknown` and `unsatisfied` return `schema_<state>`
before executor work. Hosts check readiness before replacing a serving selection
and supply the complete catalogue identity and additional selected-operation
schema objects. Ports, routes and triggers share one guarded callable per
operation; duplicate native-recovery names and descriptor identities refuse.
The [native recovery witness](../../tests/postgres/commerceComposition.test.ts)
observes a persisted reminder and replay while preserving active subscriptions,
their reservations and undelivered-parcel alignment. Native recovery supports
reminder intents, delivery authorization and terminal outbox compaction;
expired-checkout recreation remains managed-only. This binding installs no
route, timer or worker and changes no served default.

The [M12 account/support recipe](../../server/runtime/public-reference/m12AccountSupportBinding.ts)
returns guarded services, readiness, schema, contributions and namespaced port,
route and trigger maps. Construction mounts nothing; omitted or false enablement
returns `disabled` before observing schema and leaves executable registrations
empty. Enabled entrances re-observe before every call and return
`schema_unknown` or `schema_unsatisfied` without invoking an owner. The host must
map these admission objects to its HTTP response before mounting the descriptors;
this recipe does not install a refusal transport or alter `serve.ts`.

Supply prebound authenticated R1–R4/owner facades or handlers, one dispatcher per
logical command, a complete installed catalogue identity, selected owner schemas
and exact additional objects. The schema helper deduplicates kind/name/signature
without dropping overloads. Native subscription commands need both preview and
apply; selecting them does not select M10's renewal runner. Supply R4's actual
authority routine and support ledger requirements only on the selected graph.
Identity, M04, payment-truth and invoice-duty requirements come from their selected
owners; table presence alone cannot establish authorization or PDF capability.

For operator subscription actions, wrap R4's `execute` with
`createM12OperatorSubscriptionActionRoute` and register that one callable in both
operations and route descriptors. It adds the donor BFF's `contractVersion`,
`action: "apply_subscription_action"`, `subscriptionAction` and `subscriptionId`
to settled and refused results, serializing exactly the donor's strict outcome
DTO. Preserve R4's decoded ISO timestamp spelling (`.000Z` for whole seconds) and
explicit nulls. Optional native `ownerReceipt` evidence stays on R4's server-side
result and is absent from this wire. Translate the native in-band
`operator_subscription_authority_unavailable` refusal by throwing the donor's
`OperatorSubscriptionAuthorityUnavailableError`, preserving its existing BFF path.
The SQL command record's internal action and timestamp spelling are not the BFF
response. R4 still owns authorization, the transaction and replay.

`AccountSupportRoutes` composes host-supplied account, Customer 360, command and
recovery elements at explicit host paths. It supplies neither credentials nor
new authentication contexts. The capability manifest advertises account-support
as default-off with no routes. To select commerce, the host constructs one
`createM11CommerceReferenceBinding` with raw, already bound owner callables, its
native query executor, the complete account-owner and exact ATP schema requirements,
existing registry handlers and optional route/schedule descriptors. Supply that
result as `commerceOwner`, the matching callable record as `commerce` and the
existing registry as `commerceRegistry`. Use matching enablement and a readiness
observer covering the complete selected schema for both bindings. R5b consumes
a local structural selection type and does not construct M11 or import its adapters.
Use `createReferenceCheckoutHandler` for
reference checkout and the existing recovery handlers with
`CheckoutRecoveryOrderReadPort`/`CheckoutRecoveryTokenPort`; expiry and token
classification remain owner policy. Bind the selected M06/M11 stock read or
`createNewPurchaseStockAvailabilityPort` without replacing unknown or unsupported
answers. The schema unions the supplied M11 schema, which includes the host's
ATP requirements, and selected account-owner objects by kind/name/signature.
M12 forwards the host-built M11 result once and
returns the same registry as `commerceRegistry`; it never dispatches effects.
Do not supply an M11-guarded service as a new raw owner or register the same
logical command in both inventories. `commerceOwner.services` and its forwarded
commerce ports/routes share the owner's guarded executor; the keyed entrance
delegates to it without another readiness guard. With no commerce selection,
nullable record/member behavior stays `unsupported/host_binding_required`.
`AccountSupportRoutes` accepts a configured-purchase element/path in addition
to its recovery element; the host binds their clients and admission transport.
Local draft resume/discard behavior is unchanged. M04 receives subscription lifecycle
descriptors with `messageKey === idempotencyKey`; R4's issue-recovery notice is
already queued by its owner. M12 adds no renewal, reminder or delivery worker.

The opt-in `createNativeSubscriptionBinding` from `@openlup/platform/subscriptions`
returns services, schema and realization admission. The [reference facade](../../server/runtime/public-reference/m10SubscriptionBinding.ts)
joins it to public `createSubscriptionContribution`, preserving readiness,
one job descriptor and its guarded executor; it mounts
nothing. Supply a complete catalogue identity and Core readiness observation,
the existing population's durable job lease, native transaction lane, codec and
explicit M07 payment/correlation policy. Renewals, stock recovery and dunning
run under that one lease. A normal-due or stock-recovery row failure returns the
existing error result and leaves later rows runnable in that population run.
Disable the incumbent executor before selecting a
replacement. The default is off, and no current serving route changes. Native renewal stock routines enter shared admission inline with the same busy and isolation codes, retaining invoker rights and existing grants; custom runtime roles need no new grant. G23
captured cases survive a global alignment-mode rollback to off; disabling this
binding itself still requires the host's reconciliation/handoff procedure.
The [subscription recipe](ARCHITECTURE_AND_EXTENSIONS.md#composed-subscription-module)
owns replay, frozen-mandate and lifecycle-message semantics.

The inert [M12 self-service binding](../../server/runtime/public-reference/m12SelfServiceBinding.ts)
returns `{ enabled: false }` when `enabled !== true`, before invoking the host
selector. For an explicitly enabled recipe, provide `select(verifiedContext)`
returning complete selected owner lanes, required host capabilities and the same
verified context. The facade
rejects missing port methods and mismatched principals before execution. A raw or
typed M10 lane may be selected independently; it never supplies a fallback for the
nativeLegacySubscription lane. That lane requires explicit pause, control, ownership
read and the host's ownership-refusal constructor. Managed routing uses the
host's existing managedSubscription port. Supply profile, paymentMethod, commerce
and recovery as explicit lanes; every returned lane has a principal guard. Raw
and typed commands require the supplied clientId to equal context.clientId,
refusing omitted, undefined, null or foreign values before calling the owner.
Every output lane stays callable when unselected and returns a named
`{ supported: false, refusalCode }` after the principal guard. PaymentMethod returns
the host paymentMethodSetup refusal by identity, commerce returns commerceRecovery,
and other lanes return a frozen host_binding_required refusal. Supported
paymentMethodSetup requires paymentMethod; supported commerceRecovery/configuredPurchase
require commerce. Supported subscriptions.genericBundleCommands/commandBoundReceipts
require at least one selected managed/native legacy/raw/typed command lane. The factory
returns the SelfServiceCommandFacade envelope. Its trailing defaulted
`ControlSnapshot = unknown` generic retains the selected control snapshot type
through the reference selector and facade. This recipe opens
no route, provider, store or executor and grants no activation. R5 must settle
native browser key retention before connecting preview/apply UI; native start and managed-shaped redeem remain unselected.

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
admission uses public `withNativeDeliveryAlignmentRenewalAdmission` around the
native automatic runner's existing hook; the [legacy decorator](../../server/runtime/subscription/deliveryAlignmentRenewalStore.ts)
retains its existing hosted port. A host that composes the native
automatic-renewal runner must wrap its store port with this decorator; until it
does, native delivery-alignment mode stays off or shadow. The public native
composition factory includes this decorator; hosts using the primitives compose
it explicitly.
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
requires selected ports and host authority. Native address writes require an explicitly selected complete
[saved-address port](../../packages/platform/README.md#saved-customer-address-book);
unbound or incomplete native writers remain refused.
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
selects one store and the reference provider validator. For PostgreSQL, the host
supplies `store.stockSourceKey` to bind the existing ATP reader into catalog bundle
availability. Missing keys leave the preview unbound with
`inventory_stock_source_key_required`; `requireNewPurchaseStockRead` makes that
a readiness refusal. The native preview protects all live holds, remaining due
subscription demand inside 14 days and channel exposure, clamped at zero. It
refuses own-order exclusions and other horizons. Managed composition uses an injected normalized reader first, then
`store.stockRpc` for the service-role managed reader with the managed forward
`20261025109000_inventory_new_purchase_stock_read.sql`; without either it reports `inventory_new_purchase_stock_reader_required`.
Managed quantities retain ATP provider-tagged accounting and the same fixed priority. Native one-time and replacement allocation remain
unavailable; this read supplies no allocation authority. Importing
the binding mounts no route, schedule or provider. Admin composition retains its
authorization and mutation flag; native adjustment remains refused.
The stock binding passes `createInventoryBindings(...).newPurchaseStockReadPort`
to M06's availability projection and binds the pure status ladder from browser
commerce. Physical-table fallback is still an explicit host choice, using the
single commerce/server projection; it cannot allocate or consume reservations.
Private preview transport remains host-owned.

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
stock reader double, so it proves mounted readback with that double. Native ATP
behavior has separate [stock-read witnesses](../../tests/postgres/newPurchaseStockNative.test.ts).
No acceptance token, publication receipt
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


The Node reference start function accepts an admitted outbox candidate and a host schedule binding. For a selected rail it binds dispatch/prune before opening the listener; a refused candidate or absent schedule binding opens no listener. Host composition supplies its driver, lease, effect handlers, known vocabulary and migration observation. Immediate and scheduled work share the packed rail engine, with candidate identity checked at every entrance. The default static CLI selects no outbox adapter and provides no deployed outbox proof.

### Account and support read bindings

Customer profile and invoice-correction handlers are supplied as explicitly bound
package mechanisms; [account mutation composition](../../packages/platform/README.md#customer-account-events-and-mutations)
requires host authentication and a principal/client scope. Each profile query and
its subsequent event append commits separately. No default route, starter editor,
mail consumer or fiscal operation is installed. Hosts using these writes must also
register the ledger's privacy contributor and retention disposition.

The unmounted `createM12AccountReadSelection` and `createM12SupportReadBinding`
reference factories require explicit host enablement and selection. Importing
these factories or the `accountSupport` capability metadata registers no routes.
The metadata remains default-off with an empty route list and preserves the
static profile's refusal list. The existing R1 account facade is unchanged.

Hosts supply trusted principal ownership before account reads and administrator
or operator authorization through the Customer 360 facade before support reads.
The facade calls the binding authorization once per request, before any scope
opens; a refusal returns `{ kind: "denied" }` with no source IO. Native support search, counts
and snapshots use the existing PostgreSQL support scope; its actor governance,
redaction/audit behavior and guaranteed cleanup remain in force. Managed support
needs a selected host scope. Native account aggregate, order history/detail and
invoice history/PDF have no fabricated driver: missing selections report
`host_binding_required`. A selected M09 lane retains denied, unknown and
unsupported; an M08 unsupported alignment must never become an empty aligned
history. Invoice downloads first check the requested document in the owned
account/order history, before resolving its ticket or reading artifact bytes.
An absent document or mismatched history returns `{ kind: "denied" }`. This adds
one history read rather than equating invoice order references with order IDs.
Diagnostic history remains a separate authorized read, not commerce truth.
The selected diagnostic binding runs independently of any journey scope:
`searchDiagnostics`, `history` and `overview` delegate to its existing search,
segment and overview ports with their typed versions/cursors and the trusted
operator identity. The same actor governance runs before diagnostic scope entry;
the diagnostic transaction retains active-operator and atomic read-audit checks.
Reference order presentation picks only title, variant name, product slug,
display label and accent color, excluding private source fields at runtime.

The account/support view components are host-fed, unmounted and read-only.
They preserve last-known data during refresh and render absent enrichment as
unknown. Inline expansion uses only the order summary. Existing reference routes
still use their current source implementations; P7 owns any later route adoption.

## Customer diagnostic history preview

Moved to [Customer diagnostic history and retention](../../packages/core/docs/guide/how-to/operate/diagnostics-and-retention.md#select-the-diagnostic-bindings).

The diagnostic ingest and read bindings are application source mechanisms;
they are not automatically registered installed-package exports. Their owners
are the [history binding](../../server/runtime/observability/customerDiagnosticHistoryBinding.ts)
and [support read route](../../server/bff/admin/support/customer-diagnostics.ts).

### Retention drain

Moved to [Customer diagnostic history and retention](../../packages/core/docs/guide/how-to/operate/diagnostics-and-retention.md#retention-drain).

Evidence (historical record, 2026-11-13):

This remains a portable, default-off preview: the paired PostgreSQL migrations
describe the data contract, but do not provide an installer, host certification,
public MCP deployment, or production activation. Root discovery includes the
[prune runtime](../../server/runtime/observability/customerDiagnosticPruneRuntime.test.ts)
and [job](../../server/domains/observability/customerDiagnosticPruneJob.test.ts)
falsifiers; follow [testing](../../CONTRIBUTING.md#test-scope-and-diagnostics) for
execution. Second-runtime and deployed conformance remain separate adoption proof.

## Provider and host boundaries

Moved to [Run OpenLup on your own host](../../packages/core/docs/guide/how-to/operate/self-host.md#keep-provider-authority-at-the-host).

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
Default-off construction does no SDK/fetch/certificate work.

Communications server algorithms now delegate through the platform package. The
reference bindings still own the maintained HTTP mail provider egress/environment selection, origin defaults,
shared notification-control policy and the Auth renderer/observers. The existing
receipt transaction lane is passed through unchanged.

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

The transactional commerce and fulfillment renderers use the root
`#email-presentation` import as their default while retaining an explicit
presentation argument for callers. A host that changes the selection must
verify its server module resolution and rendered output. The public source
does not declare a managed serverless packaging rule for this alias.

Canonical production hostnames come from
`config/site-routes.json.productionHosts`. Configure this list for an adopting
deployment before enabling live Tpay settlement: every callback must use HTTPS
and an exact listed host, without redirects. The watchdog uses the same list to
detect preview emails linking to production. An empty list admits no live Tpay
callback and gives the email check no production domains to recognize. See the
[pending preview upgrade notes](../../.github/VERSIONING_AND_EOL.md#pending-preview-upgrade-notes-public-coordinates)
for the accompanying `OPENLUP_` configuration rename.

The maintained mail client owns its reference sink/drop policy and explicitly
registers that implementation. Provider tags and capture claims confer no
admission. The [transport contract](../../server/infra/email/README.md#contract)
owns reference wire/key semantics and local capture limits.

Evidence (historical record, 2026-11-13):

This rebinding
adds no route, schedule, activation or environment setting.

Unused root payment webhook verifiers, notification normalization and test-only
draft mappers have retired after production-importer checks. The shared HTTP
helpers and unrelated mapper/readiness tests remain. Opt-in package payment
adapters retain their implementations and witnesses; no host composition or
provider activation changes. The [retirement ledger](plans/oss-a2-payment-adapters.md#o-p3b-1-unused-root-retirement-2026-10-22)
records the exact root cases and remaining adopter leg.

This relocation adds no
provider SDK, deployment setting, route, scheduler or second outbox executor;
managed receipt service-scope and fixture construction remain in the reference
adapter.

## Preview posture

Moved to [Run OpenLup on your own host](../../packages/core/docs/guide/how-to/operate/self-host.md#keep-provider-authority-at-the-host).

Before maintainers make stable-framework claims, the release evidence must
establish a versioned release/BOM, a thin adopter application, conformance
coverage, upgrade tooling, public installation/build/test evidence and
compatibility proof.

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
