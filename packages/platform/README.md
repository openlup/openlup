# @openlup/platform

Development preview. This package joins core and outbox in the publishable set from the next set version; this configuration does not establish a registry release or a stable API. Its repository-directory publish command refuses publication; the authorized package-release workflow owns publication.

It holds the runnable server substrate an OpenLup application composes: the Node HTTP runtime, BFF dispatch, scheduling and job leases, blob storage, data gateways, the node-postgres migration runner and bundle composition. Ports and their contracts stay in `@openlup/core/platform-runtime`.

## Package surface

`release-gates.json` declares kind `rail`: this foundation provides runtime infrastructure over core ports, matching the architecture's rail responsibility. Its eleven experimental entries each bind a declaration snapshot and package-owned smoke tests. The API checker reads this same inventory.

| Export | Contents |
| --- | --- |
| `./http` | Node request adaptation, deadlines, security headers and static documents, and `createNodeHttpRuntime` with its fixed request order |
| `./bff` | `createBffDispatcher`, `lazyBffRoute`, the hosted router URL rewrite, the response envelope (`createBffResponder`), the observed request context and the health route |
| `./scheduler` | Transport-neutral scheduled jobs (`ScheduledJob`, the job registry, the lease-aware runner and the authenticated HTTP cron entry), path-declared jobs from configuration, the node-cron scheduler with per-job advisory locks, hosted cron verification, the cron entrypoint guard (it compares the presented bearer token with `CRON_SECRET` in constant time) and direct job bindings |
| `./blob` | Filesystem, S3-compatible, Supabase Storage and Vercel Blob adapters, and `bindBlobPort` |
| `./data` | Supabase and node-postgres data gateways, the role-free transaction lane, the query builder and the data bindings |
| `./migrations` | The node-postgres `MigrationRunnerPort` |
| `./job-ledger` | The job-run ledger port, its PostgreSQL and managed (Supabase) adapters, the managed v2/v3 compatibility calls and the location of its SQL |
| `./kernel` | The bundle identifiers, descriptors and readiness |
| `./composition` | `createBundleComposer`, the Node HTTP binding helpers and `createNodeHost` |
| `./identity` | Experimental capability: identity engine, authorization, profile readers, session adapters and BFF factories |
| `./identity/contracts` | Experimental capability: browser-safe customer auth port, value types and provider parser |

## Scheduled jobs

A job is `{ id, schedule, lease?, run(context) }` with a UTC cron expression. Domains and packages contribute jobs to `createScheduledJobRegistry`, which refuses duplicate ids and ships empty. The Node host runs registry jobs on its own timers and calls `run` directly, with no HTTP request and no secret. `createScheduledJobHttpEntry` mounts the same job behind the cron guard for a hosted cron. A job that declares `lease` runs only after the injected job-lease port grants it; a lease held elsewhere skips the run, and a finish the port refuses fails the run. `scheduledJobsFromContribution` turns a contribution's cadence schedules into jobs and refuses a cadence that no cron expression matches exactly; a contribution run that reports a failed outcome fails the job.

## Bundle readiness

`PLATFORM_BUNDLE` selects `vercel-supabase` (the default when absent), `node-supabase` or `node-postgres`. A bundle's readiness refuses, before any traffic or timer: an unknown `PLATFORM_BUNDLE` (resolution itself still falls back to the default); a self-host bundle without `APP_BASE_URL`; and, reported together under `OPENLUP_E_ENV_MISSING`, every selected capability without its settings: the scheduler without `CRON_SECRET`, Node scheduling without `DATABASE_URL` for its cluster lock (never a silent single-instance lock), and the selected blob capability without its settings (see Blob storage). An unknown `PLATFORM_BLOB` is refused too. The Node host checks readiness at boot.

## Blob storage

`PLATFORM_BLOB` selects the blob capability; without it the bundle's own applies (filesystem for node-postgres, the local development default). `bindBlobPort` builds each one from the environment and the clients the application injects:

- `filesystem`: `BLOB_FS_ROOT`, `BLOB_FS_BASE_URL`;
- `s3`: `BLOB_S3_BUCKET`, `BLOB_S3_BASE_URL`, and a default client from `createS3ClientFromEnv` (`BLOB_S3_REGION`, `BLOB_S3_ENDPOINT`, `BLOB_S3_FORCE_PATH_STYLE`, `BLOB_S3_ACCESS_KEY_ID` with `BLOB_S3_SECRET_ACCESS_KEY`). `@aws-sdk/client-s3` is an optional peer loaded on first use, so only an application that selects S3 installs it;
- `supabase`: `BLOB_SUPABASE_BUCKET` and `BlobBindingDeps.supabaseStorageClient`, a factory returning the structural `SupabaseStorageClient` declared in blob. Blob itself reads no data-gateway settings. The default composer supplies this factory from the data-gateway settings and its optional `createSupabaseClient` dependency, using the service-role key with `persistSession: false` and `autoRefreshToken: false`. For this binding, a blank `SUPABASE_URL` falls back to `VITE_SUPABASE_URL`, consistently with readiness;
- `vercel-blob`: the injected `@vercel/blob` module and `BLOB_READ_WRITE_TOKEN`.

The Node host passes the composed ports, blob storage included, to the HTTP runtime builder and to the jobs contributed to it. The reference repository's compose file starts a local S3-compatible service with `--profile local-storage`; missing storage credentials refuse at service startup, while an omitted `OBJECT_STORAGE_PORT` selects an ephemeral loopback port. The inactive profile requires no storage settings. A conformance test runs upload, read-back, delete and access refusal against that image; initialization failure with Docker available fails the test. Hosted S3 provider certification is not claimed.

## What the application supplies

The package carries no deployment identity. The application passes it every value that names a deployment or a domain:

