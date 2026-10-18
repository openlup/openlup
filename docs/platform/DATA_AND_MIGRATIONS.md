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
Required pull-request and merge-group self-check compares the exact event base
with the candidate commit for this append-only migration rule. The preview
producer separately compares the selected release commit with the prior preview;
the earlier check does not replace that release-time comparison.
The self-check validates the manifest's shape and history, while the portable
runner checks `objectInventorySha256` against its live selected catalogue after
applying the chain. That runtime check remains required for database acceptance.

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

## Module catalogues and installed histories

The direct human-login forward `20261018180000_identity_operator_challenges`
appends position 68 after invitations. Preserve every preceding file, digest and
position. The identity projection carries the same bytes and canonical position;
never install the sparse projection as a complete catalogue. Its normalized-email
unique index refuses duplicates instead of merging principals. Recompute the live
selected-catalog object inventory after applying the full chain. Fresh install,
exact-prefix upgrade, replay and retention of customer, subscription and machine
links need real-database proof; there is no managed counterpart.

Identity email-trust admission changes no schema or stored identities, contact
links or subscriptions. Its conformance runner replays the complete managed
baseline and ordered forwards using `psql`, without a CLI migration ledger.
After that replay it inserts a linked subscriber fixture before checking that
settings-failure refusal and repeated reconciliation preserve its client and
subscription rows. A public-catalogue fingerprint checks public relation names
and kinds across the envelope exercises; it covers neither migration-ledger
contents nor subscriber survival across SQL replay. The disposable stack's
fixture-only service-role grant and the remaining shipped-grants permission gap
are described in [identity conformance](IDENTITY.md#conformance-and-outstanding-evidence).
The identity SQL projection is not a standalone install chain.


The canonical source manifest for `db/platform/migrations` is the existing
[`config/platform-migration-manifest.json`](../../config/platform-migration-manifest.json).
Its current format is v1: one baseline and ordered forward file/hash rows for
that catalogue, plus `objectInventorySha256`. Keep its exact immutable prefix; do not create a competing
canonical manifest or add package SQL paths to unchanged v1. The
[source validator](../../scripts/platform-migration-manifest.ts) owns that
format. A future combined catalogue needs an explicit reviewed format and
compatibility change if v1 cannot represent it.

Several modules in one distribution need a deterministic migration catalogue
before they can be installed together. Declare their dependency order and
preserve each migration's identity, bytes and owner; do not infer ordering from
directory traversal or replace independent schema requirements with one nominal
package version. A tarball manifest is a projection of canonical source rows
and their digests, not a second authoring source. Copying existing SQL into a
tarball does not make it a new migration to replay. Never split, rename or edit
an issued or applied SQL unit, including one that spans several modules.

The planned foundation/identity path must prove both a fresh installation of
the complete selected catalogue and an upgrade from the exact foundation chain
to identity. The runner must match the applied ledger to the exact selected
prefix by path, hash and position before appending; missing, reordered,
duplicated or changed applied identities refuse. Preserve durable state and
prove replay and refusal through the existing package-owned required proof.
This is a future package-runner acceptance requirement, not evidence that a
multi-module runner or catalogue already exists on this branch.

An adopter with an existing store retains its own reviewed migration chain and
applied ledger. It compares required schema and migration identities with that
store and applies only compatible reviewed forwards. It does not apply a fresh
package baseline over an existing database, relabel old SQL as new, rewrite an
applied prefix or discard pending work. Fresh-install proof does not establish
that upgrade path. See [package architecture](ARCHITECTURE_AND_EXTENSIONS.md#versions-and-schema)
for the shared set and shipment boundary.

## Database test fixtures and witnesses

A selected test may supply neutral settlement, format, provider, location and
stock rows in its own transaction. Concurrency connections need the same declared
inputs. Those rows model configured examples; they must not replace policy or
control data the offered runtime requires the platform chain to install.

Execute a domain operation as its documented runtime role. A result or no-write
witness may use the database owner when direct table reads are deliberately
closed, but that observer must not become the executor of an invoker RPC.
Test-only grants, broader table access and owner execution cannot establish that
a service call works. Assert negative browser permissions and runtime behavior
separately from historical grant spellings or inherited CLI defaults.

## Exact reviewed function forwards

The managed runtime capability forward is shipped after its separate control
approval. It changes no baseline bytes or function signature. Required service
and authenticated column/helper permissions are explicit in that ordered file;
no portable twin or live upgrade compatibility is claimed. A corrected forward
also retires exactly eight legacy id-only browser policies that membership
reads would otherwise activate. Customer-own policies and own membership reads
remain unchanged; actual authenticated role tests cover cross-customer refusals.
Policy retirement is pinned to exact statements and preceding policy hashes; it
is not general permission to alter RLS.
The checker binds the fixed policy names, tables, preceding statement hashes
and ordered DROP statements separately from the function and privilege pins.
Other policy operations refuse. Approval must precede the corrected SQL
comparison base and introduction parent; control approval alone grants no
runtime permission or actual-role proof.

Reviewed replacement is a separate admission class, not expand-only. The fixed
[allowlist](../../config/reviewed-platform-forwards.json) pins three managed
forward paths and their whole-file SHA-256 hashes in separate replacement and
creation lists. The replacement list contains only two files and permits replacement of
exactly `commerce_offer_policy_v2_readiness()`,
`subscription_create_provisional_for_checkout(uuid,uuid,uuid,uuid,jsonb)` and
`subscription_apply_starter_graduation(uuid,text,text)` in `public`. The price
setup forward also binds its two new function signatures, which must be absent
from the preceding chain. This control change installs approval data only; it
does not ship or execute those forwards.

[The shared checker](../../scripts/reviewed-platform-forward.ts) verifies the
immutable managed baseline hash, each old definition and each new definition.
A definition hash covers the raw `CREATE` statement through its terminating
semicolon; names and defaults remain in those bytes, while signature identity
uses argument types. Whole-file hashes additionally bind comments, grants and
all other SQL. Earlier forwards are considered when checking the old definition.
Missing or duplicate signatures, another path, and any changed byte refuse.
Outside the pinned function bodies, only function definitions, transaction
boundaries, privileges and comments on functions defined in that same file are
accepted. Grants may target only `authenticated` or `service_role`; grants to
`PUBLIC` or `anon`, other schemas, unrelated statements and unterminated dollar
bodies refuse even if the whole-file hash was separately repinned.

The optional runtime list pins one additional forward and exactly five existing
functions: the `admin_clients_search_v3` and `subscription_list_due_for_renewal`
readers, and the `customer_support_absorb_lead_v1`,
`marketing_rehome_client_lead_v1` and `customer_support_correct_subject_email_v1`
invokers. Its ordered privilege statements grant only `service_role` the fixed
column-level SELECT capabilities, UPDATE on the five existing client mutation
columns and `client_id` on the three carry tables, UPDATE on only
`subscriptions.updated_at` to retain both renewal row-lock clauses, and EXECUTE on
`record_admin_audit_event`, `subscription_current_template_snapshot`, and the two
existing pure `commerce_oms_normalize_search_text` /
`commerce_oms_normalize_search_digits` helpers needed by client expression indexes.
The checker fixes the allowed tables, operations, columns and signatures
independently of the registry, including separate authenticated read/helper sets;
repinning cannot admit additional capabilities,
table-wide permissions, INSERT, DELETE, TRUNCATE or an unlisted recipient.
SELECT and UPDATE are separate capabilities; duplicates within either operation
refuse. These direct service UPDATE permissions require security admission even
though they support existing invoker bodies. The subscription grant also permits
raw timestamp writes on any row; it does not confine the caller to locking.
Both renewal CTEs retain `FOR UPDATE OF s SKIP LOCKED`, with default VOLATILE
and invoker execution unchanged. The same finite forward restores authenticated profile/membership reads on
exact columns consumed by current routes and EXECUTE on the two pure OMS
normalization helpers required by existing expression indexes. Browser writes,
operator RPC execution and anonymous capabilities do not expand; existing RLS
continues to filter profile and membership rows.
Function headers must preserve the preceding definition's arguments, defaults,
return shape, volatility, execution security and settings. Attributes after the
outer dollar body refuse; only its terminating semicolon and whitespace may
follow. This control installs approval data, without shipping the runtime forward.

Required PR/merge-group self-check requires the allowlist bytes to predate the
feature comparison base. Release prepare uses the same checker and requires
the identical allowlist in the first parent of the mainline commit, squash or
merge, that introduces each forward; a feature branch's own earlier commits do
not count.
Thus a release can include a prior control PR followed by feature PRs without
allowing a feature to approve itself. Missing history refuses. Existing history,
version and manifest rules still apply, and the expand-only predicate is unchanged.
Admission is process evidence of exact reviewed bytes, not proof of live schema
compatibility or authorization to release. Independent control review and the
affected database behavior tests remain required.

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
the baseline transactionally, then applies the managed alignment and required policy-data forwards.
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

Reference identity composition adds no SQL or ledger entries. Direct startup
requires the complete canonical catalogue through identity erasure receipts,
never the sparse seven-file package projection. Its schema inventory is a
presence check; hosts must independently observe the complete installed ledger.
Managed startup likewise needs trustworthy committed-chain observation and
separate effective-grant verification. The reviewed managed identity service-role
capabilities forward supplies client INSERT(email, auth_user_id,
acquisition_source, lifecycle_stage), UPDATE(auth_user_id), and operator
INSERT(id, email, role, membership_state, membership_provenance,
membership_accepted_at) plus SELECT(email) once integrated. Until present,
labelled conformance fixture grants remain fixture-only and cannot establish
shipped-install readiness. No application startup grants compensate for them.


<!-- openlup-doc-impact {"unit":"data","digest":"sha256-474c9722bba98cb05cc9b075d987ec35207dbb68fcdd7528ef88d9f953c9e38e","reason":"Customer browser adapters use new session namespaces without migrating legacy credentials. The managed adapter now also removes its effective SDK session store and completes local SDK cleanup after remote logout failure. These are browser-session changes only: database schemas, migration chains, stored customer links and the compatibility lifecycle are unchanged."} -->

The direct privacy forward `20261018190000_identity_privacy_erasures` appends
position 69 and one receipt table, with default NO ACTION references and no
functions, grants or policies. Apply it before the updated customer challenge
store and privacy operations. Its identity SQL projection is byte-identical and
retains the canonical path, digest and position. Preserve the complete earlier
manifest prefix. Fresh installation, exact position-68 upgrade, replay and the
live selected-catalog-v2 object-inventory digest require disposable PostgreSQL
verification. Schema installation alone changes no existing identity or links.

Direct erasure deletes challenges and outstanding invitations, pseudonymizes
profile and retained identity snapshots, revokes active operator membership
through the guarded authority, and clears only the selected contact's direct
principal link. It never changes `clients.id` or writes `auth_user_id` and never
cancels a subscription. Cleanup and the retained pseudonymous receipt commit in
one transaction; replay returns the original receipt. Subscription and challenge
relation locks precede subject locks, with bounded waits and full rollback on
failure. Effective inherited browser/PUBLIC receipt access refuses writes.

The package customer challenge store checks erasure receipts by both contact and
principal in the transaction that calls issue/redeem, holding an `EXCLUSIVE`
challenge-table lock through commit. Erasure takes the same conflicting lock
before subject reads and cleanup. Thus a late challenge from an issuer that read
before erasure cannot re-link through package redemption after erasure commits.
Receipt reads use `ACCESS SHARE`, compatible with erasure's receipt-table
`SHARE ROW EXCLUSIVE` lock. This guarantee covers the package adapters; hosts must
not call the raw `customer_identity_challenge_issue` or
`customer_identity_challenge_redeem` SQL functions directly. Those unchanged
functions have no receipt fence. No function replacement, trigger, RLS change or
new SQL is required for the adapter boundary.

Managed erasure refuses with `MANAGED_PRIVACY_ERASURE_UNAVAILABLE`: a managed
adopter must provide its own erasure path until a separately reviewed managed
forward and atomic persistence capability exist. The committed column grants
cannot perform full profile/membership pseudonymization. Managed export reports
inaccessible fields as unavailable. No managed SQL or privilege expansion ships
with this capability. Provider identity must be disabled rather than deleted,
because deletion could clear immutable customer auth links. No managed provider
mutation is composed here. See [identity privacy](IDENTITY.md#identity-personal-data)
for retained obligations and the limits of identity completion.

To run the opt-in managed privacy proof from the repository root, supply the
local disposable-stack API URL and service key as
`OPENLUP_MANAGED_CONFORMANCE_URL` and `OPENLUP_MANAGED_CONFORMANCE_SERVICE_KEY`.
Set `OPENLUP_MANAGED_CONFORMANCE_DATABASE_URL` to the database owner
(`supabase_admin`) connection, then run
`node --experimental-strip-types tests/postgres/identityPrivacyManaged.conformance.ts`.
Use a fresh public schema and reset the stack between proofs. The proof uses
the shared committed migration loader and omits only the psql-only pg_dump
`\restrict` and `\unrestrict` guard lines for node-postgres replay; migration
SQL and erasure permissions remain unchanged.


Operator challenges add one direct-only table and indexes, no function or
privilege grants. Issuance, activation/consumption, bootstrap and retention use
the trusted transaction lane. Before enabling direct login, verify effective
browser-role/PUBLIC privileges, including inheritance and column grants; unsafe
stores refuse runtime authentication. Browser sessions use tab storage through
the existing guarded storage boundary and do not add database session rows.


The operator invitation lifecycle preserves existing accepted membership rows and customer/principal links. Its
direct forward `20261018120000_identity_operator_invitations` appends one catalogue
unit, at position 67, and adds pending-invitation and invitation-audit tables with
default NO ACTION principal foreign keys. The byte-identical identity projection
retains this canonical identity and position. Lifecycle logic runs in trusted
server TypeScript transactions; acceptance, membership and audit settle together.
The forward uses only admitted CREATE TABLE/INDEX forms and changes no privileges.
The real PostgreSQL conformance must verify effective actor-role denial, fresh
complete-catalogue installation, exact predecessor-ledger upgrade and replay.
The object-inventory SHA-256 must be refreshed from that live catalogue with the
runner's selected-catalog-v2 projector, never guessed from SQL text.

The managed invitation route inserts active native membership immediately and
adds no SQL or RPC. It stores no pending invitation in Auth metadata and does not
activate or compensate on first entry. Identical repeats return existing active
membership without another notification; a unique insert race re-reads the winner.
Failure retains the identity for retry. Re-inviting a revoked managed operator
refuses with 409 `MANAGED_REINVITE_UNSUPPORTED`.

The managed pending/expiry lifecycle remains a compatibility gap because it needs
a transactional store. It closes later only through a separate reviewed managed
forward. This change does not broaden SQL admission, install a managed migration
or certify parity with the direct transaction protocol.

The committed managed chain does not grant `service_role` SELECT on
`admin_users.email`, required by the membership reader, or INSERT on
`(id, email, role, membership_state, membership_provenance,
membership_accepted_at)`, required by invitation insertion. The insert omits
`is_machine_actor`, relying on its `NOT NULL DEFAULT false`. Production use needs
a separate reviewed managed forward granting exactly those columns. No such
grant ships here. The opt-in
[managed conformance module](../../tests/postgres/operatorInvitationManaged.conformance.ts)
replays the complete committed managed chain into a fresh disposable local stack
with ambient default ACLs removed, then applies those exact permissions as a
labelled fixture-only grant. It proves immediate activation, repeat/concurrent
recovery and revoked-member refusal without claiming shipped-grants readiness.
The [package guide](../../packages/platform/README.md#operator-invitations) gives
its local endpoints, controlled setup and exact invocation.

Runtime capability regressions execute operator and support gates as
`service_role`, including exact inactive-operator and machine-actor refusals,
missing subjects and prohibited unrelated column access. Two independent
service transactions prove renewal selection skips locked normal and retry rows
and admits them after release. The database owner only creates fixtures and
observes refused mutations. A proposed SQL overlay in a disposable database is
local behavior evidence; committed-chain replay and delivery checks remain
separate requirements.


Every production-shaped schema change follows this order:

1. **Expand** with an additive, backwards-compatible schema change.
2. **Compatible deploy** code that can read the old and new shapes.
3. **Backfill** through a resumable, observable, idempotent process.
4. **Contract** in a later release after the old shape is no longer consumed.

Code rollback must remain compatible with the expanded schema. A destructive
down migration is not a rollback plan. Each stage needs a clear readback and
failure boundary; a backfill that cannot be safely retried is incomplete.

The managed forward `20261003110000_required_platform_policy_data.sql` supplies
configuration omitted by the schema-only baseline. It classifies all 27 current
relations referencing clients: four marketing relations carry, account-event
history stays on the archived lead, and the other 22 block absorption. Unknown
future relations still refuse. Existing classifications survive replay.

The same forward installs seven disabled job controls, the four exact declared
dormant command identities and four message controls. Message controls begin
enabled to preserve the sender's existing missing-row behavior; a prior disabled
operator choice stays disabled. No job, provider or scheduler is activated.
Existing driver, metadata, note and dormant-reason choices also survive replay.
The dormant insert uses the frozen five-column relation order and literal UTC
migration timestamps; the managed regression checks that order before replaying
the actual forward. No portable twin or installation-path parity is claimed.

Database proofs execute order writing, accounting and dispatch claims as
`service_role`, and membership commands as `authenticated`. Owner readback
observes persisted state and denied writes. Legacy catalog commands stay denied;
no broader raw table DML is required to reach an otherwise inert handler.

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

Current migration and self-host material is evaluation-oriented. The stable-framework requirements
must still prove versioned upgrades, N-1 compatibility, and the complete
expand/compatible-deploy/backfill/contract path before a stable upgrade claim is
made.
