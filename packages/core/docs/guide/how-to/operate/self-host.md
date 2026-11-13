# Run OpenLup on your own host

Compose a host that serves your application, connects its durable data and runs
only the background work you select. Make the selected ports, configuration and
startup checks explicit before accepting traffic.

## Select the bundle

Pass `PLATFORM_BUNDLE` explicitly in the server environment. The available
identifiers are `node-postgres`, `node-supabase` and `vercel-supabase`; an absent
selection resolves to the last of these. Resolution also falls back for an
unknown value, but readiness refuses that value. Self-host bundles require
`APP_BASE_URL`. Selected scheduling requires `CRON_SECRET`, and Node scheduling
also requires `DATABASE_URL` for its cluster lock. Missing capability settings
are reported together as `OPENLUP_E_ENV_MISSING`. An unknown `PLATFORM_BLOB`
also refuses admission.

## Compose the host

Use `createBundleComposer` and `createNodeHost` from
`@openlup/platform/composition`. Supply the HTTP runtime, data, migration and
other ports your selected bundle needs. The host's `createHttpRuntime` dependency
receives the composed ports, declared scheduler jobs and a static asset reader;
your application supplies its routes, dispatcher and security policy.

The composer supplies a default blob binder. HTTP, scheduler, data, migrations,
analytics and transactional slots remain null until you supply their binders;
`createDataBindings` builds a data binder around your database client factory.
Pass the environment explicitly. Also supply the BFF not-found response,
preflight/per-request hooks, request-reference policy, health payload, exact or
rule-based entrypoints, job declarations and direct bindings, and any host
admission check. Ledger adapters need your release correlation and failure
messages; a custom migration source needs its catalogue, lock and inventory
projection. These values belong to your application.

Call the returned host's `serveNode` with its runtime `env`. It checks bundle
readiness and requires an HTTP port. For a listening PostgreSQL bundle with a
migration port, it awaits migration replay before host admission, HTTP runtime
construction and serving. A readiness or admission failure stops startup. Bind
the [database connections](connect-postgresql.md) for their respective work.

Build your browser application separately and make its output available to the
host. `distDir` selects the static root and defaults to `dist` in the process
working directory. The supplied reader prefers `spa-fallback.html`, then
`index.html`, for client-route fallback. With `createNodeHttpRuntime` from
`@openlup/platform/http`, explicitly declare prerendered and client routes:
unknown routes and missing assets return 404, and unknown API paths never fall
through to browser HTML. `port` and `host` options select the listener address.

## Declare HTTP admission

`createNodeHttpRuntime` applies your security headers first, then handles
trailing-slash redirects, the CSP report entrypoint, exact entrypoints, the BFF
router, path entrypoints, BFF dispatch, robots content and scheduled routes.
Unknown API paths return `NOT_FOUND` before legacy redirects, fallback
entrypoints or static documents. Your host supplies authorization, content
security policy, production-host policy, robots content and deadlines.

Buffered bodies expose the original bytes as an async iterable alongside the
parsed body, so signature verification does not depend on the route name.
The CSP report handler and exact entrypoints marked `rawStream: true` keep the
live stream instead. Buffered body overflow returns `REQUEST_BODY_TOO_LARGE`;
retain explicit body and deadline policies for stream-first handlers too.
Missing static assets return 404. Only declared documents and client-route
fallbacks may serve browser HTML.

## Supply configuration and storage

Pass sensitive configuration only to the server runtime. Browser-public values
are build inputs; do not embed database credentials, signing keys or provider
secrets in browser assets. Bind identity, storage, delivery and provider ports
for each capability you use.

