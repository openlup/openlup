# Runtime And Self-Hosting

Status: development-preview contract. No recipe in this document is a supported production deployment or a stable installer promise.

## Runtime model

The platform separates browser delivery, a server-side application boundary, background work, durable data, and provider adapters. A host may choose how to run those pieces, but it must preserve the platform contracts: authenticated
requests reach the server boundary, durable writes use the canonical data
contract, scheduled work is observable and replay-safe, and provider adapters
remain explicit selections.

Browser-public configuration is build-time input. Sensitive server configuration
is runtime-only input and must not be embedded in a browser artifact. Hosts must
provide their own storage, identity, delivery, and provider configuration where
the selected capabilities require it.

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

The default public reference remains a static, read-only site. An evaluator may
explicitly select a separate local Node + managed Supabase subscription profile
to exercise one synthetic recurring purchase, captured payment settlement,
confirmed local sign-in, own account readback and a renewal-date action. The
profile uses a closed route set and loopback origin; it does not start a worker,
external payment provider, external mail service or full self-hosted platform.
See [Evaluate a subscription account](SUBSCRIPTION_REFERENCE.md) for the exact
setup, server command, operator setup and verification boundary.

The setup requires a new owned directory, unique project id and free ports. It
replays the managed baseline with its two explicit local prerequisites and
seeds only synthetic catalog, price, inventory and settlement settings. A
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

Provider SDKs, sensitive material, signatures, and wire formats remain behind
adapters. The platform stores canonical outcomes and may preserve sanitized
provider evidence, but a provider response is not itself the platform's durable
truth. Hosts can add adapters only through the contracts in
[Architecture and extensions](ARCHITECTURE_AND_EXTENSIONS.md) and
[Canonical contracts](CANONICAL_CONTRACTS.md).

## Preview posture

Development-preview source may be evaluated, but it is not a stable release,
an upgrade channel, or a supported self-host commitment. `P1-SF` must establish
a versioned release/BOM, a thin adopter application, conformance coverage,
upgrade tooling, public installation/build/test evidence, and compatibility
proof before those claims are available.
