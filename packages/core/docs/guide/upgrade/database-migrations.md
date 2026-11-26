# Upgrade the database

Apply your selected packages' database changes without altering installed
history or application data. Check compatibility before applying a forward.

## Follow the additive forward path

Append forwards in catalogue order. Preserve the baseline and every applied
unit without splitting, renaming, reordering or editing them. Never relabel
old SQL as new. Fresh installs apply the baseline first. Matching installs
apply only pending forwards. The runner offers no down migrations.

The catalogue pins each file's canonical path and SHA-256. Before applying
SQL, the runner rejects missing or unlisted files, duplicate identities,
changed bytes and any history that differs from the selected prefix by path,
digest or position. Repair with a compatible forward that preserves the prefix.

Release admission allows bounded object creation, table additions and literal,
idempotent seeds. It rejects destructive operations, renames, schema moves,
ownership transfers, writes to the application-owned `app` schema, procedural
or dynamic SQL and unsupported expressions. Verify application compatibility
and installed history separately. Other changes need their own compatibility
path.

For an application-owned chain, compare its schema and applied identities with
the selected catalogue and prepare compatible forwards. Use the package baseline
for new installs. The runner refuses mismatched ledgers.

## Select the complete catalogue

Use `createPlatformPostgresMigrationRunner` from `@openlup/platform/migrations`.
The complete catalogue and SQL resolve within the installed package without a
source checkout. Install the optional `pg` peer. Without it, `legacy` reports
`OPENLUP_E_PEER_MISSING` and qualified installs report the module-loading error.

