# Customer diagnostic history and retention

Enable customer diagnostic collection only with an operating retention drain and
authorized reads. Use the retained observations to investigate what the browser
saw; they do not establish payment, delivery or other business outcomes.

## Select the diagnostic bindings

The [diagnostic source binding](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/server/runtime/observability/customerDiagnosticHistoryBinding.ts)
and its browser reporter require explicit composition in your application. Their
configuration below belongs to those bindings; installing packages does not
automatically mount their routes or timers.

The ingest schema accepts a closed vocabulary of transactional, sign-in and
account observations, with no arbitrary metadata or raw form values. The server
attaches canonical principal and customer identifiers only after authentication;
observations without authentication remain anonymous. The browser stores its
opaque segment credential in `sessionStorage`, with an in-memory fallback, for
correlation in the current tab.

## Configure collection

Collection is off unless explicitly enabled on both sides.

| Input | Set for the selected source binding |
| --- | --- |
| Browser build | `VITE_COMMERCE_CUSTOMER_DIAGNOSTIC_HISTORY_ENABLED=true`. Rebuild the browser assets when changing this selection. |
| Server ingest | `COMMERCE_CUSTOMER_DIAGNOSTIC_HISTORY_ENABLED=true`. |
| Retention | `CUSTOMER_DIAGNOSTIC_RETENTION_DAYS`: an integer from 1 to 90. |
| Ingress signing | `CUSTOMER_DIAGNOSTIC_INGRESS_KEY`: a server-only HMAC key of at least 32 characters after trimming. |
| Public origin | A nonblank `APP_BASE_URL`, falling back to `SITE_URL`. Use an HTTP(S) origin without credentials, a path beyond the root, query or fragment. |
| Data | `DATABASE_URL` for the PostgreSQL lane, or the selected managed data adapter's server configuration. |

Before allowing retained ingest, also enable the prune flag and its control row
described below. A disabled, absent or unreadable control row refuses ingest.
Missing retention, key, origin or data configuration also fails closed through
`customer_diagnostic_history_configuration_invalid`; the HTTP ingest handler
returns `UPSTREAM_UNAVAILABLE`. A foreign or missing request Origin produces
`customer_diagnostic_origin_invalid` internally and `FORBIDDEN` over HTTP. The
binding accepts the configured origin or the request's own served origin; keep
host and forwarded-origin handling within your trusted deployment boundary.

Browser delivery is best effort. A timeout can follow a committed write; it is
an unknown outcome and the reporter does not retry it as an absent write.

## Authorize reads

The source support route requires administrator authorization, and database
reads require an active operator and an access-audit write in the same
transaction. An audit failure returns `UPSTREAM_UNAVAILABLE`, with reason
`audit_unavailable`, rather than partial data. Machine reads additionally require
`COMMERCE_AGENT_CUSTOMER_READ_ENABLED=true`; that flag does not grant human or
machine authorization by itself.

For the global overview, set `x-contract-version` to
`customer-diagnostic-history.v2` and request `mode=overview`. Its time window is
bounded; a wider window is refused with
`customer_diagnostic_overview_invalid`. It groups retained observations by coverage
version and action, returning closed classifications and a small, bounded number
of opaque example segment IDs per bucket. The explicit read contract can include both coverage versions;
the default older read contract retains its older views. Treat observation gaps
and unavailable history as unknown, and keep database access and incident policy
under host control.

## Retention drain

Retention physically deletes rows through `customer-diagnostic-prune`; read-side
expiry filtering alone does not remove stored history.

1. Install the diagnostic data and job-control schema required by your selected
   lane. The prune control row is seeded disabled.
2. Set `COMMERCE_CUSTOMER_DIAGNOSTIC_PRUNE_ENABLED=true` and the same valid
   `CUSTOMER_DIAGNOSTIC_RETENTION_DAYS` used by collection.
3. Explicitly enable `platform_job_controls.enabled` for
   `job_name = 'customer-diagnostic-prune'`, retaining `active_driver = 'worker'`.
4. Arrange a trusted timer to invoke the
   [retention runtime](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/server/runtime/observability/customerDiagnosticPruneRuntime.ts).
   For Node, explicitly declare the job and bind its direct handler through
   `scheduledJobHandlers`. Alternatively mount the
   [HTTP handler](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/api/cron/customer-diagnostic-prune.ts)
   at `/api/cron/customer-diagnostic-prune` and have an external timer send `POST`
   with `Authorization: Bearer <CRON_SECRET>`.
5. Inspect the job-run ledger and deletion summary. A disabled flag returns
   `mutations_disabled`; a disabled control row refuses the claim with
   `job_disabled`. An HTTP success can be a skip, so check the response body.

The runtime configuration supplies no default cron registration. The prune flag
is independent of ingest: leave deletion enabled when stopping collection so
already-stored history can still expire. Existing event expiry timestamps do
not change when you change the retention setting; newly inserted events use
the new value.

The job deletes expired events and access-audit rows, aged admission buckets and
expired segments with no remaining events, in bounded batches. A durable
job-control lease excludes a concurrent runner; a scheduler advisory lock is
not a substitute. The standalone Node scheduler's fallback lock always grants;
the Node bundle readiness check requires scheduler connection configuration.
Follow the
[PostgreSQL connection recipe](connect-postgresql.md) when using session locks.

On the PostgreSQL lane, claim, individual batches and finish commit separately.
A crash leaves committed deletions intact; a later lease-admitted pass safely
continues the remaining work. `morePossible` in the summary means another pass
may be needed. A failed drain returns `customer_diagnostic_prune_failed`.

For a frequently ticking external backstop, set `x-openlup-cron-backstop` to
`freshness`. A sufficiently recent successful drain returns `primary_fresh`
without claiming another run. An unavailable freshness read returns
`customer_diagnostic_prune_backstop_unavailable`; an unknown backstop value
returns `invalid_customer_diagnostic_prune_backstop`. Invocation-source labels
record how a call arrived and grant no authority. A caller without a recognized
source is recorded as `unattributed_post`; the cron bearer check still applies.
