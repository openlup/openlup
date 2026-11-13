# Production checklist

Review the serving application and its selected bindings before admitting
traffic. OpenLup is a development preview and does not offer a supported
production installation; this checklist is not a support promise. Read
[Versioning and stability](../../reference/stability.md) and the [current
limits](../../reference/limits.md) before choosing an installation path.

## Before serving traffic

- [ ] **Verify the package set.** Follow [Verify the published packages](verify-published-packages.md)
  for each installed package, comparing verified provenance and tarball integrity
  with the intended release and source commit. Keep the application on the exact
  package set you verified; a successful source build alone establishes no
  release guarantee.
- [ ] **Check configuration and admission.** Select the bundle and bind its
  required ports using [Run OpenLup on your own host](self-host.md#compose-the-host).
  Review [configuration keys](../../reference/configuration.md) and the selected
  adapters' inputs, keeping sensitive values in the server runtime. Require the
  composed readiness and host admission checks to pass before listening.
- [ ] **Check connections and grants.** Follow [Connect to PostgreSQL](connect-postgresql.md)
  for request, migration and session-lock connections. Use the selected
  installation's restricted runtime login for requests and scheduler locks;
  keep migration/admin credentials on the migration connection.
- [ ] **Check schema and recovery.** Follow [Upgrade the database](../../upgrade/database-migrations.md)
  to inspect the complete selected catalogue, apply its pending suffix and
  confirm status. Check application compatibility with the resulting schema,
  and [test restoring a backup](../../reference/stability.md#upgrades) before
  an upgrade; application rollback does not undo committed SQL.
- [ ] **Check request security.** Follow [Harden a deployment](security-hardening.md)
  and [Identity](../../concepts/identity.md) to bind authentication,
  authorization, origins and HTTP policy. Check the actual mounted routes;
  selecting a package or bundle does not supply application authorization.
- [ ] **Check providers.** Follow [Compose a provider adapter](../extend/provider-adapters.md)
  and [Run an adapter conformance check](../extend/adapter-conformance.md).
  Select only capabilities the adapter implements, supply credentials and
  outbound admission, and verify callback signatures over untouched bytes.
  An offline conformance result does not certify a live provider account.
- [ ] **Check background work and locks.** Explicitly select jobs and their
  handlers or reachable guarded HTTP entrypoints using [background-work
  composition](self-host.md#select-background-work). Check UTC scheduling,
  session-affine cluster locking, durable leases and replay behavior; a timer
  registration does not establish successful work. For outbox dispatch, follow
  [handler effect ownership](../../concepts/idempotency.md#handler-effects-across-retries).
- [ ] **Check retained data.** If collecting diagnostics, configure and enable
  both collection admission and the [retention drain](diagnostics-and-retention.md#retention-drain),
  then inspect the job-run ledger and deletion summary. Register the [personal-data
  contributors](../../concepts/personal-data.md#personal-data-coverage) for the
  capabilities you use and supply their retention decisions; identity erasure
  does not discharge every owner's obligations.
- [ ] **Check shutdown.** Install a handler that awaits the [host drain](shutdown.md)
  before disposing application-owned pools and transports. Keep dependencies
  available to admitted callbacks and handle a rejected stop as a shutdown
  failure.

Use [capability maturity](../../reference/maturity.md), [exports](../../reference/exports.md)
and [refusal codes](../../reference/refusal-codes.md) when assessing the selected
composition.