For filesystem object storage, the default blob binder reads `BLOB_FS_ROOT` and
`BLOB_FS_BASE_URL`; both must be set or the port stays unbound. Keep durable
objects in the selected storage boundary separately from the built browser
assets. `PLATFORM_BLOB` selects an allowed storage override for the bundle.
The [configuration catalogue](https://github.com/openlup/openlup/blob/openlup-core-v0.40.0/config/environment-variables.json)
records registered keys; each selected adapter owns its additional runtime
inputs. Do not assume one deployment's environment is a package-wide contract.

Other `bindBlobPort` selections take these server inputs:

| Capability identifier | Settings and injected dependency |
| --- | --- |
| `s3` | `BLOB_S3_BUCKET`, `BLOB_S3_BASE_URL`; optional custom `s3ClientFactory` |
| `supabase` | `BLOB_SUPABASE_BUCKET` and a structural `supabaseStorageClient` factory |
| `vercel-blob` | `BLOB_READ_WRITE_TOKEN` and the injected `vercelBlob` module |

The default `s3` client reads `BLOB_S3_REGION`, `BLOB_S3_ENDPOINT`,
`BLOB_S3_FORCE_PATH_STYLE` and the paired `BLOB_S3_ACCESS_KEY_ID` /
`BLOB_S3_SECRET_ACCESS_KEY`. A single credential refuses with
`blob_s3_credentials_incomplete`. It loads the optional `@aws-sdk/client-s3`
peer on first storage use. Install that peer only when selecting this client.
Blob declarations use structural types and need no storage SDK types.

PostgreSQL adapters require the optional `pg` runtime peer and `@types/pg`
declarations. The scheduler lock also loads its driver on first operation.
Missing selected peers generally report `OPENLUP_E_PEER_MISSING` with the
package/capability and an install instruction; broken SDKs, missing transitive
dependencies and provider failures propagate unchanged. The qualified migration
runner has its [own module-loading boundary](../../upgrade/database-migrations.md#select-the-complete-catalogue).
Blob `exists` returns false for a failed HEAD, including a loading error; use
upload or list to observe a missing storage peer directly.

To use the composer's `supabase` binding, inject `createSupabaseClient`; it
uses data-gateway settings, the service-role key and disabled session
persistence/refresh. A blank `SUPABASE_URL` falls back to `VITE_SUPABASE_URL`.
Without that client the storage port remains unbound. A custom `blob` binder
overrides the default. Jobs and the HTTP runtime receive the composed blob port.

## Select background work

Supply `cron` to `serveNode` to register in-process timers. Use the deployment's
job declarations or an explicit `schedulerJobs` selection. A matching
`scheduledJobHandlers` entry runs directly; otherwise the host invokes the job's
HTTP entrypoint using its configured application base URL and cron bearer
secret. Ensure that entrypoint is mounted and reachable. Without `cron`, this
host registers no timers.

For transport-neutral jobs, pass `{ id, schedule, lease?, run }` values to
`createScheduledJobRegistry` from `@openlup/platform/scheduler`. Without contributions it returns an empty registry
and refuses duplicate IDs with `scheduled_job_duplicate:<id>`. Bind the
registry to the Node host to invoke `run` directly without an HTTP secret, or
use `createScheduledJobHttpEntry` behind the cron guard. A declared lease
requires a job-lease port: a claim held elsewhere skips work, and a refused
finish fails with `scheduled_job_finish_refused:<id>`.

`scheduledJobsFromContribution` converts cadence schedules only when an exact
cron expression exists; other cadences throw
`scheduled_job_cadence_unsupported:<seconds>`. A callable that reports a failed
outcome fails its job. Schedules are authored in UTC. When using
`createNodeScheduler` directly, set `timezone: "UTC"`; `createNodeHost` supplies
no timezone, so configure its scheduler process to use UTC. An optional
`schedulerProfile` can project declared jobs and validate admission before
registration.

Use a session-affine cluster lock when instances can overlap. The scheduler's
standalone fallback lock always grants and provides no cross-instance exclusion.
Bundle readiness also checks required scheduler configuration and reports missing
settings as `OPENLUP_E_ENV_MISSING`. Keep each
job's durable lease and replay behavior; a timer is not evidence that work
succeeded. Wire [diagnostic retention](diagnostics-and-retention.md) explicitly
if you collect that history, and install a shutdown handler that awaits
[the host drain](shutdown.md).

## Keep provider authority at the host

Select adapters explicitly and supply their credentials, outbound-access policy,
callback verification and payload mapping on the server. Store canonical
outcomes through the selected data ports; a provider response alone does not
establish a durable platform outcome. Importing a package or constructing an
inert binding does not mount application routes or activate providers.

A new mail network adapter must
compose `createGuardedEmailTransport` from
`@openlup/platform/communications` with an explicit host admission policy;
malformed or unknown admission decisions refuse with
`email_egress_policy_invalid` before sender entry.

This self-host recipe is for evaluation and carries no installation,
upgrade or host-support guarantee. Keep migration state, background-work policy,
storage ownership and required provider capabilities explicit; stop admission
when a required dependency is missing rather than substituting business behavior.