- the BFF route table, the not-found response, the request preflight and the per-request hook;
- how a request reference is chosen, and the health payload with its strict contract;
- the security header policy, including the content security policy, the production hosts and the robots.txt body;
- its own entrypoints, by exact path or by path rule;
- the job configuration file or object, the direct job bindings and the host admission check;
- the migration catalogue, the migration lock name and the object-inventory projector;
- the release correlation, default failure reason and read-failure messages that the job-run ledgers record;
- the environment, passed explicitly, and the provider clients it needs (the Supabase `createClient`, the `@vercel/blob` module, optionally its own PostgreSQL gateway factory), so the package itself reads no environment variable (an injected SDK may read its own credentials; the static and migration roots default to the working directory). Its optional SDK peers are `pg`, whose types its PostgreSQL declarations use, and `@aws-sdk/client-s3`, loaded lazily by the default S3 client. Blob declarations use structural types and need no S3 SDK;
- an optional scheduler profile for the Node host: a fenced projection of the declared jobs with its own bindings and validation hooks.

`createBundleComposer` binds the blob slot by default; pass `createBundleComposer({ createSupabaseClient })` to enable its Supabase Storage binding when the data-gateway settings and bucket are present. Without that client Supabase Storage stays unbound. A custom `blob` binder still overrides the default. The HTTP, scheduler, data, migrations, analytics and transactional slots stay `null` until the application supplies their binders; `createDataBindings` builds the data binder from the application's database client factory.

## Job-run ledger SQL

`JOB_RUN_LEDGER_MIGRATIONS` lists the two files a fresh installation applies, in order, through its own migration chain:

1. [`sql/20260809150000_job_run_ledger.sql`](sql/20260809150000_job_run_ledger.sql): the job controls, runs, and the v2 claim and finish; its bytes and migration identity equal the reference application's platform migration of that name.
2. [`sql/20260809150001_job_run_ledger_v3.sql`](sql/20260809150001_job_run_ledger_v3.sql): the v3 claim and finish the PostgreSQL ledger calls, as `CREATE OR REPLACE`, with bodies byte-equal to the reference chain's definitions.

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

This package's tests are part of the repository's required test selection; from this directory, `npm test` runs them alone. The tests rewrite the originating application's characterization with neutral names and synthetic data, and a boundary test refuses any environment read or provider import in the package source.

The module-boundary proof permits one optional `./<module>/contracts` export
only when that module declares `contracts: true` in `PLATFORM_MODULE_GRAPH` in
[`eslint.config.js`](../../eslint.config.js). Its `types`, `import` and `default`
targets follow the module entry shape at `dist/<module>/contracts/index`.
Contracts files may import only their own contracts subtree through canonical
relative `.js` paths and exact public `@openlup/core` entries. Both ESLint and
[`packageBoundary.test.ts`](test/packageBoundary.test.ts) enforce this allowlist
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

`npm run api:check` compares each of the eleven declaration entry graphs with the
committed `api/*.api.md` reports. After building, deliberately regenerate them
with `node --experimental-strip-types ./scripts/api-contract.ts --update` from
this package, and review the declaration changes.

The source-checkout binding `npm run test:consumer` runs
[`platform-cold-consumer.ts`](../../scripts/packages/platform-cold-consumer.ts).
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
lockfile's exact versions using `npm install --prefer-offline --no-audit --fund=false`
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

The composition declarations describe the injected Supabase factory structurally;
they do not import the data entry or its PostgreSQL types. The cold proof still
requires all six nonadapter entries (including `./identity/contracts`) to import in fresh processes and compile
in both resolution modes with all three optional peers absent.

<!-- openlup-doc-impact {"unit":"platform-substrate","digest":"sha256-00994d288cfec0c8dc0ae9aeae2ff542e2e9af2fedcb4dd2dfeb6c99523be92d","reason":"The manifest moves to the 0.15.0 set version with the exact @openlup/core 0.15.0 peer pin. The package surface, settings and verification described here are unchanged by this preparation delta."} -->

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
its cached pinned issuer and local prerequisites; the [OIDC recipe](../../docs/platform/IDENTITY.md#real-issuer-oidc-recipe)
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
explicit bootstrap/prune commands in the [identity guide](../../docs/platform/IDENTITY.md#direct-human-login).
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
See the [identity policy and migration](../../docs/platform/IDENTITY.md#responsibility-and-composition)
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
[identity owner page](../../docs/platform/IDENTITY.md). Both entries remain an
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
[identity redirect contract](../../docs/platform/IDENTITY.md#magic-link-redirect-policy)
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
[identity lifecycle owner](../../docs/platform/IDENTITY.md#operator-invitation-lifecycle).

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
operator/customer batches. See [identity privacy](../../docs/platform/IDENTITY.md#identity-personal-data)
for refusals, token limits and retained obligations.

The complete direct conformance is included in
`ai-resource-gate run --wait openlup:coverage -- npx vitest run tests/postgres/operatorIdentityUpgrade.test.ts`.
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
[composition contract](../../docs/platform/IDENTITY.md#responsibility-and-composition).

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
[identity reference guide](../../docs/platform/IDENTITY.md#disposable-identity-reference)
for both-bundle commands, the committed managed grants and installation limits.

## Package artifact limits

The monorepo's package artifact checker enforces this package's
`release-gates.json` caps, compressed release growth explanations and packed
content allowlist. Its browser-safe `./identity/contracts` export also has a minified+gzip cap. See the
[package artifact policy](https://github.com/openlup/openlup/blob/main/.github/VERSIONING_AND_EOL.md#package-artifact-limits)
for measured sizes, current caps, the S1 baseline refresh and refusal remedies.
Artifact checks require a clean package directory; `--manifest-only` supplies no
artifact evidence.
