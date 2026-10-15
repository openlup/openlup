# @openlup/platform

Development preview, unreleased. This package is private in this tree and is not published; the module's final pull request, in which the reference application composes it, makes it publishable. No stable API is claimed.

It holds the runnable server substrate an OpenLup application composes: the Node HTTP runtime, BFF dispatch, scheduling and job leases, blob storage, data gateways, the node-postgres migration runner and bundle composition. Ports and their contracts stay in `@openlup/core/platform-runtime`.

## Package surface

| Export | Contents |
| --- | --- |
| `./http` | Node request adaptation, deadlines, security headers and static documents, and `createNodeHttpRuntime` with its fixed request order |
| `./bff` | `createBffDispatcher`, `lazyBffRoute`, the hosted router URL rewrite, the response envelope (`createBffResponder`), the observed request context and the health route |
| `./scheduler` | Job registry, node-cron scheduler with per-job advisory locks, hosted cron verification, the cron entrypoint guard and direct job bindings |
| `./blob` | Filesystem, S3-compatible, Supabase Storage and Vercel Blob adapters, and `bindBlobPort` |
| `./data` | Supabase and node-postgres data gateways, the role-free transaction lane, the query builder and the data bindings |
| `./migrations` | The node-postgres `MigrationRunnerPort` |
| `./job-ledger` | The job-run ledger port, its PostgreSQL and managed (Supabase) adapters, the managed v2/v3 compatibility calls and the location of its SQL |
| `./kernel` | The bundle identifiers, descriptors and readiness |
| `./composition` | `createBundleComposer`, the Node HTTP binding helpers and `createNodeHost` |

## What the application supplies

The package carries no deployment identity. The application passes it every value that names a deployment or a domain:

- the BFF route table, the not-found response, the request preflight and the per-request hook;
- how a request reference is chosen, and the health payload with its strict contract;
- the security header policy, including the content security policy, the production hosts and the robots.txt body;
- its own entrypoints, by exact path or by path rule;
- the job configuration file or object, the direct job bindings and the host admission check;
- the migration catalogue, the migration lock name and the object-inventory projector;
- the release correlation, default failure reason and read-failure messages that the job-run ledgers record;
- the environment, passed explicitly, and the provider clients it needs (the Supabase `createClient`, the `@vercel/blob` module, optionally its own PostgreSQL gateway factory), so the package itself reads no environment variable (an injected SDK may read its own credentials; the static and migration roots default to the working directory) and imports no provider SDK except the optional `pg` peer, whose types its PostgreSQL declarations use;
- an optional scheduler profile for the Node host: a fenced projection of the declared jobs with its own bindings and validation hooks.

`createBundleComposer` binds the blob slot by default; without injected clients that binds only the filesystem backend. The HTTP, scheduler, data, migrations, analytics and transactional slots stay `null` until the application supplies their binders; `createDataBindings` builds the data binder from the application's database client factory.

## Job-run ledger SQL

`JOB_RUN_LEDGER_MIGRATIONS` lists the two files a fresh installation applies, in order, through its own migration chain:

1. [`sql/20260809150000_job_run_ledger.sql`](sql/20260809150000_job_run_ledger.sql): the job controls, runs, and the v2 claim and finish; its bytes and migration identity equal the reference application's platform migration of that name.
2. [`sql/20260809150001_job_run_ledger_v3.sql`](sql/20260809150001_job_run_ledger_v3.sql): the v3 claim and finish the PostgreSQL ledger calls, as `CREATE OR REPLACE`, with bodies byte-equal to the reference chain's definitions.

The package SQL and the reference application's platform migration chain are alternative install paths, never applied together: the reference chain defines all four job-control functions itself, with plain `CREATE FUNCTION`, so it fails on a database where the package SQL already created them. The package file `20260809150001_job_run_ledger_v3` has a migration identity no reference migration uses. Importing the package never applies SQL.

## Verification

This package's tests are part of the repository's required test selection; from this directory, `npm test` runs them alone. The tests rewrite the originating application's characterization with neutral names and synthetic data, and a boundary test refuses any environment read or provider import in the package source.
