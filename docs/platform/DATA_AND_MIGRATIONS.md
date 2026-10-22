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
Both gates refuse control characters other than tab and line feed in migration SQL (parser parity with PostgreSQL).

The release producer refuses destructive DDL (`DROP TABLE`, `SCHEMA`, `VIEW`,
`TYPE` or `COLUMN`, and `TRUNCATE`), renames, schema moves, ownership transfers
and writes to adopter-owned `app`. Its bounded SQL predicate accepts additive
object creation, `ALTER TABLE ... ADD`, transaction boundaries and literal
`INSERT ... VALUES ... ON CONFLICT ... DO NOTHING` seeds with a single literal
VALUES list immediately after the target name and optional plain column list.
`CREATE SCHEMA [IF NOT EXISTS] name` takes no schema elements; expand-only
statements take no `OWNED BY` clause. Quoted identifiers are not seed literals
or conflict keywords. The original `ALTER TABLE ... ADD` checks remain required
alongside expression checks. New checks only add refusals before base admission.
Type parentheses require a listed built-in modifier type; square brackets are
limited to empty `[]` suffixes at verified type positions. Array constructors
and subscripts refuse before element splitting. Procedural or dynamic SQL
and unsupported forms refuse; see [Versioning and EOL](../../.github/VERSIONING_AND_EOL.md#publish-refuse-and-recover)
for the exact admission boundary. Passing admission does not prove N-1 or live
schema compatibility. Test the actual selected chain, constraints and replay.
Expand-only admission refuses query-bearing `CREATE TABLE`, `PARTITION OF` and
`LIKE`, operator references and function calls in default, check,
generated and index expressions other than a short allowlist of side-effect-free
built-ins; it is a bounded classifier, not a general SQL analyser.

Rows that platform behaviour depends on must ship as idempotent statements in a
forward, rather than relying on a reference fixture or process startup. A missing
twin in the other chain is a documented compatibility gap, not implicit parity.

## Module catalogues and installed histories

Fulfillment appends native command and alignment units,
`20261022080000_fulfillment_command_ledger.sql` and
`20261022090000_fulfillment_delivery_alignment.sql`, after the shipping seed.
`FULFILLMENT_MIGRATIONS` projects units 5, 27, 51, 73 and 74 with canonical identities and byte-identical package assets. Install the
complete catalogue, preserve the full installed prefix and verify its live
object inventory; the sparse projections are not an install chain. Existing
native and managed migration bytes remain unchanged.

For a fresh native install, the invariant "a late delivery extends the next cycle"
is enforced automatically only when delivery-alignment control mode is
`auto_align`. `public.subscription_delivery_alignment_control.mode` defaults to
`off` for rollout safety, so installation alone does not enforce the invariant.
The complete mode set is `off`, `shadow`, `protect` and `auto_align`, selected
through `public.subscription_delivery_alignment_set_mode`. Existing cases retain
their captured mode and protection after a control change.

Enforcing modes (`protect`, `auto_align`) require the host's renewal path to call
`subscription_delivery_alignment_admit_renewal` before inserting the cycle.
The [native renewal store](../../server/adapters/postgres/subscription/automaticRenewal.ts)
retains its static terms gate. A host that composes the native automatic-renewal
runner must wrap its store port with the
[admission decorator](../../server/runtime/subscription/deliveryAlignmentRenewalStore.ts)
before selecting an enforcing mode; an uncomposed
new-cycle insertion refuses with `subscription_delivery_alignment_admission_required`.
Until the host wraps that port, native delivery-alignment mode stays `off` or
`shadow`. The supplied boundary stops at the decorator, with no runner composer,
factory or production entrypoint. Captured protection survives rollback to `off`.

In enforcing modes, a subscription whose paid history has no activation or
renewal link, such as imported data, holds every due renewal for manual review.
Operators should check for such cycles before switching modes.

The command forward adds durable dispatch/attempt/paid-handoff and observation
receipts. Atomic ACK records the native `dispatch` external reference: the `3pl`
archetype does not create an owned label, and acceptance cannot imply physical
packing. That receipt also retains the native local-cancellation refusal.
Observation persistence distinguishes received observations from recorded status
evidence; only the latter supplies local occurrence chronology. Stock movements retain opaque
keys and replay fingerprints, while sync cursor state retains coverage gaps.
Host inventory lines and authoritative contact preparation remain injected.

The alignment forward translates managed fulfillment rows to native shipments,
replacement links to `replaces_shipment_id`, and subscription identity through
order → cycle → subscription. The effective cycle ordinal
comes from renewal operation numbering or the explicit activation-order link.

[The native translation decision](plans/oss-m08-fulfillment-physical-delivery.md#native-admission-and-delivery-alignment) maps donor activation cycle 1 ↔ native activation ordinal 0, and donor
renewal n+1 ↔ native renewal n. The activation ordinal requires a cycle with no
renewal operation whose linked order is the active `subscription_activations`
row's order for the same subscription. Renewal operation numbers remain ≥1.
Admission selects the highest known paid ordinal, so activation protects the
first renewal and each later paid renewal outranks activation. Successor
artifacts have a greater effective ordinal. Other unnumbered cycles remain
unordered: paid ones require manual review at due admission without minting a
receipt; other unordered cycles prevent automatic arrival alignment regardless
of scheduled date. They neither outrank known predecessors nor silently permit
an autonomous renewal. Shadow mode observes this ambiguity without blocking.

Local pre-dispatch cancellation changes only the shipment locally: alignment
creates no hold or shipment-exception event and does not block other shipments
of the order. An undelivered, unsuperseded cancelled parcel still counts as
outstanding at renewal admission in `protect` and `auto_align`. An explicit
provider exception uses the existing fulfillment-exception hold and notification
rules; alignment observes that active hold to open a case only when control is not
`off`, the order belongs to a paid subscription cycle and the subscription is
active. One-time orders do not open alignment cases. Exception cases never
pause subscriptions.

Existing-cycle renewal and dunning
retries bypass new-cycle admission and receipts. The new-cycle INSERT guard
retains exact schedule-bound, one-use receipt consumption. Default-off control
does not erase captured protected cases. Only durable arrival can settle the
automatic route, using the latest arrival plus cadence with the outer maximum.

All new routines are invokers with PUBLIC/anon/authenticated access revoked,
including helpers and trigger routines. The initial native executor is the
existing deployment owner; no role, SECURITY DEFINER, default grant or browser
capability is added. A separate service principal requires the maintainer's
explicit least-privilege grants on routines and underlying objects; owner
execution does not establish a non-owner grant set. Receipt pruning needs DELETE
on that receipt table if such an invoker is configured. Replacement confirmation remains a note-only operator
attestation with no automatic caller or new arrival predicate. The
[arrival-only discipline](plans/oss-m08-fulfillment-physical-delivery.md#native-admission-and-delivery-alignment)
remains binding.

Payments publishes `PAYMENT_MIGRATIONS` as byte-identical projections of canonical
positions 10 (settlement), 35 (truth/reconciliation) and 56 (later-only cycle).
Each retains its canonical path, SHA-256 and package asset URL. These three assets
are not an install chain: install the complete catalogue and preserve its exact
ledger prefix. No migration or manifest row is added. `paymentSchemaDescriptor`
declares direct truth, settlement and later-only alignment supported; durable
prepared attempts, method setup, absence reopen and cumulative refund unsupported.
Refunds are purely financial and do not cancel subscriptions. The direct truth
store retains its invoker SQL and requires the host's existing executor and
privileges; descriptor presence alone does not prove installed schema readiness.

`CATALOG_MIGRATIONS` additionally projects existing canonical catalog positions
1, 8, 58, 59 and 61: read foundation, storefront attributes, document/identifier
and subscription price-policy foundation, its validation, and isolated drafts.
Each descriptor keeps the canonical path, position, digest and byte-identical
package SQL. There is no new migration, reordered history or manifest edit.
Install and observe the complete selected catalogue; these five projections do
not supply an independent installation sequence. The package envelope and draft
stores keep their incumbent SQL and refusal semantics after the source move.


Inventory publishes sparse byte-identical projections of canonical units 27
(stock evidence) and 33 (automatic renewal) through `INVENTORY_MIGRATIONS`.
Canonical paths, positions and SHA-256 remain unchanged; this adds no migration
or manifest row. Install the complete catalogue. The [M06 store matrix](plans/oss-m06-stock-reservations-delivery.md#parity-pending-rows)
separates native observed-stock operations from managed lot-based inventory,
refusals and outstanding real-host proof. Subscription/payment/delivery writers
remain at their incumbent boundaries; these projections install no schedule.

Catalog's `BUNDLE_MIGRATIONS` projects canonical bundle units 16 and 19 with exact
catalogPath, position, SHA-256 and artifact URL. The package SQL bytes are identical
to the canonical files; this is projection only, with no new migration, manifest
row or baseline change. Unit 30 belongs to channel lines and is not included.
Install the full canonical chain, not these two files alone. The moved native
store performs reads only; existing canonical write routines remain in place.
Five real-PostgreSQL cases characterize fresh/repeat application, complete reads,
whole-set rollback and refusals, dry runs, close-and-append prices, sequential key
recognition and denied versus explicitly granted invoker access. They establish
only the incumbent native subset: the database still has no independent human-only
actor-kind gate, and no concurrent replay or mounted parity is claimed.

Promotions publishes sparse, byte-identical projections of canonical units 47 and
48: promotion claim lifecycle and its constraint-validation forward. The module's
`PROMOTIONS_MIGRATIONS` descriptor retains each canonical catalogPath, position,
SHA-256 and artifact URL. This move adds no migration, baseline change or manifest
row. Install the full canonical catalogue rather than the sparse projections.
The native executor-backed store owns only evaluator reads and bounded sweep;
claim reservation/writing remains at its existing boundary. Real PostgreSQL proof
checks fresh canonical application/replay, read-only evidence, paid/released
transitions, sweep replay/fences and unauthorized versus explicitly granted reads.
It does not establish native code resolution or native/managed eligibility parity.

Direct OIDC principals fit the existing UUID `clients.principal_id`; the
versioned issuer/subject hash adds no table, forward, catalogue position or ledger
change. The direct account-link capability uses normal reconciliation and
parameterized DML, fills only null links and refuses normalized-email ambiguity.
Privacy receipt locking prevents recreation or relinking of erased principals.
It never converts legacy links, managed auth IDs, membership or subscriptions.
The opt-in real-issuer runner installs the full catalogue, checks exact ledger
rows and proves replay and preservation of existing application state. Its
[identity recipe](IDENTITY.md#real-issuer-oidc-recipe) requires real local services.

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
contents nor subscriber survival across SQL replay. The committed managed chain
includes `20261018160000_identity_service_role_capabilities.sql`; the runner proves
association under those shipped grants, as described in
[identity conformance](IDENTITY.md#conformance-and-outstanding-evidence).
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

The separate `batchedForwards` list approves the frozen M10/F17 packet: five
native files and nine managed files. It adds no installation-chain SQL. Exact
future bytes live only in [inert fixtures](../../scripts/fixtures/reviewed-m10/).
The [registry](../../config/reviewed-platform-forwards.json) records each full
path, SHA-256, ordered statement hash and exact function identity with raw
before/after CREATE hashes. Non-function statements additionally carry their
exact SQL, including every grant target, recipient, absorption row and seed.
The checker fixes the ordered path/signature inventory separately from that data.

This batch covers four native creations (retry, commands, stock wait and the
M06 ATP/new-purchase seam), one native allocator body replacement, managed seam,
stock-wait and refund-evidence creations, and the six managed replacement files.
The managed creation includes its one table, index, RLS enablement, service-only
grants and blocking `client_absorption_policy` row. The only new existing-table
column grant is `SELECT (id, retry_attempt)` on `subscription_cycles` to
`service_role`. The lifecycle-message forward replaces exactly
`private.outbox_resend_event_types()` and its two public companions, and seeds
only the enabled `subscription-stock-wait-started` / `subscription-stock-wait-resumed`
notification controls with `ON CONFLICT(slug) DO NOTHING`.

Timestamp aliases share identity within this class (`timestamptz` and
`timestamp with time zone`); raw definition hashes retain the original spelling.
The due reader chains M2 → M4 and the payment applicator M1 → F17: each later
before hash must equal the earlier after hash, and admission reads the actual
preceding rail in filename order. Per rail, pins land as a prefix in version
order: native P2 (160000) → P4 (170000) → P5 (180000, 183000, 184000),
and managed P3b (155000, 160000) → P5 (175000–184000) → F17 (185000, 185100).
Every earlier same-rail pin must already exist at the candidate head with its
whole-file pinned digest; a later landing cannot skip an absent pin.
Missing, duplicate or extra signatures, preimage drift, reordered chains, unpinned private objects, extra/wider grants,
changed bytes/paths and unexpected statements refuse. The native allocator
admits exactly one replacement with an unchanged header and ACL, including its
pre-existing PUBLIC EXECUTE default; this approval does not harden that default.

The lexer is only a pre-filter. The mandatory
[real PostgreSQL/pgTAP catalog gate](../../tests/postgres/reviewedBatchForwards.test.ts)
uses native PostgreSQL 16 and managed PostgreSQL 17/pgTAP. Per rail it applies
all committed rail files in filename order through the last pin, including
unpinned files interleaved between pins. Pins use landed or fixture bytes exactly
once; landed pins must form a prefix before the absent fixture suffix. A landed
rail file must be byte-equal to its inert fixture; an absent file uses the fixture. Each forward runs once, before and after feature landing.
It compares `pg_proc` metadata and bodies, `pg_class` and `pg_attribute` relation
and column ACLs and RLS; snapshots also compare `pg_namespace`, `pg_type`,
`pg_trigger`, `pg_policy`, `pg_default_acl`, `pg_roles`, `pg_auth_members`,
`pg_constraint`, `pg_index`, `pg_rewrite`, `pg_foreign_server`, `pg_event_trigger`,
`pg_extension` and `pg_description`, plus all public/private ordinary-table rows.
Only the pinned creations, replacements, column grant, absorption row,
notification rows and refund-function comment may change. Rollback must restore
the complete prefix. Committed plants falsify both admission and the catalog
observer, including authenticated EXECUTE on a pinned new function, an altered
native allocator ACL, and a repinned managed index on an existing table. Missing
Docker, PostgreSQL or pgTAP fails the required `test` aggregate; a lexical PASS
cannot replace this gate. The managed setup budget includes its first image pull.
These batch rules do not broaden the earlier #267, #295 or #300 classes.
Coordinator control review and two fresh reviews remain separate delivery gates.

**Named bounded debt C94 — M10 reviewed packet vocabulary.** The frozen managed
SQL retains provider nouns inherited from that rail. The neutrality baseline
records the scanner's exact counts for the six existing managed fixtures and the
registry's pinned refund COMMENT: dunning continuity (`ui-13`: 2, `ui-14`: 3),
ATP (`ui-15`: 3), stock wait (`ui-15`: 6), allocator (`ui-15`: 2), refund evidence
and refund parity (each `ui-13`: 7), and the registry (`ui-13`: 1).
Each landing PR (P3b, P5, F17) adds only its own rail keys together with the files,
using these exact pinned counts per category. Any present baseline key for an
allowance path must contain exactly its pinned category counts, including during
regeneration; adding a key without the file refuses. No native,
TypeScript, package or documentation allowance is added. This is vocabulary
debt for the frozen packet, not provider activation or portable-contract parity;
future neutral replacements must lower it. The [neutrality owner](../../CONTRIBUTING.md#package-policy-and-release-checks)
owns the ratchet. Its `reviewedPinnedIntroductions` allowance is a closed list of
exactly 13 paths (six fixture/rail pairs and the registry), grouping the two
dunning categories per path. Each SQL pin requires the complete file's SHA-256
and exact category and before/after counts, on any base. The registry instead
pins the exact refund COMMENT text because later approvals edit unrelated
registry data; extra counted vocabulary still refuses. The allowance filters
measured-base increases and parent-baseline raises, including regeneration;
candidate counts must still fit the baseline. Changed bytes, another path even
with the same digest, another category or count, and unrelated increases refuse.
No native rail, TypeScript, package or documentation path can enter this list.
Adding any further entry is a control change needing two fresh Opus reviews plus
the coordinator's control read. The six rail-path entries can be retired after
the F17 PR lands and the base carries the counts.

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

The optional `portableReplacementForwards` list includes the exact forward to
keep active subscriptions active on dunning exhaustion (invariant repair).
Its only function is
`public.dunning_lifecycle_handle_failure(uuid,timestamptz,text,text,integer,timestamptz,text,text)`,
fixed in checker code independently of the registry. Prior definitions come only
from the portable baseline and earlier portable forwards in strict filename
order, as required by the manifest. Exact path, file and before/after definition
hashes must match; arguments, return, volatility, security and settings remain
unchanged. Only comments and that single `CREATE OR REPLACE FUNCTION` are
admitted, with approval preceding introduction; no privileges or other statements
are allowed. This control approval adds no SQL file or runtime behavior.

The separate `portableCreationForwards` class binds these portable paths and
whole-file SHA-256 digests in the same allowlist:

| Path | SHA-256 |
| --- | --- |
| [db/platform/migrations/20261022080000_fulfillment_command_ledger.sql](../../scripts/fixtures/20261022080000_fulfillment_command_ledger.sql) | `c6806906cdb0b6931b29f7a5c7c800016e98d04e6ea956f3c1e219a6cdb7e9d1` |
| [db/platform/migrations/20261022090000_fulfillment_delivery_alignment.sql](../../scripts/fixtures/20261022090000_fulfillment_delivery_alignment.sql) | `d9966ae79fe77a0feae8317dc5b46ef2d8196dd0790b1cd0ee1b06ab58061499` |

The three additional M09 creation pins are listed in the
[M09 control preparation section](#m09-invoicing-forward-design-and-control-approval) and the registry.

It admits new public tables, indexes on tables created in the file, invoker
functions, views, and row triggers. Relation, function and trigger names must
be absent from the portable baseline and preceding portable forwards; duplicate
creations also refuse. Function row arguments and returns may use tables created
in that file. Function bodies and expressions are bound by the whole-file hash;
the statement classifier does not establish their behavioral correctness.
Functions use SQL or `plpgsql` with `search_path = pg_catalog`, default or explicit
invoker security and the admitted volatility attributes. Trigger functions must
be created in the same file, accept no arguments and return `trigger`.
Table and index statements must also pass the expand-only predicate. For these
pinned new tables it accepts scalar comparison/regex operators, casts, and
foreign-key `ON DELETE CASCADE` or `ON DELETE SET NULL` actions; inheritance and
its other refused keywords remain excluded. Outside dollar-quoted bodies,
backslashes, `E'...'` and `U&` escape strings/identifiers refuse. Standard strings
and quoted identifiers use doubled quotes; multiline quoted sections and quoted
identifiers containing `;` or `$` refuse. Nested block comments and named dollar
tags also refuse: these forms are not needed by the pinned files. Any other `$`
outside strings or comments refuses; a dollar body opens only as `AS` followed
by whitespace and `$$`. Non-ASCII outside strings, comments and dollar bodies
also refuses, including in quoted identifiers. Line comments
end at the next line feed regardless of quotes inside the comment. A function
body uses `$$` and ends at its first closing `$$`; only whitespace and the
terminating semicolon may follow.
New triggers may attach to existing public tables, including
`commerce_order_holds`, `fulfillment_shipments` and `subscription_cycles`;
this admits a new trigger attachment, never replacement of an existing trigger.
The [disposable catalog proof](../../tests/postgres/reviewedPortableCreation.test.ts)
applies each pinned fixture after its portable prefix and checks invoker security,
new-object ACL entries, unchanged earlier relation/function definitions and the
exact explicit trigger attachments with functions created by that file.

Seed `INSERT` is admitted only into a table created in the same pinned file,
using the existing expand-only predicate: literal-only `VALUES` with
`ON CONFLICT ... DO NOTHING`, without subqueries, functions or procedural `DO`.
Inserts into pre-existing tables, `INSERT ... SELECT` and
`ON CONFLICT ... DO UPDATE` refuse.
Only `REVOKE ALL ... FROM PUBLIC, anon, authenticated` (or subsets of those
recipients), comments on objects created in the file, and `BEGIN`/`COMMIT` are
otherwise admitted. Revocation targets must also be created in that file.
Unpinned paths, changed bytes, `CREATE OR REPLACE`, `ALTER`, `DROP`,
`SECURITY DEFINER`, grants to any role (including `PUBLIC`, `anon` and
`authenticated`), references to pre-existing objects in comments or revocations,
and all other statement forms refuse. Approval must precede both the feature
comparison base and the SQL introduction parent. This class does not change
the managed or portable replacement classes or install runtime permissions.
The exact future file bytes are also kept as
[command-ledger](../../scripts/fixtures/20261022080000_fulfillment_command_ledger.sql)
and [delivery-alignment](../../scripts/fixtures/20261022090000_fulfillment_delivery_alignment.sql)
test snapshots; snapshots are not installation-chain entries.

[The shared checker](../../scripts/reviewed-platform-forward.ts) verifies the
immutable managed baseline hash, each old definition and each new definition.
A definition hash covers the raw `CREATE` statement through its terminating
semicolon; names and defaults remain in those bytes, while signature identity
uses argument types. Whole-file hashes additionally bind comments, grants and
all other SQL. Earlier forwards are considered when checking the old definition.
Missing or duplicate signatures, another path, and any changed byte refuse.
Both gates refuse control characters other than tab and line feed in reviewed SQL forwards (parser parity).
For managed forwards outside the pinned function bodies, only function definitions, transaction
boundaries, privileges and comments on functions defined in that same file are
accepted. Grants may target only `authenticated` or `service_role`; grants to
`PUBLIC` or `anon`, other schemas, unrelated statements and unterminated dollar
bodies refuse even if the whole-file hash was separately repinned.

The optional runtime list pins one or two additional forwards. Its first entry
pins exactly five existing functions: the `admin_clients_search_v3` and `subscription_list_due_for_renewal`
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
repinning the first runtime forward cannot admit additional capabilities,
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

The optional second runtime entry admits only the identity capabilities forward,
with no functions or policy retirements. Its fixed service_role-only capabilities
are INSERT on `clients` columns `email`, `auth_user_id`, `acquisition_source` and
`lifecycle_stage`, and UPDATE on `auth_user_id`. Reconcile create/link and the
checkout soft-account link consume them; other columns keep their defaults.
Operator activation consumes INSERT on `admin_users` columns `id`, `email`,
`role`, `membership_state`, `membership_provenance` and `membership_accepted_at`;
`is_machine_actor` keeps its false default. Invitation eligibility and conflict checks consume
SELECT on `admin_users.email` alongside the first entry's membership reads.
Browser roles gain nothing; the approved identity forward now ships in the managed chain.

Required PR/merge-group self-check requires the whole allowlist to remain unchanged
from the feature comparison base. Release prepare compares each forward's own
entry and list position, and every registry field outside the forward lists
(schema version, baseline hash and any other key), with the first parent of the
mainline commit, squash or merge, that introduces it; a feature branch's own
earlier commits do not count. Only other forwards' entries may differ, so a later
control may append approvals without stranding an unreleased forward. A feature still cannot approve itself. Missing history refuses. Existing
history, version and manifest rules still apply. The expand-only predicate also
refuses `INHERITS`, preventing a new table from inheriting an existing one.
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

The managed singleton seed has no portable twin. The native chain carries
delivery alignment in its own
[`fulfillment_delivery_alignment` forward](../../db/platform/migrations/20261022090000_fulfillment_delivery_alignment.sql),
which creates the control row with mode `off`; `auto_align` enables the
late-delivery invariant. Native store and real PostgreSQL conformance tests
cover admission and arrival alignment. These checks do not establish
installation-path parity, a complete installed late-delivery journey or a
stable upgrade guarantee.

## Compatibility lifecycle

The native `20261022160000_subscription_retry_lifecycle` forward adds three
subscription retry ledgers and nine invoker functions. Install it through the
complete ordered native manifest; its package SQL projection is byte-identical.
This is N1, the F16 repair for terminal renewal declines that previously removed
an active subscription from the due list indefinitely. It adds neither N2
commands nor N3 stock wait. Disable the retry driver before rollback and retain
the ledgers for reconciliation; do not delete refusal or payment history.

The retry ledger keeps the original operation, cycle, order, settlement, schedule
and snapshot. Retry zero is the original attempt. Failures one, two and three
schedule +24, +72 and +168 hours from each failure; four exhausts the ladder.
A terminating class can clear the retry earlier. Exhaustion leaves an open case,
null retry and active subscription. An authorized same-case token and durable
healthy-method evidence can re-offer the original obligation. Verified M07
positive evidence settles that obligation and advances its native counter once,
using the later-only schedule clamp. SQL performs no provider calls. Prepared
receipts fence dispatch even when the acknowledgement was lost.

Initial case-before-outcome handoff and subsequent retry failure are different
transaction routes. N1's `subscription_retry_open_case` requires an existing
failure row, while its initial `subscription_retry_apply_failure` can record the
terminal outcome. The package binding opens the donor-keyed existing dunning case first, then
attaches N1 bookkeeping inside the M07 terminal transaction, linking the same
case. It never applies the initial money result twice; any bookkeeping failure
rolls the terminal transaction back for safe replay. Hosts supply its
transaction executor and evidence-bound correlation; no runner is activated.


Fulfillment expands the native graph with new command and
alignment objects at positions 73/74. It preserves all position-0–72 identities,
existing rows and the managed graph. Upgrade the complete prefix before enabling
the new stores; sparse package assets are projections only. Default-off alignment
creates no cases during upgrade. Code rollback retains accepted dispatch proof
and already extended dates; repair those facts forward. Invoker-only owner
execution adds no browser privilege or service account. The
[module catalogue notes](#module-catalogues-and-installed-histories) distinguish
native dispatch commitment, missing correlation and future service grants.

The portable forward
`20261021120000_dunning_lifecycle_active_repair.sql` appends position 71 to keep
active subscriptions active on dunning exhaustion (invariant repair). Its exact
bytes are bound by the manifest SHA-256; it replaces only
`dunning_lifecycle_handle_failure`, with no stored-row rewrite or change to
preceding migration bytes, positions or privileges. Exhaustion leaves the case
open and repairable, with its final notice and event; it changes no subscription,
pause window or cycle dates. The [real-PostgreSQL proof](../../tests/postgres/dunningLifecycleActiveRepair.test.ts)
covers complete-catalogue fresh install, exact position-70 prefix upgrade with
existing rows, ledger replay, exhaustion/recovery and browser EXECUTE refusal.

Native shipping appends the seed-only forward
[`20261021200000_shipping_flat_rate_seed.sql`](../../db/platform/migrations/20261021200000_shipping_flat_rate_seed.sql)
at position 72. It inserts `shipping_flat_minor = 0` only when absent, preserving
an existing rate and every ACL and role membership. The named role-free shipping
lane owns fixed-key read/update statements; no service role or grant is added.
Supply the native rate port, a passing Core required-schema readiness report and
its same-database `nativeRateSchema` observation before enabling the binding.
The reference probe checks the seed's position, path and SHA-256 in the ledger,
plus the settings table and columns; later ledger entries are permitted.
Candidate labels alone prove nothing. An unmigrated schema keeps
`shipping_native_flat_rate_save_unsupported`. A missing setting row refuses with
`shipping_native_flat_rate_row_required`, never a successful zero-row update.

Native audit is unsupported and remains best effort: the incumbent handler
swallows `shipping_native_flat_rate_audit_unsupported` after a successful save.
The bundle principal ledger only accepts bundle actions; no generic portable
audit routine can record `shipping_rate_change`. No durable shipping-rate audit
is claimed. Managed rate authority remains pending and unchanged.

Old application code ignores the seeded row. Older migration runners refuse the
extended ledger, as with every forward; an application rollback does not reverse
the migration or establish older-runner startup compatibility.
[Native shipping conformance](../../tests/postgres/shippingNative.test.ts) covers
fresh install, exact pre-seed position-71 upgrade/replay, readiness, denied browser/PUBLIC
access, whole-catalog ACL/membership equality and missing-row/audit failures.

C-compose adds no SQL or manifest entry. Its direct schema requirement names the
full position-70 prerequisite, consent authority, existing outbox/receipt/control
objects and all five native tables/used columns. The host independently observes
the full installed ledger; object presence alone never substitutes for it.
Native preference persistence uses the existing consent row plus the existing
sync registration inside one owner-authority transaction. Repeated preferences
reuse work for the current permission revision and binding; state transitions
produce a new ordered event. Runtime effective-privilege refusals remain required.

Native communications appends
[`20261019200000_communications_native_operations.sql`](../../db/platform/migrations/20261019200000_communications_native_operations.sql)
at position 70. Its five CREATE-only tables store network targets, immutable
observations, a nonqueue outbox sync sidecar, notification recipients and policy
decisions. Existing consent truth and all earlier forwards remain unchanged.
Deploy the complete schema before selecting the factories; rollback of application
code leaves additive objects and prior data intact. Sparse package projections
are not an install chain. The live selected-catalogue digest is refreshed from
real PostgreSQL. [B3 conformance](../../tests/postgres/communicationsNative.test.ts)
checks exact position-69 upgrade with durable state, fresh install, runner replay,
ledger tamper refusal and clean/poisoned default and inherited ACLs. Runtime
refusal on unsafe effective privileges is required: this forward changes no grants,
functions, triggers, old objects or classifier rules.

Reference identity composition adds no SQL or ledger entries. Direct startup
requires the complete canonical catalogue through identity erasure receipts,
never the sparse seven-file package projection. Its schema inventory is a
presence check; hosts must independently observe the complete installed ledger.
Managed startup likewise needs trustworthy committed-chain observation and
separate effective-grant verification. The reviewed managed identity service-role
capabilities forward supplies client INSERT(email, auth_user_id,
acquisition_source, lifecycle_stage), UPDATE(auth_user_id), and operator
INSERT(id, email, role, membership_state, membership_provenance,
membership_accepted_at) plus SELECT(email). The opt-in conformance runners add no
fixture grant, and application startup adds no grants.

Reference customer browser sessions use separate storage namespaces without
migrating legacy credentials. Managed logout clears the effective SDK store
even after remote revocation fails. A failed compatibility session read returns
`null`, allowing guest checkout without a bearer; provider bootstrap still
reports the failure. These browser operations add no database session rows and
require no schema migration or rewrite of stored customer links. See the
[browser session contract](IDENTITY_BROWSER_REFERENCE.md).

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

The managed chain's identity capabilities forward
`20261018160000_identity_service_role_capabilities.sql` grants `service_role`
SELECT(email) and INSERT(id, email, role, membership_state, membership_provenance,
membership_accepted_at) on `admin_users`. The insert omits `is_machine_actor`,
relying on its `NOT NULL DEFAULT false`. The opt-in
[managed conformance module](../../tests/postgres/operatorInvitationManaged.conformance.ts)
replays the complete committed managed chain into a fresh disposable local stack
with ambient default ACLs removed and adds no grant. It proves immediate
activation, repeat/concurrent recovery and revoked-member refusal under the
shipped grants. It does not establish managed/direct lifecycle parity.
The [package guide](PLATFORM_PACKAGE_REFERENCE.md#operator-invitations) gives
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

The portable position-71 dunning invariant repair has no managed twin yet.
The managed baseline's
`subscription_handle_payment_failure_dunning_before_cancel_fence` still pauses
an active subscription on exhaustion. This is a known managed gap: a separate
managed forward is required to keep active subscriptions active on dunning
exhaustion (invariant repair). Portable fresh/upgrade proof does not establish
managed parity.

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

## Identity reference grants

The disposable identity reference adds no migration. Its managed installed
acceptance requires the separately reviewed forward
supabase/migrations/20261018160000_identity_service_role_capabilities.sql.
Once present, that forward supplies `clients` INSERT on `(email, auth_user_id,
acquisition_source, lifecycle_stage)` and UPDATE on `auth_user_id`, plus
`admin_users` SELECT on `email` and INSERT on `(id, email, role,
membership_state, membership_provenance, membership_accepted_at)`.
Until it is present, installed managed acceptance refuses. Existing labelled
fixture-only grants in adapter conformance remain fixtures and cannot establish
that the shipped chain supplies these permissions. The acceptance runner adds
no compensating grants and never writes a fabricated native migration ledger.

## Communications projections

`COMMUNICATIONS_MIGRATIONS` carries byte-identical projections of the existing
canonical comms outbox, transactional receipt and communications control-plane
units at positions 2, 9 and 20. Their hashes, runner positions and canonical paths
are checked against the unchanged manifest. They are a sparse module inventory,
not an independent install chain or a new forward. The full selected canonical
prefix and existing schema probes remain required. Managed receipt RPCs retain
their current service scope; direct receipts retain one role-free transaction per
operation and their accepted/failed replay boundaries.

The narrowed import moves receipt stores and their ledger contracts. Reference
mail-provider timeline/send-ledger implementations remain at their existing
owners; no provider mapping or new schema enters the package.

## M09 invoicing forward design and control approval

Status: design and fixture-only control preparation. These seven fixtures do not
install SQL, append manifest rows, publish package assets or activate invoicing.
The feature changes must introduce exactly the approved bytes later. A changed
byte requires a separate reviewed control before introduction; the self-approval
refusal remains binding in both CI and release preparation.

Three additional native creation pins cover durable duties, document effects and
seller revisions. New functions are invokers with `search_path = pg_catalog`;
new tables, views and functions revoke PUBLIC, anon and authenticated access.
There are no new native triggers, definers or grants. The host must explicitly
bootstrap its executor's least privileges; these fixtures grant no browser or
service principal access. Install the complete native catalogue, never sparse
package projections independently. Native versions are `20261022190000`,
`20261022191000`, `20261022192000` and `20261022195000`; managed versions are
`20261022193000`, `20261022193100` and `20261022195100`. All sort above M10's
last planned forward, `20261022185100`, preserving M09's internal order.
The staged native manifest currently appends positions 75–78 after fulfillment
alignment at 74; integration must place them after M10's native units and
recompute function preimages against that complete preceding rail.

The fourth native pin is the single exact replacement of
`payment_truth_apply_terminal(uuid,text,text,timestamptz,text,text,jsonb,text,text,text)`.
Its declaration/settings and every statement outside the former accounting block
remain unchanged. That block captures an `invoicing_duties` obligation and exact
source/key receipts in the money transaction without consulting accounting
objects. Captured settlement and dunning recovery therefore survive accounting
failure. Capture uses a nonblocking advisory lock and a 100 ms lock timeout;
its subtransaction catches conflicts, permission failures and cancellation without
rolling back settlement or dunning. An append-only capture-fault marker is visible
in readback. If the payment principal lacks marker privileges, the retained paid
transition itself remains durable rediscovery evidence. Bootstrap capture and
fault-table privileges explicitly.

`public.invoicing_sweep_duties(integer)` collects retained settlement and handoff
sources and returns fact-installation leases. The host commits that short claim
transaction before calling `invoicing_prepare_facts(uuid,uuid)` for each lease,
commits its accounting transaction, then records the result with
`invoicing_finish_facts(uuid,uuid,jsonb)` in a separate short transaction. Do not
wrap these calls in a shared transaction. `invoicing_install_facts(uuid,jsonb,text)`
stages immutable facts only. This reuses the outbox claim/token/visibility pattern:
SKIP LOCKED claims, five-minute leases, eight attempts, exponential backoff from
60 seconds capped at one hour, and a visible `faulted` terminal state. Expired
claims recover without retaining order/duty locks across accounting work. Prepare
holds no explicit order/duty row lock, bounds unavoidable database waits to 100 ms,
and preserves the incumbent deterministic document reference. Host keys remain
exact in duty/receipt/metadata; the internal document operation uses the stable
duty identity so two intents may legitimately reuse a host key.
Accounting errors keep the fact revision and owed duty durable; missing host facts block
document work. The host supplies buyer, lines, money, tax, dates, references and
policy version rather than interpreting legacy zero-tax positions as fiscal
facts. Payment readback keeps `accountingRequested=false` for new unlinked
settlements; historic linked IDs and settled-event replay remain unchanged.
M09 does not write invoice evidence back into payment truth.

`public.invoicing_duty_readback(uuid)` reads an order's base and correction duties
without reading accounting tables or changing payment truth. It returns duty,
parent and document IDs, state, attempts, creation/availability/lease timestamps
and a nullable diagnostic code. Ready work reads as `owed`; processing reads as
`claimed`. Other persisted states (`owed`, `blocked`, `unknown`, `issued`,
`voided`, `unsupported`, `faulted`) remain visible. The closed diagnostic allowlist is
`missing_facts`, `legacy_facts_unproved`, `retryable`, `blocked`, `unsupported`,
`unknown`, `absent`, `faulted`; other kinds return null. Raw SQLSTATE, provider evidence and
claim tokens never enter this readback. Fact-install attempts are separate from
provider generations. `captureFaults` exposes source ID, retry/fault state, attempt
count and next availability; a retained source receipt changes its readback state to
`resolved`. Raw errors remain excluded. Source capture failures
have their own eight-attempt/backoff ceiling, so one poisoned source cannot starve
later sources or fact retries. Empty orders return an empty duty list.
Execution remains restricted to the explicitly bootstrapped trusted host.

Duty and delivery claims accept a trailing optional order UUID, as does the
seller claim wrapper. The predicate runs before row locks and LIMIT; targeted
recovery never leases unrelated orders. Omitting it retains batch behavior.
Clearance observations already record `not_submitted`, `pending`, `accepted`,
`rejected`, `not_required` and explicit unsupported observations; polling targets,
per-target orchestration and national mappings remain host/package work.

Policy suppression and operator skip outcomes can be retained in the existing
native effect-receipt ledger by the trusted host transaction. Source receipts
stop rediscovery; withheld fact installation keeps suppressed work unclaimable.
The host owns policy decisions, terminal outcome vocabulary and replay checks;
this SQL does not infer permission to issue from a source alone. No additional
native object or payment-truth mutation is needed for these receipts. Account
invoice history likewise uses a host query over existing order ownership,
documents, correction parent links and immutable facts; the host must authorize
the account before projection and refuse missing fiscal facts. No browser grant
or SQL history endpoint is added.

The existing `accounting_document_request_from_paid_order` and its reference
PostgreSQL adapter retain their local scope, response, document reference and
replay. Generic descriptions and zero-tax positions remain usable locally;
fiscal execution still requires proven facts and must refuse to adopt an
unproved local document rather than create a competing invoice. Fact completion
checks neutral facts and totals before adopting an unowned document. An
unsupported result requires existing document evidence and remains visible with
its diagnostic reason. Reversal refuses to void an unlinked live base document
or discard an attempted request; blocked duties return terminal `unsupported`.
Only ready, pending, unattempted correction requests are hidden from the incumbent.

Before installing, retire the incumbent issue/correction executor. Drain the
legacy managed correction worker first; reconcile any attempted or processing
legacy correction against provider evidence, recording its actual outcome before
cutover. P3 must migrate `accountingInvoicePort` and `accounting_paid_reversal_test`
to v2 (`p_contract_version`, `p_claim_attempt_count`), throw on `ok:false`, add an
adapter test and give attempted legacy corrections a visible reconciliation state.
This adapter migration is a prerequisite for introducing `20261022193100`; it is not part
of fixture-only control preparation. The managed `ksefRequired` key is retained
for donor parity as a country-specific key, not a neutral native requirement.

M09 request rows use `available_at='infinity'` at prepare, claim and fail,
including corrections, so the incumbent queue cannot lease them. M09 also checks
request attempts/token against duty generation/token and marks drift unsupported.
Seller requests run in their own short transaction: a nonblocking per-order
advisory lock precedes the order row lock. The 100 ms lock timeout remains in
effect through duty capture and seller insertion, then the wrapper restores the
caller's timeout before returning.
The payment capture block absorbs `query_canceled` (including a client or statement
timeout arriving inside capture) so settlement/recovery can commit. Its fallback
marker insertion has its own 100 ms lock bound; host cancellation outside this
block retains PostgreSQL's ordinary behavior. Successful sweep restores the
caller's lock timeout.

The install cutover records existing settlement/handoff identities once because
these rails have no insertion timestamp and host occurrence times may arrive late.
The keyed `(source_kind,source_id)` primary-key table is filled once by the
single exactly admitted `INSERT ... SELECT ... UNION ALL ... ON CONFLICT DO NOTHING`.
No data-reading column default is admitted. Installation takes table locks for
the new foreign keys before scanning the source rails for this seed; order,
settlement and dispatch writes pause until the install transaction commits.
Schedule that write pause for the size of the existing source history. Sweeps use indexed `NOT EXISTS` against that set, with source/order
fault lookup and duty status/availability indexes. The automatic sweep excludes
those historical identities, whether previously
invoiced or uninvoiced, and orders with any non-void accounting document. It never
automatically backfills history. A post-install source remains collectable even
when its host occurrence timestamp predates install. Alias keys include source
kind and settlement intent (or handoff source), avoiding cross-intent key clashes.

A pre-existing limit remains: payment ingest's event readback joins
`accounting_documents`; an ACCESS EXCLUSIVE relation lock can therefore block
money readback. The new capture path removes accounting row-lock/construction
failures, not that older relation-level read dependency.

Source identities and original host keys alias one physical issue duty per order;
a correction aliases one child per parent. Facts and receipts refuse conflicting
replay. Claim locks both native request and duty in its candidate scan, persists provider identity and a
shared token/generation, and joins immutable facts. Expired or unknown creates
become readback work; only authoritative absence permits a new create. Success
settles request/document/receipt together. Late issue first persists external
identity then compensates a pending reversal atomically. Correction BEFORE facts
remain positive history while native positions carry the negative delta. No
fiscal numbering, provider transport, market policy or money writer is added.
Clearance and uncertain delivery affect document work only; unknown delivery
acceptance cannot re-enter send after lease expiry. Source retention is a host
lifecycle obligation until capture or an explicit terminal policy receipt.

Capture marks newly created duties on the default paid terminal path; seller wrappers also mark genuinely new corrections. First claim captures the
selected host seller and revision in the same transaction. Retry preserves that
seller; new corrections have independent eligibility. A new sidecar around an
old document/request is legacy and returns the execution-supplied fallback.
Issued documents and historical seller/buyer/line facts are never rewritten.

`managedInvoicingForwards` is a separate bounded admission, with three fixed
paths and ordered signature sets in the checker: new correction v2 overloads,
legacy fail-closed compatibility replacements, and new seller wrappers plus one
seller table with RLS enabled. Whole-file and function before/after hashes bind their definitions.
It preserves the donor's `SECURITY DEFINER`, `search_path = public, pg_catalog`
and EXECUTE only to service_role, with PUBLIC/anon/authenticated revokes. The
native creation class additionally admits the exact cutover seed and the
`WITH (security_invoker=true)` view form; existing managed classes are unchanged. Unexpected
signatures, attributes, triggers, tables, grants or lexical forms refuse.

The [registry](../../config/reviewed-platform-forwards.json) binds all seven final
fixture paths and hashes. The [catalog proof](../../tests/postgres/reviewedPortableCreation.test.ts)
applies every fixture to real PostgreSQL, preserving existing object/ACL
boundaries except the exact pinned replacements and checking native invoker
versus managed service-only attributes. Positive and refusal plants exercise
both CI and release admission. Control approval alone provides no runtime,
provider, deployment or fiscal-readiness evidence.
