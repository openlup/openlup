# Data And Migrations

Status: development-preview contract. It specifies a compatibility discipline;
it does not certify a migration path or an upgrade service.

## Data ownership

The platform owns its schema, migration history, and documented data contracts.
An adopter owns tables and migrations for its own extensions in the `app` schema.
The platform never writes there; the adopter owns extension compatibility and
migration ordering. Extension data must live beside platform data through explicit foreign keys, ports, or events rather
than by editing platform rows with undocumented assumptions.

The published platform shape must expose a reproducible baseline and ordered
forward migrations. Development convenience at process startup is not a
coordination mechanism for a multi-instance deployment.

The preview source release deliberately ships an unbound database-type seam at
`src/integrations/supabase/types.ts`; replace it with adopter-generated types
before enabling database adapters. It is not evidence of schema compatibility.

## Additive forward release path

A development preview may append expand-only platform forwards to either chain:

- Portable PostgreSQL: `db/platform/migrations/<14-digit-version>_<name>.sql`,
  with `config/platform-migration-manifest.json` preserving the baseline and all
  previous forward rows as an exact prefix and binding the added files by SHA-256.
- Managed Supabase: `supabase/migrations/<14-digit-version>_<name>.sql` after
  the frozen `00000000000000_platform_schema_baseline.sql` baseline.

Each new version must exceed every preceding version in its own chain. Existing
migration bytes and modes are immutable. The schema-5 release inventory binds
forward bytes; the source contract binds the extended portable manifest digest.
Database types, policy registry and bootstrap SQL remain frozen for this path.