Supply an explicit `installation` selection: `legacy`, `qualified-v2` or
`qualified-admin`, with the selected profile's role bindings. Omitting it
refuses with `platform migration installation is required`. Keep the
generation that owns your installed history; selecting another generation
does not convert it. Provision the matching host roles and use a direct
PostgreSQL connection that retains one session for the migration operation.
Both qualified selections accept `roleMode: "installer-managed"` or
`"operator-provisioned"`, with `migrationLogin`, `bootstrapLogin` and
`runtimeLogin`. The restricted `qualified-admin` selection also requires
`restoreLogin` and, in operator-provisioned mode, a distinct `operatorLogin`.
The privileged `qualified-v2` selection permits an optional restore login.
Provision the migration, bootstrap, runtime and any required restore or operator
logins before invoking the runner. The [connection role guidance](../how-to/operate/connect-postgresql.md#assign-connections-by-work)
describes the prerequisites.

For a `qualified-v2` plan containing the catalogue publication forward,
installer-managed mode creates `openlup_catalog_publication` automatically.
In operator-provisioned mode, create that login before applying the forward.
Use `LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
with no memberships or owned objects. The forward assigns its catalogue grants
and policies. Supply a private credential to the catalogue host connection
when enabling it. The demonstration installer manages the credential with
`./lifecycle up`. If the runner reports `catalog_publication_login_missing`,
restore the restricted login and its reviewed grants from the installation
before starting the host.

The factory also accepts a `poolFactory`, a custom `catalog` reader, its `root`
and a `catalogProjectionPayload` callback. These are trusted host inputs. A
custom pool factory owns startup options and pool lifetime; a custom catalogue
does not bypass manifest or history checks. Use the lower-level
`createPostgresMigrationRunner` when supplying the complete source/options API.
Imports perform no installation; call the returned methods explicitly.

Before a fresh `legacy` installation, `inspectLegacyPostgresInstallRoles` from
`@openlup/platform/lifecycle` reads the legacy bootstrap's role prerequisites
through a query handle you supply and reports blockers such as
`legacy_bootstrap_requires_superuser`. Even `rolePrerequisitesMet: true` does not establish
install readiness, runtime grants, pooling or host support; the helper only
reads, creates no role or schema and runs no installer.

Module descriptors list subsets of the SQL. Install the full selected
catalogue with its dependencies and preserve its prefix.

`JOB_RUN_LEDGER_MIGRATIONS` lists the base ledger and claim/finish replacements.
Use those assets in your complete chain or use the catalogue that defines them.
Applying both attempts to recreate functions and fails. Importing
`@openlup/platform/job-ledger` applies no SQL.

## Reconcile stale native renewals

For upgrades from Platform 1.3.0, keep provider evidence intake available
throughout this procedure.

1. Pause and drain every dispatch entry point for the affected population.
   Include the renewal worker, retry driver, and any custom renewal or retry dispatch.
2. Apply the bundled PostgreSQL forward and confirm it is applied.
3. Run the report below on one authorized server-side PostgreSQL session with
   renewal read privileges. Use the installation owner where there is no runtime role.
4. Verify each reported operation has a recorded disposition before resuming
   dispatch for it. Use the operation ID to re-read current operation, reservation,
   intent, retry and provider evidence as applicable. Save the cut and dispositions
   in your restricted upgrade record. Refer unresolved roots to the subscription
   owner and waiting retries to the payment recovery owner.
5. Resume eligible dispatch through the usual scheduler after reconciliation.
   Keep affected work paused while any unresolved stale obligation can dispatch.

Use the first report result to record the point at which PostgreSQL took the
snapshot. A verified webhook committed before that point is visible to both
queries. A later commit leaves the operation at its earlier state in the report.
Re-read the live operation before deciding its disposition.

The forward marks unresolved incumbent operations whose stored template version
differs from the version at upgrade. A claim made before an accepted edit that
also landed before the forward looks the same as the billing defect. The report
includes it for reconciliation. Historical operations without a recorded
template version supply no freshness evidence. Claims that were current at the
forward and new claims prepare at the price frozen at claim. Later accepted
edits apply to later cycles.

```sql
BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY;

SELECT pg_current_snapshot()::text AS cut_snapshot,
       statement_timestamp() AS cut_statement_started_at;

WITH stale_incumbent AS MATERIALIZED (
  SELECT o.id, o.subscription_id, o.scheduled_at, o.state,
         o.terminal_reason, o.cycle_snapshot,
         public.subscription_renewal_occurrence_is_current(
           s.status, s.next_cycle_at, o.scheduled_at
         ) AS occurrence_current
  FROM public.subscription_renewal_operations o
  JOIN public.subscriptions s ON s.id = o.subscription_id
  WHERE o.claimed_before_rnw_1
    AND o.cycle_snapshot->>'contractVersion'
        IS DISTINCT FROM 'platform.subscription.renewal.v3'
), roots AS (
  SELECT o.id AS operation_id, o.subscription_id, o.scheduled_at,
         o.state AS operation_state, o.terminal_reason,
         o.cycle_snapshot, o.occurrence_current,
         w.id IS NOT NULL AS captured_stock_wait,
         public.subscription_renewal_unresolved_stock_wait(o.id) AS stock_wait_state,
         r.id AS retry_obligation_id, r.state AS retry_state,
         CASE WHEN r.state = 'prepared' THEN
           public.subscription_retry_prepared_payment_attempt(r.id, r.attempt_sequence) IS NOT NULL
         END AS retry_has_readable_attempt
  FROM stale_incumbent o
  LEFT JOIN public.subscription_stock_wait_cases w ON w.renewal_operation_id = o.id
  LEFT JOIN public.subscription_retry_obligations r
    ON r.renewal_operation_id = o.id AND o.state = 'refused'
   AND r.state IN ('waiting', 'prepared')
   AND EXISTS (
     SELECT 1 FROM public.subscription_cycles c
     WHERE c.id = r.cycle_id AND c.status = 'payment_pending'
   )
   AND EXISTS (
     SELECT 1 FROM public.commerce_settlement_intents i
     WHERE i.id = r.settlement_intent_id AND i.status IN ('created', 'failed')
   )
)
SELECT operation_id, subscription_id, scheduled_at, operation_state,
       stock_wait_state, retry_obligation_id, retry_state, retry_has_readable_attempt,
       cycle_snapshot->'totalAmountMinor' AS frozen_amount_minor,
       cycle_snapshot->>'currency' AS currency,
       'subscription_renewal_snapshot_stale' AS reason
FROM roots
WHERE operation_state = 'attempt_prepared'
   OR (occurrence_current AND (
     operation_state = 'claimed'
     OR (operation_state = 'reserved'
       AND (NOT captured_stock_wait OR stock_wait_state IS NOT NULL))
   ))
   OR (operation_state = 'refused' AND (
     retry_obligation_id IS NOT NULL
     OR (stock_wait_state IS NOT NULL
       AND terminal_reason IN ('inventory_unavailable', 'reservation_expired'))
   ))
ORDER BY operation_id;

COMMIT;
```

A prepared attempt can settle at its original amount using existing provider
readback and settlement. Keep its original snapshot, fingerprint and references.
Prepared replay does not dispatch another charge. For unprepared roots and
stock waits, use the original occurrence with your authorized lifecycle or
reconciliation path. Retry preparation refuses new attempts for marked
operations, including when a verified decline received after the report puts
the obligation back in waiting. A prepared retry with
`retry_has_readable_attempt = false` needs operator reconciliation before it
can proceed. Use the operation ID if you rerun the report.

## Prepare the optional checkout owner

Ordinary upgrades on the four qualified profiles require no new login.
Connected-store restore keeps the target's verified grants and ledger.
Legacy has no checkout opt-in. A regular legacy upgrade uses a cluster
without the checkout login. If the login exists for another database,
the grant unit records a no-op, but legacy inventory can refuse the extra
cluster role. Use a qualified installation or a separate cluster.

| Qualified profile | Who provisions the login outside migration | Who preserves TEMP and applies the grant |
| --- | --- | --- |
| Bootstrap migrator | The bootstrap host | The bootstrap database and definition owner |
| Separate migrator | The bootstrap host | The separate database and definition owner |
| Restricted installer-managed | The bootstrap host | The restricted database and definition owner |
| Restricted operator-provisioned | The designated role operator under bootstrap control | The restricted database and definition owner |

For qualified-v2 operator-provisioned installations, the designated host
role operator provisions the login under bootstrap control. On PostgreSQL
16, ask the membership grantor to remove the creator edge. Have the
database owner preserve TEMP for the installation roles that use it
before revoking TEMP from PUBLIC. Coordinate role changes across all
affected databases.

Once an installed catalogue includes the approved grant unit and the
selected database has recorded it, run this operation with the same
installation binding and direct definition-owner connection as the
migration runner:

```ts
import {
  applyPlatformCheckoutOwnerGrant,
  type QualifiedAdminPostgresInstallation,
  type QualifiedPostgresInstallation,
} from "@openlup/platform/migrations";

export function prepareCheckoutOwner(
  connectionString: string,
  installation: QualifiedPostgresInstallation | QualifiedAdminPostgresInstallation,
) {
  return applyPlatformCheckoutOwnerGrant({ connectionString }, installation);
}
```

The operation serializes with migration and restore on the selected database.
Keep host role, role-default, local DDL and ACL administration excluded until it
returns. Repeating it returns the same `{ state: "granted" }` and preserves the
ledger. Verify that result on the selected database before binding any
checkout credential to a supported host. For `checkout_owner_login_unready`,
ask the installation owner to prepare and verify the dedicated checkout
login. For `checkout_owner_acl_mismatch`, ask the installation owner to
verify the approved checkout access for this database. If connected-store
restore refuses target access, ask the installation owner to verify the
target installation.

## Inspect and apply

1. Call `status()` to inspect the applied and pending canonical paths. It
   validates the catalogue, ledger and selected session requirements.
2. Call `apply({ dryRun: true })` to list pending paths without applying SQL.
   Its returned `applied` array means proposed work in this mode.
3. Call `apply()` to execute the pending suffix in catalogue order. Each unit
   and its ledger insert commit in one transaction. A failed unit rolls back;
   earlier committed units remain recorded. Repeat with the same valid
   catalogue to resume from that prefix.
4. Confirm completion with `status()`. A completed chain has no pending paths;
   another `apply()` performs no migration SQL and rechecks the live inventory.

The `public.platform_schema_migrations` ledger records each canonical path,
SHA-256 digest, position and execution timestamp. The runner checks its table
shape before reading rows, then requires those rows to match the exact manifest
prefix. Do not repair a refusal by editing the ledger or the packaged SQL.

Refusals include these error messages:

| Message | Meaning |
| --- | --- |
| `platform migration catalog rejected:` | The catalogue or manifest failed validation; details follow the prefix. |
| `platform migration ledger relation is not safe to read` | The ledger's owner or database-object shape failed admission. |
| `platform migration ledger contains an extra row` | Installed history extends beyond the selected catalogue. |
| `platform migration ledger is not the exact manifest prefix at position` | A path, digest or position differs; the position follows the message. |
| `platform migration inventory rejected:` | The live object inventory differs from the manifest's pinned inventory; details follow the prefix. |

The live inventory is checked after apply, and on status or dry-run when the
whole selected chain is already installed. A pending dry-run does not certify
the final inventory. Inventory rejection can occur after migrations have
committed; it does not roll back the whole upgrade.

### Session and ledger admission

A trusted migration source may supply `assertSession` to observe host facts
once under the advisory lock, after exact ledger-prefix admission and before
status, dry-run or pending SQL. This callback neither provisions nor qualifies
a hosted installation.

Every source uses catalog-bound locks and admits only the canonical baseline
ledger catalog shape before reading its exact prefix. The fingerprint stays
exact except for numeric `pg_attver` column version markers in a nonempty,
one-dimensional array starting at index 1; every other attribute option refuses.
A pending unit locks an installed ledger before its first catalog read in that
transaction and preserves the connection's isolation setting.

## Find the current function definition

Open the installed package's `sql/manifest.json` for the runner's generation.
Follow its baseline and ordered forwards, stopping at the applied prefix from
`status()` for a database with pending forwards. Resolve definitions from that
history before relying on module lists or filenames.

Find anchored `CREATE FUNCTION` or `CREATE OR REPLACE FUNCTION` declarations.
Read the full signature and body, then follow replacements and
`DROP FUNCTION` for the same signature in order. Resolve each overload
separately against the installed version. Treat calls, grants and release notes
as references.

For native `subscription_auto_resume_due(integer,timestamptz)`, the forward
`20261114110000_payment_method_refs.sql` replaces earlier auto-resume definitions.
Its assignment takes the later of the stored next cycle plus the actual pause
duration and execution time. It never brings the next cycle earlier. Follow
[timed pauses](../concepts/subscriptions.md#timed-pauses)
for eligibility and effects; a textual search for a clamp is not an invariant
proof.

## Check application compatibility

A compatible change lets the application continue reading and writing its
existing data contracts. Adding nullable storage or accepting additional status
values can preserve old rows, but the application still needs to understand any
new values or events it will consume. Install required schema additions before
deploying code that depends on them, and update producers and dispatchers
together before enabling newly introduced event flows.

Within 1.x, schema changes are additive: expand and backfill while preserving
contracts used by running and rollback applications. Contraction, including
removing or renaming an old shape, requires a major release. An incompatible
change must establish its expand, compatible deployment, backfill and contract
sequence before use. Catalogue acceptance proves identities and
the selected object inventory, not old/new application compatibility, data
backfill completion or a safe rollback. Reverting application files does not
undo committed SQL or durable effects.

Verify the selected chain and application combination, including replay and refusal
behavior. [Application file upgrades](./application-files.md) are a separate
operation and execute no database work.

For the native starter, apply `20261124200000_checkout_attempt_ledger` before
updating application files or starting the updated host. Older hosts can run
against the additive schema. The updated host begins counting in PostgreSQL
without importing old in-process counts.

| Startup diagnostic | Action |
| --- | --- |
| `starter_checkout_attempt_ledger_missing` | Apply the checkout attempt database forward and restart the starter. |
| `starter_checkout_attempt_ledger_execute_required` | Restore the checkout attempt routine's EXECUTE grant for the runtime role and restart the starter. |
| `starter_checkout_attempt_ledger_check_failed` | Check database connectivity and runtime credentials, then restart the starter. |

The post-publication released-pair qualification
uses both exact installed applications retained by the adjacent-set starter
proof. Their shipped runners use the starter bootstrap's `qualified-v2`,
installer-managed profile on PostgreSQL 16, with distinct install, runtime and
restore roles. They install the predecessor's packaged catalogue and apply the
target's packaged forwards. It kills a forward inside
its transaction, asserts `OPENLUP_E_SCHEMA_BEHIND/version_mismatch` using the
installed readiness evaluator with a supplied target catalogue-tail requirement,
then resumes and checks no-op replay. Target, predecessor and target code run
reads, fresh writes and replay against the unchanged upgraded schema. Named
`subscription_monotonic_clamp` assertions check late-arrival extension, no
earlier cycle and no stacked delivery or cycle across forward, code rollback
and replay. See the retained receipt for the actual pair and execution result;
an identical-catalogue pair records the interruption as
`not-applicable: no forward migrations in this pair` and still runs all
cross-version rollback and subscription checks.

The existing 0.23-prefix invoicing backfill proof remains **historical** and
separate. Contraction and adjacent-pair backfill remain **PARTIAL** until a real
retirement ships, because the 0.41→0.42 pair has no object needed only by the
older application. This proof adds no destructive migration, down-migration or
new admission grammar. Code rollback is proved only for the qualified adjacent
pair, selected PostgreSQL profile and retained reads, fresh writes, replay and
subscription assertions on the unchanged upgraded schema. It does not undo SQL
or durable effects, prove adjacent-pair backfill or contraction, or establish a
general rollback guarantee.

### Handle refusals from native destination SQL

Before applying the destination refusal forward, update callers of
`commerce_snapshot_destination_v2` and `commerce_read_destination_v2`.
The routines return expected refusals as a JSON result with
`outcome: "refused"`. Check that discriminator before reading success fields.
Use `code` and `field` to handle the case, and `fix` and `recheck` to guide
the next action. When your application owns a snapshot transaction, roll it
back before returning the refusal to the caller.

Handle `{ "evidenceDisposition": "erased" }` separately on an authorized
snapshot replay. Direct receipt routines still raise their existing SQL errors.
Unexpected database failures still raise an error.
