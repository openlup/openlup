# Connect to PostgreSQL

Separate request traffic, schema administration and scheduler locks before
starting a PostgreSQL host. Choose both the connection transport and the
database principal for each kind of work.

## Assign connections by work

| Work | Connection | Composition |
| --- | --- | --- |
| Requests | A bounded `pg.Pool` using the installation's restricted runtime login. A transaction-mode pooler is suitable only when all state is transaction-local. | `createPostgresDataGateway({ connectionString: requestConnectionString })` from `@openlup/platform/data`; use its `poolFactory` option when supplying your own bounded pool. Capability-local transaction lanes remain separate selections. |
| Migrations and privileged administration | The direct database endpoint, bypassing external poolers, with the selected migration/admin principal. | Give the migration runner its own `{ connectionString: directConnectionString }` and return that runner from the `migrations` binder of `createBundleComposer` in `@openlup/platform/composition`. |
| Scheduler jobs with session advisory locks | One dedicated runtime-login session through a direct endpoint or a session-mode pooler. | Pass `createPgAdvisoryLock(client)` from `@openlup/platform/scheduler` as `serveNode({ advisoryLock, ... })`. Alternatively, construct the lock with `createEnvAdvisoryLock({ DATABASE_URL: sessionConnectionString })` and inject it in the same option. |

The request gateway leases a client for each transaction, commits or rolls back,
then releases it. The migration runner also uses a local pool, but holds one
client through the entire migration operation and its session advisory lock.
That local pool does not make an external transaction-mode pooler suitable for
migrations.

The default environment resolvers for the gateway, migration runner and advisory
lock read `DATABASE_URL`; they do not discover separate endpoints. If request
traffic uses a transaction-mode pooler, bind the direct migration connection and
dedicated lock connection explicitly. Creating a `pg.Client` against the request
pooler's URL does not give it session affinity: acquire and release must reach
the same PostgreSQL backend.

When the listening Node host selects PostgreSQL and has a migration port, it
awaits that port's `apply()` before serving. Keep the dedicated scheduler session
alive until [host shutdown](shutdown.md) completes. Never supply `Pool.query` or
a transaction-mode pooler to the session-lock adapter.

## Preserve role separation

Use the principals and grants required by the selected installation. The runtime
login is for requests and scheduler locks; migration/admin credentials belong to
the migration connection. Changing an endpoint or pool mode does not change
database privileges or make a runtime login a migration administrator.

The gateway's actor calls set transaction-local claims and select `authenticated`
or `anon`; service calls select `service_role`. Capability-local role-free lanes
do not change roles and must remain scoped to their named capability. Do not
replace missing grants with an owner login in request handling.

## Recover from a session-affinity refusal

Before admitting a locked callback, the adapter acquires the advisory key, then
checks the backend PID and ownership of that exact key in a separate statement.
The adapter reserves the numeric key locally before acquisition, so pending or
held grants also exclude reentry on the same session. Distinct job IDs can
share a hashed key and therefore exclude one another. Ordinary contention
releases the local reservation; uncertain acquisition retains it and refuses
further grants until disposal. Release requires an actual unlock on the same
backend; a failed unlock retains the reservation too.

A changed PID, missing ownership or uncertain acquisition produces
`OPENLUP_E_ADVISORY_SESSION_AFFINITY`. The callback does not start, and later
acquisitions on that adapter are refused. Release also checks the backend PID
and refuses a missing grant.

1. Drain the host and await its `stop()` result, keeping callback dependencies
   available during the drain.
2. Close the dedicated lock connection. Investigate and retire the specific
   lock backend if a misconfigured pooler stranded it; do not force an unlock on
   an unrelated backend.
3. Correct the transport to a direct connection or session-mode pooler, then
   restart with a fresh lock adapter.

The refusal leaves the session open for already-admitted jobs to drain. A passing
check cannot certify future pooler routing or fence a job whose connection fails
after admission. Retain durable job leases, idempotency and protection against
stale executors making external effects.