The release producer refuses destructive DDL (`DROP TABLE`, `SCHEMA`, `VIEW`,
`TYPE` or `COLUMN`, and `TRUNCATE`), renames, schema moves, ownership transfers
and writes to adopter-owned `app`. Its bounded SQL predicate accepts additive
object creation, `ALTER TABLE ... ADD`, transaction boundaries and literal
`INSERT ... VALUES ... ON CONFLICT ... DO NOTHING`. Procedural or dynamic SQL
and unsupported forms refuse; see [Versioning and EOL](../../.github/VERSIONING_AND_EOL.md#publish-refuse-and-recover)
for the exact admission boundary. Passing admission does not prove N-1 or live
schema compatibility. Test the actual selected chain, constraints and replay.

Rows that platform behaviour depends on must ship as idempotent statements in a
forward, rather than relying on a reference fixture or process startup. A missing
twin in the other chain is a documented compatibility gap, not implicit parity.

An adopter's hosted chain may already carry a managed forward under its own
migration name. Such a file is a platform companion: its leading comment block
names the forward in the line
`-- migration:platform-companion: openlup:<forward path>`, where the forward
path is the platform forward's repository path, such as
`supabase/migrations/<14-digit-version>_<name>.sql`. Where the tests and the
reference setup read the managed alignment forward, they use the platform file
when it exists, otherwise the SQL of the one companion that names it with every
marker line removed, and they refuse when none or several do.

## Disposable managed reference baseline

The opt-in [subscription reference](SUBSCRIPTION_REFERENCE.md) selects the
managed Supabase baseline at
`supabase/migrations/00000000000000_platform_schema_baseline.sql`. It does not
apply the separate `db/platform/migrations` portable PostgreSQL chain or claim
that the two installation paths are interchangeable. The public setup creates
one owned local Supabase project, adds `pg_trgm` in `public` and the non-login,
non-RLS-bypass `openlup_mcp_reader` role required by that baseline, and replays
the baseline transactionally, then applies the managed alignment seed forward.
Its synthetic seed supplies only the recurring catalog item, prices, stock and
settlement settings. The compatibility alignment seed is now a no-op. Setup
does not insert a paid order or active subscription.

For accidental-attachment protection, setup records a per-installation opaque
id in the existing `commerce_settings` table and in its generated local marker.
Before that row exists, an interrupted setup can resume only on its recorded
container. A sealed setup checks the live database id before reapplying
prerequisite or seed SQL, and the selected runtime checks the same id before an
API operation. This row records development-reference ownership; it is not a
platform migration or an adopter data contract. Reusing the same database
volume preserves the identity and business state; a different database at the
same port refuses. The managed baseline and forward replay plus one local fixture do not establish N-1
compatibility or general self-hosted database support.

## Known managed-baseline alignment gap

The managed baseline creates `subscription_delivery_alignment_control` without
its singleton row. Readers coalesce an absent mode to `off`, so late delivery
does not move the next cycle. `subscription_delivery_alignment_set_mode` updates
only existing rows and can report success after updating zero rows; it does not
repair this missing prerequisite.

The managed forward seed_subscription_delivery_alignment_control, version
20260927131453, inserts the singleton with `mode = auto_align` and
`ON CONFLICT (singleton) DO NOTHING`. It repairs a missing row while preserving
any existing mode choice. Apply it after the immutable baseline; never edit the
baseline to add seed data. pgTAP reads the installed singleton and tests replay
and preservation of an operator's mode choice.

The owned disposable subscription setup applies this forward before its seeds,
including on reruns where the catalog already exists. Its matching compatibility
seed becomes a no-op. Reference verification still refuses a missing row or a
mode other than `auto_align` before either a new journey or restart proof. This
mode is the prerequisite for the monotonic late-delivery rule in
[Canonical contracts](CANONICAL_CONTRACTS.md#subscription-delivery-alignment).

There is no portable twin: the delivery-alignment rail is managed-only. The
portable installation's lack of this capability remains a known gap; this
forward establishes neither installation-path parity nor the complete
late-delivery journey or a stable upgrade guarantee.

## Compatibility lifecycle

Every production-shaped schema change follows this order:

1. **Expand** with an additive, backwards-compatible schema change.
2. **Compatible deploy** code that can read the old and new shapes.
3. **Backfill** through a resumable, observable, idempotent process.
4. **Contract** in a later release after the old shape is no longer consumed.

Code rollback must remain compatible with the expanded schema. A destructive
down migration is not a rollback plan. Each stage needs a clear readback and
failure boundary; a backfill that cannot be safely retried is incomplete.

<!-- openlup-doc-impact {"unit":"data","digest":"sha256-d915406b81907bb044829233faec2bebfaf66b6176c4b4f7ec8c836d240d1c86","reason":"Comment-only delta in five pgTAP test files. Comments stop naming downstream scripts and documents and name the runner by its public command. No SQL statement, assertion, migration or compatibility rule described here changes."} -->

## Contract changes

Schema constraints, stored-money representations, identifier formats, and
canonical status vocabularies are data contracts. Change them only with an
explicit compatibility path, a data migration where required, and regression
coverage for old/new reads, replay, and refusal cases.

Do not infer durable truth from a provider callback or from a browser payload.
Persist the platform's canonical fact and keep provider evidence at the adapter
boundary. See [Canonical contracts](CANONICAL_CONTRACTS.md) for the mapping and
idempotency rules that prevent duplicate or stale writes.

## Paired chains diverge, and each side must say so

Some forwards ship twice: once into the managed chain the hosted deployment
applies, and once into the public platform catalogue an adopter applies. The two
are behaviour-identical by intent, never byte-identical by accident, and **each
header states its own divergences out loud** rather than being copied from the
other. The job-control seed for `customer-diagnostic-prune`
(`20260914130000_customer_diagnostic_prune_job.sql` in both roots) is the current
worked example:

| | Managed chain | Public platform catalogue |
|---|---|---|
| Columns | five — `(job_name, enabled, active_driver, allowed_trigger_kinds, metadata)` | four — the `allowed_trigger_kinds` column does not exist here |
| Why | the v3 claim raises `platform_job_v3_control_not_configured` when the column is NULL, so a v3 job that omits it cannot claim at all | this catalogue's claim path gates on `enabled`, the driver and the lease; there is no column to write and no refusal to avoid |
| `active_driver` | `'worker'` | `'worker'` |
| Metadata | carries `requiresFlag` and the hosted-cron note | omits both: which environment variable one deployment names, and which hosted schedulers it declines to use, are not properties of this catalogue |
| RLS / grants | present elsewhere in the chain | never authored here — the managed chain's principals do not exist, so authoring them would be authoring empty shapes |

⚠️ **The nearest neighbour is the wrong model, and that is the point of writing
the header from scratch.** The `channel-order-pull` seed in the same catalogue
writes `active_driver = 'scheduler'`, which is correct for a poll whose claim
arrives as a scheduler. `customer-diagnostic-prune` claims as `worker` on every
runtime, and the portable claim refuses a driver mismatch as `inactive_driver`,
so copying `scheduler` would have made every claim this job ever makes fail. Copy
a neighbouring header's **style**; never its values.

⚠️ **A re-applied control seed must not reverse an operator.** Both sides use
`ON CONFLICT … DO UPDATE` that refreshes the driver, the allowlist where it
exists, and the metadata — and never `enabled`. An adopter who enabled a drain is
relying on it to bound their storage; one who disabled it is retaining evidence
on purpose. Neither decision may be silently undone by re-running a forward.

## Preview and stable posture

Current migration and self-host material is evaluation-oriented. The `P1-SF`
gate must still prove versioned upgrades, N-1 compatibility, and the complete
expand/compatible-deploy/backfill/contract path before a stable upgrade claim is
made.
