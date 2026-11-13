# Run OpenLup on your own host

Compose a host that serves your application, connects its durable data and runs
only the background work you select. Make the selected ports, configuration and
startup checks explicit before accepting traffic.

## Compose the host

Use `createBundleComposer` and `createNodeHost` from
`@openlup/platform/composition`. Supply the HTTP runtime, data, migration and
other ports your selected bundle needs. The host's `createHttpRuntime` dependency
receives the composed ports, declared scheduler jobs and a static asset reader;
your application supplies its routes, dispatcher and security policy.

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

## Supply configuration and storage

Pass sensitive configuration only to the server runtime. Browser-public values
are build inputs; do not embed database credentials, signing keys or provider
secrets in browser assets. Bind identity, storage, delivery and provider ports
for each capability you use.

For filesystem object storage, the default blob binder reads `BLOB_FS_ROOT` and
`BLOB_FS_BASE_URL`; both must be set or the port stays unbound. Keep durable
objects in the selected storage boundary separately from the built browser
assets. `PLATFORM_BLOB` selects an allowed storage override for the bundle.
The [configuration catalogue](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/config/environment-variables.json)
records registered keys; each selected adapter owns its additional runtime
inputs. Do not assume one deployment's environment is a package-wide contract.

## Select background work

Supply `cron` to `serveNode` to register in-process timers. Use the deployment's
job declarations or an explicit `schedulerJobs` selection. A matching
`scheduledJobHandlers` entry runs directly; otherwise the host invokes the job's
HTTP entrypoint using its configured application base URL and cron bearer
secret. Ensure that entrypoint is mounted and reachable. Without `cron`, this
host registers no timers.

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
