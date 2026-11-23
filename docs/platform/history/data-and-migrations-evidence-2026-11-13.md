# Data and migrations: frozen historical evidence (2026-11-13)

Status: historical evidence, archived from [Data and migrations](../DATA_AND_MIGRATIONS.md).
The following sections are preserved verbatim from `docs/platform/DATA_AND_MIGRATIONS.md`,
with relative links rebased. They are frozen historical records, not current
contributor rules or reader guidance. Use [Data and migrations](../DATA_AND_MIGRATIONS.md)
for active migration, admission, transfer, and fixture contracts, and the
[OpenLup guide](../../../packages/core/docs/guide/README.md) for reader guidance.

## Data ownership (archived evidence)

Evidence (historical record, 2026-11-13):

The native `20261101223000_subscription_purchase_renewal.sql` forward records
purchase facts and renewal-attachment duties beside the existing activation
spine. Activation commits service plus the duty; renewal header/lines/method
materialization is a separate atomic transaction. An incomplete duty remains
enumerable and does not pause service. Bounded definer writers avoid granting
runtime INSERT on renewal headers or method states. The new fact/event tables
explicitly revoke all table access from PUBLIC, anon, authenticated and
service_role, including access inherited from installer default grants. No table
grant or row-level-security change is added. Fixed
definer readers expose only a bounded pending-duty list and three completed
snapshot fields; the runtime never reads the method-event ledger. Their search
path is `pg_catalog, pg_temp`, and
the original activation RPC signature and commit-helper attributes are retained.
The incumbent term-line collection INSERT/DELETE grants remain unchanged.
Created functions revoke PUBLIC individually before conditional constant-string
function ACL blocks for anon, authenticated and service_role. The replaced
activation helper retains its ACL. Method transitions compare expected health and persist event evidence without
rewriting subscription service state. Sandbox observation uses invoker rights
and the existing operation/outcome capabilities, without another attempt table.
The [subscription owner](https://github.com/openlup/openlup/blob/main/docs/platform/ARCHITECTURE_AND_EXTENSIONS.md#subscription-contracts)
describes the codec and retry duties. The forward's approval inventory is
admitted with it under ordinary review;
local PostgreSQL proof does not establish that admission or a published chain.

## Connection roles (archived evidence)

Evidence (historical record, 2026-11-13):

The [production composition witness](../../../tests/postgres/m14QualifiedComposition.test.ts)
installs/replays every selected unit through the direct endpoint, then exercises
the pooled request and dedicated session-lock recipe through the restricted
runtime login. Restricted-bootstrap installation is a separate qualification
and will reuse these connection roles when it lands. Hosted endpoints remain
unqualified by this local witness.

## Upgrade native method authority (archived evidence)

Evidence (historical record, 2026-11-13):

Risk's Node-only `RISK_MIGRATIONS` descriptor projects the unchanged
`20260813230000_post_order_control.sql` catalogue unit, including its co-located
return/control objects. The package asset preserves the canonical SHA-256
`f24ff3ee3c1022f73162db03b8900c93614d3d6d4c6375cf4aad8a3c0f3360a7`.
It adds no installation-chain file, managed forward or reviewed-forward class.

Fulfillment appends native command and alignment units,
`20261022080000_fulfillment_command_ledger.sql` and
`20261022090000_fulfillment_delivery_alignment.sql`, after the shipping seed.
`FULFILLMENT_MIGRATIONS` projects units 5, 27, 51, 73, 74 and 76 with canonical identities and byte-identical package assets.

Payments publishes `PAYMENT_MIGRATIONS` as byte-identical projections of canonical
positions 10 (settlement), 35 (truth/reconciliation) and 56 (later-only cycle).
Each retains its canonical path, SHA-256 and package asset URL.

The direct human-login forward `20261018180000_identity_operator_challenges`
appends position 68 after invitations. Preserve every preceding file, digest and
position. The identity projection carries the same bytes and canonical position;
never install the sparse projection as a complete catalogue.

At the 27 October E2 89-unit proof-source checkpoint, the eight-case witness
specified four fixed-pin references and four fresh targets through the real
binding and built package executor. One healthy target supplied the inventory,
unsafe-session and shadow-symbol discriminators before recovering to the same
ledger; that source was still awaiting the receiving-machine run at this
checkpoint. The linked test later evolved to the four-profile 91-unit
runtime-completion witness; its dated result appears in the
[M14 runtime-completion record](https://github.com/openlup/openlup/blob/535349050419abe5122bd74fa6766c58947be3dd/docs/platform/plans/oss-m14-operations-portability.md#runtime-completion-28-october-2026).

## M10-9 attempt replay control fixtures

Evidence: historical record, 2026-11-13. Not reader guidance.

The inert managed fixtures
[attempt replay](../../../scripts/fixtures/reviewed-m10/supabase/migrations/20261025090000_subscription_dunning_attempt_replay.sql)
and [attributed advancement](../../../scripts/fixtures/reviewed-m10/supabase/migrations/20261025090100_subscription_dunning_attributed_advance.sql)
follow the exact managed tail `20261024185100`. Their source provenance is
`20261024195559_subscription_dunning_attempt_replay.sql` and
`20261024221547_subscription_dunning_attributed_advance.sql` from the reference
adopter at `3f525051e`. The registry binds all eleven before/after edges:
nine definitions in the first fixture and two replacements in the second.
The final nine raw CREATE hashes equal the source adopter's current statements, including
comments within CREATE. Recovery redeem, retry scheduling, provider prepare and
the M4 due reader are untouched; native attempt-replay parity remains REGISTERED.
The managed rail now installs both files byte-identically to these inert fixtures
and registry pins. The package renewal helper carries the applied transition's
attempt through preflight, decline, action-required and replayed action-required
handoffs. `applyFailedResult.paymentAttemptId` is optional/nullable; the opener's
`failedPaymentAttemptId` is required/nullable. Absence becomes explicit NULL and
fresh eligible SQL refuses 55000. Applying a replay does not skip dunning: an
interrupted propagation still needs its canonical observation.

The managed cycle/runtime adapters send the exact field and explicit failure
class. Webhook attribution reads business-result transitions for the ingested
event and intent, refusing absent, conflicting or unreadable evidence before the
RPC. Simulator settlement preserves both canonical transition time and attempt;
none substitutes a current/prepared attempt or an event hint.

The first fixture adds nullable `failed_payment_attempt_id uuid` and
`failure_observation_result jsonb` to `subscription_dunning_cases` and the
NOT VALID FK to `commerce_payment_attempts(id)`. Two exact backfills attribute
open cases and completed historical receipts only from unique applied events;
a cached case result additionally needs its matching live token-linked receipt.
Missing/conflicting attribution remains NULL. The checker fixes those four
statement digests on this path and the six exact ACL statements: new public
entrypoints are service-only and new inner helpers also revoke service access.
No general UPDATE or DDL class is added. The second fixture replaces only the
attributed inner failure and reconciliation bodies, retaining their ACLs.

Legacy arities delegate with NULL attribution. Fresh eligible observations
refuse 55000 without writes; an exact completed legacy receipt can replay.
Attributed same/stale observations return the canonical response without case,
token, notice, schedule or class changes; absent cache refuses
`subscription_dunning_replay_unavailable`. A newer attributed rung may advance
without a previous cache, revokes older used and unused authorizations and
stores one new canonical response. Reconciliation catches only its five named
attribution/cache refusals, preserving applied payment truth and sticky evidence.

An adopter already carrying the prior history maps the schema, FK and backfill
explicitly to its existing immutable migrations and proves its own current
preimages. It never re-runs this backfill or forges an upstream migration identity:
raw replay has duplicate-column preimages and can overwrite newer observations.
A separately authorized host forward may restate the required functions and
restore its exact private due reader last in one transaction. This managed port supplies no host application, release or private-stock conversion.

**Native attempt-replay parity — REGISTERED, owner M10.** The native runner uses
`RenewalFailureHandoffPort`/`RenewalStorePort`, separately from this hosted
`CycleChargeFailurePropagationPort`. The native stores receive neither
`failedPaymentAttemptId` nor `paymentAttemptId`: the
[native retry handoff](../../../packages/platform/src/subscriptions/postgresRetryStore.ts)
accepts the separate `RenewalFailureHandoffPort` input, not `openDunningCase` input.
Native stores do not yet implement duplicate failure-observation replay with
attempt attribution; parity remains a registered follow-up.
Closing this registration requires native same/stale canonical replay,
cache-missing refusal before writes, newer attributed advancement revoking used
and unused authority, equal-rung/missing-attribution refusal, reconciliation and
concurrency evidence. Existing native atomic receipts prove only their own graph. Rollback uses a compensating forward preserving attribution and
revocations; it never resurrects old recovery authority.

The `managedCommerceForwards` registry binds the managed commerce SQL to the
matching files under `scripts/fixtures/reviewed-m11/` and `supabase/migrations/`.
The registry and real migration rails are authoritative. Each pin requires all
earlier same-rail pins with exact bytes. Tests select each real file once,
compare it with its fixture and replay its complete real prefix. Hole, byte-drift,
header, ACL and catalog refusals preserve that boundary.
The new-purchase stock reader
(`public.inventory_new_purchase_stock_read(jsonb,timestamptz)`) runs with owner
privileges through `SECURITY DEFINER` and pinned
`search_path = pg_catalog, pg_temp`; only `service_role` may execute it.
Its ACL revokes `PUBLIC`, `anon`, `authenticated` and `openlup_mcp_reader`.
Behaviour proofs call as `service_role`, with owner access reserved for setup
and state inspection. They also prove function permission refusals for the
denied roles. ATP renewal exemption is fixed false, requests are bounded to
200 array items and a NULL as-of timestamp refuses as
`inventory_stock_as_of_invalid` (SQLSTATE `22023`). Its conservative stale flag
covers any stale provider row for the SKU; the allocator retains its stale refusal.
The stock reader's `SECURITY DEFINER` search path lists `pg_temp` last explicitly;
its application relations and routines are schema-qualified.
The other contributed definers retain their reviewed headers and search paths under the platform-wide definer posture; the stock reader's `pg_temp`-last header is stricter.
The starter creation and graduation replacements retain independent preimages,
header digests and ordered ACL pairs.
Approval-history comparisons retain the exact seven- and eight-entry prefixes
and the invoker stock-reader identity in the eight- and nine-entry inventories
for release carry-over. Candidate admission requires the complete inventory and
the owner-privilege stock-reader header; a historical invoker approval cannot
admit that reader.

The pinned function headers preserve arguments/defaults, returns, language,
security and search paths, with ordered same-file ACLs. Public entry points grant
execution only to `service_role`; private acquisition helpers grant no service
execution. Exact file, CREATE and preimage hashes bind each replacement.
The checkout receipt forward replaces only the audit action
CHECK under its pinned lock timeout, preserving its preimage actions and adding
`checkout_payment_link_mint` through the exact NOT VALID constraint replacement.
Any intervening audit-table ALTER/DROP refuses this fixed CHECK preimage class.
M09/M10 inventories remain closed.

The [managed commerce proof](../../../tests/postgres/commerceManagedRail.test.ts)
checks return identity, normalized replay, concurrent duplicate requests and
complete public-row snapshots on refusal. The stock pgTAP witness requires the
stock seam, ATP subtraction, missing stock, stale reporting and input refusals
to execute as `service_role`. The starter pgTAP witness consumes the actual
provisional result through graduation, with initial cycle, line and replay checks.
The TypeScript witnesses use the managed and PostgreSQL returns adapters and the
managed finalize port, including typed acquisition conflicts, unchanged refusal
rows and 21-day provisional creation. The managed stock port exercises ATP and
propagates SQL refusals in
[`newPurchaseStockManaged.test.ts`](../../../tests/postgres/newPurchaseStockManaged.test.ts).
The [catalog gate](../../../tests/postgres/reviewedBatchForwards.test.ts) executes
acquisition finalize under both policy states: exact retained terms admit;
missing, stale or engine-mismatched terms refuse atomically; completed replay
preserves rows after policy changes. It retains one-time checkout and the
shared/exclusive lock protocol. Database proof grants no installation authority,
handler integration or native return parity.

Migration: configurator guests may supply an order destination without rewriting
saved preferences; preference updates require a server-proved matching account.

Migration: legacy omitted or empty country uses `platform_region_code()` for
address identity and insertion; configure the adopter's settlement region or the
fallback refuses with SQLSTATE `55000`. Neutral commands require explicit country.

Migration: return request creation requires the server-supplied principal to own
the order. Replay requires the same principal, order and normalized command;
foreign or changed commands refuse without a durable row change.

Migration: checkout payment-link receipts use the `checkout_payment_link_mint`
audit action; its service-only entry point records the operator receipt.

Migration: subscription checkout finalize validates retained acquisition terms
against effective policy while holding the shared transaction advisory lock.
Policy writers must hold the exclusive lock; changed terms refuse fresh checkout
while completed finalize replay retains its response. One-time checkout is exempt.

Migration: `commerce_subscription_acquisition_terms` reads effective acquisition
terms and refuses absent terms with `acquisition_terms_not_effective`; the
no-policy finalize compatibility branch remains available.

Migration: `inventory_new_purchase_stock_read(jsonb,timestamptz)` reads ATP with
renewal exemption fixed false, subtracting active holds, safety stock, protected
renewal demand and channel exposure. It bounds the requested array before
deduplication, refuses a NULL as-of, and reports stale provider observations.

Migration: the managed starter routines admit graduation cadences of 14, 21 or
28 days; provisional creation uses `starterIntervalDays` and the subscription
column's timezone default. Native has no twin. Rolling back below this forward
with a 21-day marker is unsupported; roll forward.

PARITY GAP — the adopter-owned opt-in `full_unedited` graduation mode, which
graduates only unedited starter terms, is not contributed. It belongs to the
subscription domain (M10 area) and is unreachable from M11 code; the adopter
keeps its own managed SQL.

**Named bounded debt C94 — reviewed SQL vocabulary.** The frozen managed
SQL retains provider nouns inherited from that rail. The neutrality baseline
records the scanner's exact counts for the six existing managed fixtures and the
registry's pinned refund COMMENT: dunning continuity (`ui-13`: 2, `ui-14`: 3),
ATP (`ui-15`: 3), stock wait (`ui-15`: 6), allocator (`ui-15`: 2), refund evidence
and refund parity (each `ui-13`: 7), and the registry (`ui-13`: 1).
Each landing PR (P3b, P5, F17) adds only its own rail keys together with the files,
using these exact pinned counts per category. Any present baseline key for an
allowance path must contain exactly its pinned category counts, including during
regeneration; adding a key without the file refuses. The N6 native payment
slots 42–44 and their package mirrors retain the two reference payment adapters'
names in three ported predicates: inline-flow admission, historical channel
routing and a refund-amount rule. Each row adds only its own whole-file SHA-256
pins, exact counts and baseline keys with its files. R1's attempt-store slot and
mirror each pin `ui-13` 0→4 and `ui-14` 0→3. Its unchanged characterization fixture,
`tests/postgres/fixtures/paymentProvider/durability.sql`, pins `ui-13` 0→6 and
`ui-14` 0→5 with its own whole-file digest and baseline key. Historical migration slots and characterization fixtures retain those exact bytes,
namespaces and whole-file pins. The appended
`20261121090000_payment_provider_profiles.sql` and its identical package mirror
replace the ten effective payment-policy functions without editing history.
The replacement predicates select closed policy fields instead of provider
identities. Each of the two declaration carriers has an exact whole-file digest
and precisely one `ui-13` and one `ui-14` occurrence, both declaration data.
No other new native SQL, generic TypeScript or fixture receives an allowance.
The existing adapter-owned subpaths retain protocol translation and typed profile
declarations; an executed parity witness compares their shared fields to SQL.

`payment_provider_profile(text)` is an immutable declarative resolver. A known
identifier selects its profile; an arbitrary admitted identifier retains the
existing generic preparation and event-delta behavior. Claims and reopening
remain opt-in. Early trusted-tuple validation uses the attempt's own interactive
profile or a fixed legacy fallback preserving existing refusals for missing or
unsupported attempts. It precedes receipt replay and provider-row validation;
acceptance is profile-bound.
There is no policy table, mutable registry or per-command profile JSON.
A third provider adds an explicit declaration and its adapter; a new protocol or
money/retry semantic needs separate work. This does not supply the second
reference provider's portable composition or activate any provider.

The closed `reviewedPinnedIntroductions` list retains every historical SQL and
characterization-witness pin. The two new carriers extend that exact list only;
its path validator rejects other paths, even when their bytes match. The unused
method-store slot and mirror eligibility entries have been removed because
neither had an introduction pin. Historical witness assertions remain unchanged.
Each SQL pin requires the complete file's SHA-256
and exact category and before/after counts, on any base. The registry instead
pins the exact refund COMMENT text because later approvals edit unrelated
registry data; extra counted vocabulary still refuses. The allowance filters
measured-base increases and parent-baseline raises, including regeneration;
candidate counts must still fit the baseline. Changed bytes, another path even
with the same digest, another category or count, and unrelated increases refuse.
Other native or package SQL paths, TypeScript and documentation cannot enter this list.
Adding any further entry is a control change reviewed under the
[native review floors](../../../CONTRIBUTING.md#native-review-and-accountability). The six rail-path entries can be retired after
the F17 PR lands and the base carries the counts.

Historically, the managed runtime capability forward shipped after a separate
control approval. It changes no baseline bytes or function signature. Required service
and authenticated column/helper permissions are explicit in that ordered file;
no portable twin or live upgrade compatibility is claimed. A corrected forward
also retires exactly eight legacy id-only browser policies that membership
reads would otherwise activate. Customer-own policies and own membership reads
remain unchanged; actual authenticated role tests cover cross-customer refusals.
Policy retirement is pinned to exact statements and preceding policy hashes; it
is not general permission to alter RLS.
The checker binds the fixed policy names, tables, preceding statement hashes
and ordered DROP statements separately from the function and privilege pins.
Other policy operations refuse. The original capability forward used prior
control approval; eligible later introductions may use the co-located route
above. Approval alone grants no runtime permission or actual-role proof.

Reviewed replacement is a separate admission class, not expand-only. The fixed
[allowlist](../../../config/reviewed-platform-forwards.json) pins three managed
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
fixed in checker code independently of the registry. The list also binds the native
payment-terminal replacement and the stock-evidence replay replacement.
The stock-evidence slot admits only
`public.fulfillment_record_stock_evidence(text,text,text,text,text,text,integer,integer)`:
matching-fingerprint replay reopens evidence and refreshes severity, quantities
and last-seen time, clearing resolution time; a fingerprint mismatch still
refuses with `23505`. An optional fourth slot fixes
the portable file `20261030110000_customer_newsletter_withdrawal.sql` to
`public.customer_communication_preferences_set_as_actor(boolean,timestamptz)`.
The preceding one-, two- and three-slot registries remain readable. Boolean
identity and this setter's `timestamptz DEFAULT now()` are parsed only for that
signature; hashes still bind the raw definition. This admission change adds no
SQL or registry pin. Prior definitions come only
from the portable baseline and earlier portable forwards in strict filename
order, as required by the manifest. Exact path, file and before/after definition
hashes must match; arguments, return, volatility, security and settings remain
unchanged. Only comments and that single `CREATE OR REPLACE FUNCTION` are
admitted under the co-located SQL/pin rule above; no privileges or other statements
are allowed. The original class-control approval added no SQL file or runtime behavior.

The separate `portableCreationForwards` class binds these portable paths and
whole-file SHA-256 digests in the same allowlist:

| Path | SHA-256 |
| --- | --- |
| [db/platform/migrations/20261022080000_fulfillment_command_ledger.sql](../../../scripts/fixtures/20261022080000_fulfillment_command_ledger.sql) | `c6806906cdb0b6931b29f7a5c7c800016e98d04e6ea956f3c1e219a6cdb7e9d1` |
| [db/platform/migrations/20261022090000_fulfillment_delivery_alignment.sql](../../../scripts/fixtures/20261022090000_fulfillment_delivery_alignment.sql) | `d9966ae79fe77a0feae8317dc5b46ef2d8196dd0790b1cd0ee1b06ab58061499` |

The three additional M09 creation pins are listed in the
[M09 control preparation section](../DATA_AND_MIGRATIONS.md#m09-invoicing-forward-design-and-control-approval) and the registry.

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
The [disposable catalog proof](../../../tests/postgres/reviewedPortableCreation.test.ts)
applies each pinned target exactly once after its portable prefix, using
landed bytes when present (they must equal the fixture and registry SHA-256, else
the proof fails naming the path); the fixture when absent. It checks invoker security,
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
and all other statement forms refuse. The co-located approval rule above also
applies to this existing class; it does not broaden the managed or portable
replacement classes or install runtime permissions.
The exact future file bytes are also kept as
[command-ledger](../../../scripts/fixtures/20261022080000_fulfillment_command_ledger.sql)
and [delivery-alignment](../../../scripts/fixtures/20261022090000_fulfillment_delivery_alignment.sql)
test snapshots; snapshots are not installation-chain entries.

[The shared checker](../../../scripts/reviewed-platform-forward.ts) verifies the
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

PR/merge-group self-check and release prepare follow the canonical
[co-located SQL/pin rule](../DATA_AND_MIGRATIONS.md#co-located-sql-and-approval-pins), including existing
separate control histories and refusal of later retroactive pins. Missing history
refuses; existing history, version and manifest rules still apply. The expand-only
predicate also refuses `INHERITS`, preventing a new table from inheriting an
existing one. Admission is process evidence of exact reviewed bytes, not proof
of live schema compatibility or authorization to release. Applicable control
review and affected database behavior tests remain required.

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

Evidence: historical record, 2026-11-13. Not reader guidance.

The opt-in [subscription reference](../SUBSCRIPTION_REFERENCE.md) selects the
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

## Compatibility lifecycle (archived evidence)

Evidence (historical record, 2026-11-13):

The lifecycle-closure forward is a closed-class function update: three existing
function definitions retain their attributes and ACLs, four new invoker functions
use `pg_catalog` and conditional trusted execution, and three status CHECKs gain
`paused`, `skipped` and `cancelled` respectively. Existing status values remain
valid; no historical row is rewritten. The package mirrors the exact SQL bytes.
The outcomes projection is a nonmaterialized view over existing events with
PUBLIC/browser access revoked and no new reader grant. Its installation needs
the separately admitted class descriptor; a local SQL replay is not admission.
The fixed actor pause wrapper alone flushes `trg_commerce_orders_line_sum` inside
its existing definer context and then sets that named constraint DEFERRED. This
moves the unchanged invoker check before the wrapper returns, without altering
the constraint definition, trigger function, gateway commit role or table grants.
Other deferred constraints are not changed. Service closure calls still defer
line-sum checking until transaction completion.

The subscription-notice suffix replaces the installed producer/claim bodies
without changing their existing signatures or search paths. Its mirrored SQL
and manifest hashes must travel with the matching package set. It adds a nullable
operator recipient while preserving the customer FK, replaces uniqueness with
recipient-aware NULLS NOT DISTINCT identity, and defaults operator freshness to
false for existing history. The nullable reminder-ledger `renewal_at` column
retains new queued renewal instants without sharing customer event identities.
Existing ledger rows are never re-keyed or backfilled; their day uniqueness and
accepted receipt identities still dedupe, with typed legacy event facts retained
as a read fallback. New pause facts use the existing event carrier;
older dispatch code does not recognize those new event kinds. Upgrade the
producer and dispatcher together before enabling their schedules. No ledger
backfill, historical auto-send, reminder deletion or live activation is performed.
The separate closed class-2 reader/data admission is required before this suffix
can land; a source-only fixture application does not establish that admission.

The classic package-editor forward appends nullable subscription composition
storage, a new preview ledger and eight created functions. It replaces no served
command routine and rewrites no existing agreement, cycle or operation snapshot.
The canonical manifest and projected package SQL retain identical bytes for all
selected plans; each installation shape needs its separately measured catalogue
identity. Apply this additive schema before upgrading native account reads or
composing the editor. Old generic commands keep their existing contract.
Preview rows retain linked actor/client and accepted-event references, stay
unread by client absorption (their subscriptions block it) and travel through
the finite connected-store profile. They
have no erasure path yet. [Retained storage](../DATA_AND_MIGRATIONS.md#retained-renewal-storage) owns their
privilege, pruning, acceptance and renewal-pricing boundaries.


The opt-in [complete account consent choices](#complete-account-consent-choices)
forward adds a distinct actor API and expands only the native sync purpose CHECK.
It neither replaces the served newsletter routines nor backfills grants. Hosts
configure its single sync target before selecting the new API; old callers retain
their existing opt-in/withdrawal behaviour across the upgrade.

The native [paid-email forward](../../../db/platform/migrations/20261101231000_native_paid_email.sql)
replaces the paid-notification trigger and promoted-draft functions, preserving
their invoker headers. The existing paid event remains; the additional mail event uses order_<UUID>,
a separate idempotency key and the native cycle/draft mode. Its mail-only block
bounds lock waits, absorbs insertion/cancellation errors and restores the
caller's timeout, so this added effect cannot roll back settlement. A missed mail
event leaves the retained paid event/order as operator-repair evidence; this is
best-effort capture, not a new durable mail obligation. Existing rows and historic
events are not rewritten. Eight existing notice, recipient, policy and reminder
routines gain conditional service_role EXECUTE, without new table privileges,
definers or changes to their bodies. The condition preserves legacy installs
where service_role is absent. Native case/notice creation remains atomic;
explicit notice-storage contention rolls back cleanly and is retried after
release. The [scheduled binding boundary](../ARCHITECTURE_AND_EXTENSIONS.md#subscription-contracts)
and [grant assessment](../plans/oss-m19-g8.md#grant-exposure-assessment) own caller
trust and contact-data exposure. The feature requires exact class data and
approval pins; local SQL proof alone does not admit it.

The staged promoted-draft port validates effective shipping and retains its canonical charge
adjustment, money equation, replay and line-allocation refusals. Where a quote
retains `shipping-threshold.v1` terms, the configured flat fee applies below the
threshold and zero applies at or above it, measured after product discounts and
excluding delivery. Currency, numeric bounds and the retained shipping amount
must agree. Quotes without these terms retain their supplied shipping amount;
hosts must supply server-produced quotes and authorize the customer separately.
Product discounts allocate only to product lines. The deferred line-sum guard
adds shipping charges and subtracts shipping-scoped discounts before comparing
with the order total; its other checks and invoker trigger header remain unchanged.
The local invoice constructor appends positive effective delivery as its own line.

The new `commerce_promotion_lock_definition(text)` is a volatile definer routine
owned by the migration role, with `search_path = pg_catalog, pg_temp`. It only
selects the named definition for update and returns its row or null. PUBLIC and
browser roles cannot execute it; only the service runtime receives EXECUTE.
The invoker draft retains definition, missing-promotion and global/customer cap
checks after that lock. Runtime callers still cannot update definitions.
These native opt-in changes do not modify a managed database or activate a host.

The existing `subscription_dunning_notifications` and
`transactional_delivery_receipts` tables can hold customer-linked delivery facts.
There is no erasure path for these tables yet. Capturing or restoring these rows
does not qualify customer-data erasure; a host must account for this limit before
using the native notice path with customer data.

## Paid-mail capture repair

Evidence: historical record, 2026-11-13. Not reader guidance.

Run this read query through the trusted runtime or operator connection to find
paid orders with a retained paid event and no mail event:

```sql
SELECT o.id AS order_uuid, o.paid_at
FROM public.commerce_orders AS o
WHERE o.status = 'paid'
  AND EXISTS (
    SELECT 1 FROM public.outbox_events AS e
    WHERE e.aggregate_type = 'commerce_order' AND e.aggregate_id = o.id
      AND e.event_type = 'commerce.order.paid'
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.outbox_events AS e
    WHERE e.aggregate_type = 'commerce_order' AND e.aggregate_id = o.id
      AND e.event_type = 'commerce.order.paid.email'
  )
ORDER BY o.paid_at, o.id;
```

This identifies missing capture, not provider delivery. It can include historical
paid orders; reconcile their event history before an explicit host-controlled
repair. The query changes no row and triggers no send. Settlement replay does
not recreate a mail event omitted during the original paid transition.

The native terminal-renewal replay forward preserves the claim routine's
signature, defaults, invoker rights, search path, ownership and ACL. It moves a
matching stored succeeded/refused answer before current due eligibility, under
the same subscription-then-operation locks and full frozen-input comparison.
Changed replay input remains 23505. Cancellation permits historical terminal
readback but never new or nonterminal claims. Apply this ordered forward before
selecting that public replay behavior; the managed chain and separate adopter
native copies require their own adoption rather than changing implicitly.

The published native sandbox-attempt forward adds nullable review metadata without
rewriting existing truth rows or changing the open/settled checks. Existing
non-sandbox truth does not read or require simulator storage. New sandbox truth
requires an exact durable server observation and active-attempt match; accepted
event replay retains its first fingerprint and instant after restart. Cancelled
capture is terminal operator-review evidence, excluded from reconciliation work
and the open sweep, while the order remains cancelled. See the sandbox forward
in [Module catalogues and installed histories](../DATA_AND_MIGRATIONS.md#module-catalogues-and-installed-histories).
The destination forward adds immutable address documents and scoped order,
subscription and shipment bindings. Both relations revoke PUBLIC, browser and
runtime table privileges and enable RLS; trusted runtime uses four bounded
definer routines with pinned search paths. Parent/client consistency is checked,
but host authorization of each parent read remains necessary. The separate saved
address book owns mutable customer rows; there is no arbitrary destination-ID
reader. Subscription defaults read
through an active purchase; renewal orders resolve their own frozen operation
reference, never the subscription's later future address. Shipment preparation
pins its first document under the native dispatch lock. Hosts compose this reader
in the existing authoritative preparation transaction before freezing requests.
The shipment destination read and command enqueue must share one transaction
on one connection; otherwise the host owns the intervening window.

A human operator can correct an unowned created/packed/label_pending current
parcel. Once a dispatch ref, command or attempt exists, the order and parcel keep
their destination and the subscription future changes with the named
applied_from_next_parcel result, including replay. The account-link orchestration
returns partial and retains that named nested result. The reference HTTP route
preserves the outcome; its older legacy browser schema refuses it, so hosts must
compose the native result explicitly and show next-parcel applicability. It is not a fully applied
current-parcel result. Native customer changes future only. Open dunning does not
blanket-block address; the existing next-cycle payment lock still applies, including
a native snapshot owned before its cycle row exists. Subscription reads lock the
parent; G7 retains that writable transaction through snapshot claim. Address
changes do not move cadence, next_cycle_at, template_version, money, or delivery
alignment. Never confirm an undelivered replacement through this boundary.

The transaction records the native subscription event as account history and
one subscription.address_changed outbox row, keyed by source event UUID. Both
payloads name applicability and future destination ID, without frozen-parcel
address data. Replay bypasses both INSERTs; the outbox's unique event/key fence
also deduplicates. An outbox failure rolls back address, binding, event and receipt
writes. Delivery is asynchronous: no mail response gates money or parcel work.
The existing template mapper and explicitly composed subscription message facade
do not automatically consume the native outbox. Host mail dispatch remains
unbound; no delivered-email claim follows from enqueue.

These documents carry full postal addresses and contact phone numbers, customer names
and delivery instructions,
plus identifying parent, actor and reference strings. Hosts should use opaque
references and avoid personal data in keys/reasons. There is no destination privacy
export or erasure path; existing identity erasure does not erase these documents.
Do not claim complete privacy coverage. Privileged connected-store transfer
retains exact documents, bindings and the existing command/support ledgers under
whole-packet row/byte bounds and filtered-login refusal; it is not a subject
privacy export. Root capture/restore additions ship no npm assets. The API remains
a source-only surface; full catalogue installation and explicit
host composition are required, and managed definitions remain unchanged.

The installed complete-catalogue entry preserves this lifecycle. Its generated
SQL assets are copies of issued units with unchanged canonical identities,
hashes, ordering and inventory pins, rather than new forwards. Qualified and
restricted-admin selections retain their distinct baselines and role admission;
legacy selection remains available for existing history. The required installed-consumer gate
compares the projection against the canonical manifest and exact source bytes.
See [module catalogues](../DATA_AND_MIGRATIONS.md#module-catalogues-and-installed-histories) and the
[installed recipe](../../../packages/platform/README.md#install-the-portable-postgresql-schema).
The G4 forward adds purchase ownership to the existing inventory reservation
table. Renewal ownership becomes nullable while its UNIQUE and foreign key stay
intact; a validated exclusive-owner CHECK requires either a renewal operation
or a purchase order. Existing renewal rows need no data backfill. Purchase
release/expiry change only purchase-owned rows, and the unchanged ATP, renewal,
stock-wait and retry paths continue counting their live quantities. One command
receipt retains batch/release/cancel replay; runtime table grants do not widen. This
ownership alteration is named by the closed class control and bound by the
co-located feature pins. The receipt table revokes PUBLIC and named
runtime/browser roles separately from function ACLs; it introduces neither RLS
nor table grants. The existing reservation-table ACL stays unchanged. Local lots, locations,
balance counters and movement history are outside this slice.

The native abandoned-checkout wrapper locks the subscription root, order, intents,
simulator attempts and their evidence, in that order. A dispatched attempt returns
`cancelled: false` with `provider_attempt_in_flight` without writing a receipt or
changing the order, intent or holds. Terminal refused/expired attempts permit
cancellation; captured or indeterminate attempts retain the money refusal.
It delegates aggregate cleanup to the existing
compensation routine and purchase transitions to the existing release routine in
one transaction. Strict command receipts reject changed keyed input; paid,
captured or indeterminate evidence prevents cancellation. It rejects renewal
orders and admits no new holds on cancelled orders. No withdrawal metadata or
money effect is written. A late capture's review disposition belongs to the
preceding payment slot: it records `review_required` without reopening the
cancelled order or reclaiming its released holds.
Dedicated promotion cancellation remains unbound. Reference fields, including
keys and source references, can contain identifying strings; hosts should use
opaque references and avoid personal details in metadata and reasons. No erasure
path exists yet for retained reservation, command-receipt or compensation data.

Fresh channel capture admission binds the normalized slug through the existing
trusted scope read and the raw-source digest through its original page event.
It checks normalized buyer, address and shipping scalar types and bounds before
persistence. Page recording derives its next watermark from the expected
watermark and event times using the public millisecond comparison, retaining
the original timestamp string on ties. These checks add no runtime grant or
writer policy.

The portable account newsletter withdrawal forward changes future account
opt-outs only. Earlier opt-outs require the explicit, idempotent
[operator upgrade statement](#account-newsletter-withdrawal-upgrade); installing
or replaying the forward does not alter an existing recipient-consent row.

The [recipe runner](../RUNTIME_AND_SELF_HOSTING.md#recipe-conformance-runner)
composes this same released-history proof against its declared separate fresh
schema target. That route requires the actual previous 0.23.0 application
binding; the ordinary offline test keeps it optional and cannot thereby claim
compatible-code rollback. Killed child migrations receive their connection
configuration through stdin, including verified TLS, without credential-bearing
process arguments. The factored proof retains the same backfill, ledger,
retained-row and subscription assertions. The RDS branch instead admits the
restricted generation, stops its canonical runner at the prefix before the same
backfill, then exercises those assertions and actual previous application code.
That branch proves a restricted-prefix upgrade, not an upgrade from a released
restricted predecessor. The released legacy history below is unchanged.

The [released-history witness](../../../tests/postgres/m14ReleasedSchemaUpgrade.test.ts)
selects the nearest published predecessor with an applicable portable data
backfill: platform 0.23.0, whose 77-unit legacy manifest is an exact prefix of
the current legacy manifest. The invoicing durable-duties forward copies
existing settlement and shipment-operation identities into `invoicing_cutover`
so historical sources do not become new duties. It kills the canonical runner
while that unit waits inside its transaction and again after the unit commits,
then checks exact ledger replay, retained rows, and subscription alignment.
An opt-in local binding to the published 0.23.0 package exercises prior payment
code against the upgraded database. The 0.23.0 release has no qualified-v2
history, so this is a legacy upgrade witness; the separate qualified-v2 fresh
installation checks retain their own scope. Code rollback does not restore the
earlier database schema or reverse the backfilled cutover rows.

The runtime-completion forward follows the entire qualified F90 prefix, preserving
all earlier issued identities. The owner-path forward follows it as unit 92,
with two newly measured restore-bound inventories. Runtime completion provides
the existing normal-runtime preparation context writes
and review replay-receipt reads/appends. Its column grants exclude context key
updates, and receipt UPDATE/DELETE/TRUNCATE remain denied. Apply the complete
selected catalogue through the existing executor and ledger; this exact grant
completion does not authorize owner fallback, legacy relabelling or a new role mode.
The production-composition witness includes actual restricted-runtime commands
and refusals; reference inventory derivation alone does not qualify those commands.

Before the lock and conflict completion tail, both qualified generations
refused five existing native paths on the restricted runtime with `42501`:

- native subscription lifecycle commands;
- operator recovery issue;
- platform control set and heartbeat;
- order settlement for an order with a promotion claim;
- operator lead absorption, once delivery destinations block absorption.

The first three lock a row `FOR UPDATE` on a table whose issued runtime grants
include no `UPDATE` column: renewal term lines, recovery commands and control
operations. None of these tables had row security. The claim transition
trigger appends events with a conflict target, and the issued runtime grant
there was `INSERT` only. The absorber counts a lead's delivery destinations by
client, but that table had row security and no runtime access at all.

One shared completion tail closes these gaps. It is the approved seventeenth
qualified identity. Both qualified plans select it once, after their issued
tails and at the same position among shared units, so later shared forwards
still append identically.
The completion tail itself adds no legacy unit.

The tail must follow the delivery destination forward. Its guard refuses the
whole unit unless that table exists in its created state: owned by the
installer, with row security enabled and not forced, no policy and no grant
beyond the owner. A destination grant or policy added by any other change
before the tail would therefore stop every installation.

On each of the three locked tables, the tail does the following:

- enables row security;
- keeps the existing runtime access through policies;
- admits row locks through an `UPDATE` policy whose check refuses every
  actual update;
- grants `UPDATE` on one timestamp column.

On claim events it grants `SELECT` on the two arbiter columns only. Row
security would not help there, because an arbiter also requires the new row
to pass a select policy. On delivery destinations it grants `SELECT` on the
client column and adds a runtime select policy, so the existing row security
returns a truthful count. Addresses stay unreadable, and every write stays
unavailable.

The active file is byte-identical to its approved fixture. The four qualified
installation inventories were measured again; the legacy plan and its
inventory are unchanged. The
[real-PostgreSQL witness](../../../tests/postgres/qualifiedRuntimeLockCompletion.test.ts)
runs on `qualified-v2` and on operator-provisioned `qualified-admin`, with an
actual restricted runtime login. It covers:

- the four lifecycle commands through the customer command store, and the
  operator support wrapper's three, each with a receipt;
- recovery issue and replay;
- platform control set, heartbeat and their replays;
- an order settlement with a promotion claim, recording exactly one claim event
  and none on later statuses;
- operator lead absorption: a lead without destinations is absorbed and
  replayed, and a lead with one is refused naming `commerce_destinations`, with
  its rows unchanged.

It also refuses every actual update, every other claim-event and destination
read, and every destination write, and enumerates every role that reaches each
target. The guard refuses the unit for a missing, renamed, unprotected or
force-protected destination table and for any extra policy or grant on it.
Existing destination, purchase-hold, retained-renewal and notice-delivery
witnesses now apply the lifecycle commands, operator recovery issuance, the
claim sweep and absorption through the restricted runtime.

The separate `qualified-admin` generation starts with its issued 91-unit prefix
and appends current shared forwards. It is not an upgrade, relabel or migration-history conversion from
legacy or `qualified-v2`. Its interrupted-prefix proof resumes only the same
selected generation under the same actual migration login and fixed role mode;
replay after completion applies no units. The [local PostgreSQL 16 connected
restore witness](../../../tests/postgres/m14RestrictedConnectedRestore.test.ts)
covers this generation in both role modes with emulated provider control-plane
roles. Actual hosted connected restore and hosted upgrades remain unqualified
pending separate hosted receipts.

The existing qualified target/separate-restore witness connects the native G17
observation host binding through actual restricted R. Bootstrap setup seeds the
owned domain graph and already-submitted request. R performs recovery read,
observation/status persistence, atomic ACK and exact replay; a conflicting
external ID refuses without changing the accepted row. The login is nonowner,
NOSUPERUSER and NOBYPASSRLS, without SET ROLE or recovery owner fallback.
No catalogue, SQL or grant changes. This proves neither R's new-dispatch
preparation capability nor whole-store restoration, executor fencing, provider
search completeness or effect authority.

The E2 predecessor's qualified fresh catalogue replaces the baseline and two bootstrap units,
then appends runtime sealing after the complete legacy ownership closure. Its
89-unit plan requires an actual PostgreSQL 16 database-owner SUPERUSER migrator,
distinct restricted runtime and optional restore logins, and one of four fixed
inventories for the actual migration/bootstrap and restore binding shape. It
does not change the issued 88-unit legacy plan or authorize a legacy database
to relabel its ledger. Installer-managed provisioning and operator-provisioned
roles must satisfy the same declared flags, membership and session refusals;
the [catalogue owner](../DATA_AND_MIGRATIONS.md#module-catalogues-and-installed-histories) describes the
production reference/renamed-target proof and its remaining execution boundary.
These source changes do not qualify a restricted managed host or establish
supported hosting.

The qualified E2+F plan appends the exact retained-row unit after runtime sealing
and requires the independently derived 90-unit restore-bound inventory for the
actual migration/bootstrap shape. It preserves the complete legacy plan and
issued SQL bytes. Restore access is limited to the two fixed domain entries;
ordinary runtime writes still execute lifecycle and alignment admission, while
retained insertion preserves history, frozen terms and outstanding obligations.
An absent restore binding refuses instead of selecting an E-only inventory.
The [compatible-transfer boundary](../DATA_AND_MIGRATIONS.md#compatible-data-transfer) and its production
witness distinguish registration from a proved target installation.

Managed commerce forwards scope saved-preference writes to a server-proved
matching account and bind return creation/replay to the principal, owned order
and normalized command. Checkout payment-link receipts retain operator audit
evidence; subscription finalize checks retained acquisition terms under the
policy lock. The new-purchase stock seam protects renewal demand, and starter
creation/graduation preserve the selected cadence and timezone default. Follow
the per-behavior `Migration:` actions in
[Exact reviewed function forwards](../DATA_AND_MIGRATIONS.md#exact-reviewed-function-forwards); these
managed contracts do not imply native parity or handler integration.

R4 introduces the frozen native `20261026120000_account_support_operator_authority.sql`
and managed `20261026120100_account_support_current_authority.sql` from
`supportAuthorityForwards`. The native SQL and packed twin are byte-identical;
the platform manifest appends one row and its inventory digest must be derived
from the real selected catalog. The account-support catalog is sparse, not an
installation chain. Complete M11 managed predecessors must precede the managed
introduction; no existing pin, historical SQL or source-release binding changes.

Native support delegates effects to M10 in one transaction with operator actor
attribution and actual owner receipts. Email/phone/link and the missing M10
subcases retain named capability refusals. Managed email retires the combined
`customer_support_correct_subject_email_v1` entry: active human callers now get
55000 `customer_support_email_correction_requires_admission`. Call admission,
claim, commit the claim-fenced identity update, then settle. A stale/expired claim
cannot commit; release leaves pending, failure stays durably failed, and original
operator attribution survives resumption. Managed linking adds audited
`account_link`; recovery gains a human fence. The four preserved legacy email
definers (admit, claim, guard and settle) retain `search_path = public, pg_catalog`;
the newly DEFINER link uses `search_path = pg_catalog, pg_temp` with fully qualified
application references. All five revoke EXECUTE from PUBLIC, anon, authenticated
and `openlup_mcp_reader`. Callable entries grant EXECUTE only to service_role;
the guard also revokes service_role and remains trigger-only. The operator-authority
PostgreSQL proof calls link as service_role and compares clean and hostile
caller-session results. See the
[class inventory](../DATA_AND_MIGRATIONS.md#m12-supportauthorityforwards) and
[operator receipt contract](../CANONICAL_CONTRACTS.md#operator-support-receipts-and-partial-links).

Migration: five existing pgTAP callers move from combined correction to the ordered
workflow without dropping their subscription/phone/namespace/absorption witnesses:
`operator_subscription_actions`, `operator_contact_correction`,
`marketing_lead_email_namespace`, `absorb_lead`; the missing-subject/null-clock
case in `runtime_capability_boundary` now calls admission. Machine and inactive
operator refusal assertions retain their prior meaning. The complete enumeration
is in the [M12 plan's R4 section](../plans/oss-m12-account-support.md#r4-operator-recovery) and R4's change fragment.

The managed M10-9 forwards add attempt attribution and canonical failure-observation
state through their exact admitted DDL, deterministic backfill and service-only
overloads. Hosts must carry the applied transition's attempt into each failure
observation, including apply replay; fresh missing attribution refuses 55000.
Existing-adopter schema/backfill maps to its immutable history and must never run
again. The [attempt replay contract](#m10-9-attempt-replay-control-fixtures)
owns upgrade/refusal/compensating-forward details and REGISTERED native parity.
The duplicate-observation pgTAP and real PostgreSQL attempt-replay witness cover
same/stale no-change behavior, cache refusal, advancement, historical attribution,
concurrency and reconciliation boundaries.

Migration: native `20261022195000_invoicing_seller_revision.sql` and managed
`20261022195100_invoicing_seller_revision.sql` introduce the approved CTL-M09-4
fixtures byte for byte. The native descriptor and manifest append 195000 after
192000 at position 80. Request wrappers mark newly created obligations; claim
wrappers freeze only their first-ever durable claim. Retries retain a frozen
seller; work claimed before the wrappers keeps execution-time fallback, including
an empty eligibility sidecar. Corrections capture their own seller revision.
Managed order-status reversals preserve the incumbent result and effects through
the seller request wrapper. No issued-document or historical-fact rewrite occurs.
The complete native catalogue is required; sparse package assets are projections.

The [M09 migration owner](../DATA_AND_MIGRATIONS.md#m09-invoicing-forward-design-and-control-approval)
records the reviewed payment-decoupling forward and its installation boundary.
For new unlinked P4 settlements, `accountingRequested` remains false even after
independent invoicing; P4 supplies no payment-event linkback writer. Historical
linked events retain their readback. Use `invoicing_duty_readback` for invoice
progress and retained settlements for late recovery.

The managed prefix now includes M1
`20261024155000_refunds_preserve_subscription_lifecycle.sql` and M2
`20261024160000_subscription_dunning_continuity.sql`, byte-equal to the reviewed
batch fixtures. M1 removes only refund-driven subscription/cycle cancellation
and activation reversal, retaining the existing stock-release guard. It does
not repair historical rows; F17 later extends refund evidence as described below.
M2 keeps exhaustion open with NULL retry, an active subscription and a repair
token. Recovery binds the consumed token, durable method, current cycle and rung;
no automatic retry follows exhaustion. Historical expired cases keep their
separate resume route. The [managed dunning proof](../../../supabase/tests/subscription_dunning_continuity_test.sql)
and [refund proof](../../../supabase/tests/refunds_preserve_subscription_lifecycle_test.sql)
exercise lifecycle continuity on the complete installed prefix.

The catalog gate applies every non-pin before the next pin exactly once,
including interleaved files. Docker-free tests cover native N1
and managed M1/M2 landed; CI/release admission refuses a digest-drifted M1 below M2.
M1 has no counted vocabulary; only M2 adds a C94 baseline key (`ui-13`: 2,
`ui-14`: 3), with no existing count changed.

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
terminal outcome. The package binding opens the source-keyed existing dunning case first, then
attaches N1 bookkeeping inside the M07 terminal transaction, linking the same
case. It never applies the initial money result twice; any bookkeeping failure
rolls the terminal transaction back for safe replay. Hosts supply its
transaction executor and evidence-bound correlation; no runner is activated.


The stock-evidence replay forward `20261022165000` appends native position 76
on this catalogue and joins the sparse fulfillment projection. It replaces only
`fulfillment_record_stock_evidence`: matching-fingerprint replays reopen and refresh
the alert, clear `resolved_at`, and retain its identity, first-seen time and
historical resolver run. Mismatches still raise `23505`; legacy 0.22.0 whole-input
fingerprints are not rewritten, even after resolution. The resolver itself is
unchanged. Preserve every preceding manifest row and recompute the live
selected-catalog-v2 digest after the full chain. No managed forward is needed:
its baseline already refreshes/reopens corresponding evidence. The
[replay proof](../../../tests/postgres/fulfillmentStockEvidenceReplay.test.ts) covers
fresh installation, the exact predecessor upgrade and runner replay, unchanged
ledger prefix and function ACL/header, package byte equality, lifecycle/refusals
and bounded concurrent row locking.

See the [M09 forward owner](../DATA_AND_MIGRATIONS.md#m09-invoicing-forward-design-and-control-approval) for managed correction v2 installation, cutover and reconciliation.

## Managed stock wait, ATP and refund parity

Evidence: historical record, 2026-11-13. Not reader guidance.

Migration: the managed prefix appends `20261024175000` (ATP seam), `180000`
(M3 stock wait), `181000` (M4 due reader), `182000` (M5 message scan), `184000`
(M6 allocator), `185000` (F17 evidence helper) and `185100` (F17 applicator/outbox).
Each rail file equals its frozen fixture and registry digest. The ordered managed
directory and publication catalogue are the existing install inventory; these
forwards add no native manifest or package SQL twins. M4's before-function hash
is M2's after-hash; F17 follows M1's applicator replacement. No landed pin changes.

The managed [stock-wait proof](../../../supabase/tests/subscription_stock_wait_test.sql),
[unpaid-discovery proof](../../../supabase/tests/subscription_stock_wait_unpaid_discovery_test.sql)
and [ATP proof](../../../supabase/tests/subscription_managed_atp_test.sql) cover rollback,
restock, rotation, private bindings and one-time refusal. Existing dunning and
arrival proofs retain active service, consumed-token/method authority and the
maximum delivery clamp through a rollback to off. The
[refund lifecycle proof](../../../supabase/tests/refunds_preserve_subscription_lifecycle_test.sql)
checks both first-cycle and renewal refunds against future hard/soft protection.
The [cumulative snapshot proof](../../../supabase/tests/stripe_refund_cumulative_snapshot_test.sql)
checks cumulative maximum evidence, once-per-order refunded transitions, rejected
provenance and equal/older snapshot ignore/replay. Ignored snapshots can retain
receipt/event/transition bookkeeping; they create no new refund effect. Matching
stored applicator receipts return before lifecycle or stock writes. M1's lifecycle
independence survives F17; this does not mean its whole applicator body is unchanged.

Origin sources are `20260928170000_new_purchase_stock_availability.sql:26–76,200–291`
and `20260710131002_no_cron_inventory_reservation_leases.sql:15–315` (seam/M6),
`20261003123000_subscription_stock_wait.sql:51–650` and
`20261003142320_subscription_stock_wait_unpaid_discovery.sql:12–324` (M3),
`20261009110000_subscription_dunning_active_repair.sql:744–930` (M4),
`20260802120000_subscription_winback_positive_customer_marker.sql:34–81` (M5),
`20261009111000_stripe_refund_cumulative_snapshot.sql:18–85,167–952` and
`20261021130000_refunds_preserve_subscription_lifecycle.sql:18–758` (F17), all
under the source `supabase/migrations/`. Five C94-bound headers remain frozen; these
citations supply provenance without altering their bytes. Current upstream
`20261013173001_channel_exposure_inventory_admission.sql` global controls remain
deferred. The separate M17 managed forward fills the existing ATP exposure hook
and adds channel-only stock entry without changing the M06 allocator/public
entry. Retained own exposure is credited before clamping; uncommitted renewal
demand is not fenced, as recorded in the channel contract.

Known source-identical limits remain: SQL NULL summary state returns empty totals
rather than refusing (B12); additive-provider helper evidence lacks the cumulative branch's
signature/status/exact-attempt filter (C18). Neither changes in this landing.
Keep captured cases, payment history and receipts on rollback; disable the host
stock-wait driver first. Reverting code does not undo function replacements.
Any SQL repair requires a separately reviewed forward. No backfill, host activation
or stable upgrade claim follows from these source/probe paths.

## Native stock wait and ATP (N3)

Evidence: historical record, 2026-11-13. Not reader guidance.

The native installation prefix now includes the five approved N3/seam/allocator/
X/Y pins at `20261024180000`, `183000`, `184000`, `184500` and `184600`, each with
its byte-identical package SQL twin. N3 adds frozen waiting cases and stock-only
refusal recovery. Uncaptured refusals rotate on the existing renewal operation
`updated_at` selection stamp, so recovery failures before case creation cannot
keep occupying a bounded page. Captured waits retain their case selection stamp.
The later `20261123150000` forward gives fresh cycles and expired claims
alternating opportunities in the normal due page. Selection still filters
active leases, terminal operations and stock-wait cases before the page limit.
The returned rows retain their existing shape and chronological order. A
singleton page uses the oldest ready candidate. An expired claim remains
bound to its existing attempt and is eligible for recovery.

Run the local selector benchmark with
`OPENLUP_BENCH_NATIVE_RENEWAL_DUE=1 OPENLUP_BENCH_EXPLAIN=1 npm run test:hosted -- nativeRenewalDueFairness.test.ts`.
It installs the Native schema and runs warm PostgreSQL plans with a synthetic
backlog split evenly between older expired claims and fresh cycles. In a
50-row page, the historical selector returned zero fresh cycles and the new
selector returned 25. Local medians were 2.8 and 12.0 ms at 10,000 cycles and
23.5 and 79.4 ms at 100,000 cycles. These timings measure selection in
PostgreSQL. Full-worker drain rates and provider times require a separate run.

The seam subtracts hard commitments and active subscription demand through the
native horizon installed via `inventory_renewal_protection` (default 14 days)
from new-purchase availability. The managed ATP contract remains fixed at 14 days.
Native safety and channel exposure remain zero. This is no advance reservation
lifecycle or one-time
checkout write contract. The allocator alone uses the renewal exemption.

For a separate native runtime role, the host must explicitly grant `EXECUTE` on
`public.inventory_available_to_promise(text,text,timestamptz,boolean)` and its
helpers `public.inventory_channel_exposure_quantity(text,text)` and
`public.inventory_renewal_protection_days()`, including for
roles that reserve renewals or call N3 deficits/admission/refusal recovery.
New-purchase readers additionally need `EXECUTE` on
`public.inventory_new_purchase_stock_read(text,jsonb,timestamptz)`.
Alongside the caller's existing relation privileges, ATP requires `SELECT` on
`fulfillment_stock_current`, `fulfillment_inventory_reservations`,
`fulfillment_inventory_reservation_lines`, `subscriptions`,
`subscription_renewal_terms`, `subscription_renewal_term_lines`,
`subscription_renewal_operations` and `subscription_cycles` in `public`;
new-purchase reads also require `SELECT` on `public.catalog_skus`.
When upgrading a custom runtime role from the earlier grant list, apply exactly
one additional grant after the policy migration and before resuming ATP calls
(replace `runtime_role` with the host's role):

```sql
GRANT EXECUTE ON FUNCTION public.inventory_renewal_protection_days() TO runtime_role;
```

Without it ATP fails with SQLSTATE `42501`, even when the policy is absent;
permission failure never falls back to 14 days. The policy helper is
`SECURITY DEFINER` with `search_path = pg_catalog, pg_temp` and reads the
schema-qualified settings table, so ATP callers need no `SELECT` on
`commerce_settings`. The TypeScript policy reader separately needs that `SELECT`
to return the revision and days. The policy helper grants `EXECUTE` to
`service_role`; the other invoker helpers have no shipped runtime grant.
The allocator retains its existing ACL, and neither X nor Y calls ATP; their
existing grants still apply.

X restores released late-paid reservation lines to committed, non-expiring ATP
holds once, returning from its immutable recovery receipt before further writes.
Y excludes paid cycles and settled intents before the candidate limit. Refunds
remain financial; stock wait never pauses service or fabricates a delivery fact.
Keep these forwards and captured obligations on code rollback; disable the host
stock-wait driver first. Object inventory must come from selected-catalog-v2 on
disposable pinned PostgreSQL, never from hashing SQL source. The
[native suite](../../../tests/postgres/subscriptionRenewalLifecycle.test.ts) binds
creation probes to each unit's exact path, including rollback and ACL checks;
its stock and accounting tables test behavior separately from SQL classification.
Stock recovery remains unselected until that real-PG proof is available.

## Native subscription commands (N2)

Evidence: historical record, 2026-11-13. Not reader guidance.

The later `20261106050000_customer_command_key_isolation.sql` forward isolates
actor pause and bundle preview/apply keys as `command:` plus the SHA-256 of the
authenticated principal UUID, a colon and the exact supplied key, matching the
generic command derivation. All three actor entry points reject supplied keys
starting with `command:` as `subscription_command_reserved_idempotency_key`
(22023), including historical raw keys with that prefix.

New actor events carry `commandKeyIdentity` with derivation `principal-sha256.v1`
and the principal UUID: in the lifecycle event's nested `payload` for pause,
and directly in the bundle event payload. New quotes carry the same object in
the nullable `subscription_edit_quotes.command_key_identity` column. NULL or an
absent marker denotes legacy history; the migration neither backfills provenance
nor re-keys rows. A derived-key lookup accepts only the exact principal-bound
marker. An unmarked row at that value is ambiguous raw history and refuses as
`subscription_command_ambiguous_idempotency_key` (23505), never as a replay.
Existing generic command rows without this marker also refuse this actor lookup;
their generic receipt path remains unchanged.

After subscription ownership and its row lock are established, a non-reserved
raw key may replay only an unmarked self-service event of that same action.
Bundle replay additionally requires the matching request, accepted quote hash
and accepted event link. A different customer action at that raw key refuses
idempotency conflict; another subscription owner refuses before replay. A system
event at the raw key is bypassed, never adopted as customer history. Legacy
in-flight quotes remain usable by the matching bundle command, and only its new
event receives derived provenance. Same-action retries retain one event and one
pause window or accepted quote; no command is inferred from matching key bytes
alone.

Hashing new commands cannot remove a pre-upgrade collision. Graduation, cadence
normalization and dunning exhaustion therefore retain their original system key
when available, prefixing it with `system:` while a different event type occupies
it. Existing customer rows remain intact, including preclaimed prefixed keys.
Dunning suppresses only its own exhaustion replay. The forward preserves function
headers and ACLs; the matching TypeScript runtime supplies graduation's guard.
The [real PostgreSQL witness](../../../tests/postgres/customerCommandKeyIsolation.test.ts)
covers legacy and both qualified generations, same-action replay, ownership,
reserved-prefix and ambiguous-hash refusal, cross-action conflicts and both
collision attacks. Qualified system operations
execute through their installed restricted service role; legacy system setup
uses its migration owner rather than claiming a qualified runtime.

Migration: `20261024170000_subscription_command_lifecycle.sql` is the second
native subscription prefix, after N1 and the interleaved M08/M09 units. It adds the actor/key receipt table and
`subscription_command_preview` / `subscription_command_apply`, all invoker-only
with browser execution denied. Canonical and package bytes are identical.
Install the complete ordered manifest before selecting the adapter. Stop command
writers on rollback and retain receipts and accepted quotes; never rewrite
current payment/cycle/order snapshots. Existing native callers are unchanged.
N2 preview returns `noop` before catalogue repricing for equal supplied bundle
fields, existing add-on quantities (`add_addon` and `update_addon_quantity`), plan
length, native resize lines/cadence, package templates and same-UTC-day slides.
It persists only its actor/key receipt and creates
no quote, line/price write, event or template-version increment. Applying that
same command replays the stored noop receipt without writes. The TS store also
uses native preview for an unquoted direct apply, retaining only a noop
receipt; a non-noop probe rolls back before ordinary apply, preserving each
changed-state command's quote requirement or lifecycle behavior.
Raw SQL bundle apply still requires either that receipt or a quote. Changed plan
length commands quote and apply supplied core lines; omitting them expands the
stored core lines. New add-ons default missing or nonpositive quantities to one.
Add-on commands preserve the stored cadence, and quantity updates and removals
compare variant UUIDs case-insensitively. Duplicate-line refusal remains in force. The
[TS store witness](../../../tests/postgres/subscriptionCommandLifecycleCases.ts)
checks catalogue drift and compares every public table, including row versions,
across preview and apply replay.

Migration note (C73, temporary limitation): managed provisional creation
(`subscription_create_provisional_for_checkout`) stamps an explicit timezone
literal equal to today's `subscriptions.timezone` column DEFAULT. An adopter who
changes that DEFAULT must also replace the function until the scheduled follow-up
forward makes it follow the DEFAULT. This change alters no managed SQL.


Fulfillment expands the native graph with new command and
alignment objects at positions 73/74. It preserves all position-0–72 identities,
existing rows and the managed graph. Upgrade the complete prefix before enabling
the new stores; sparse package assets are projections only. Default-off alignment
creates no cases during upgrade. Code rollback retains accepted dispatch proof
and already extended dates; repair those facts forward. Invoker-only owner
execution adds no browser privilege or service account. The
[module catalogue notes](../DATA_AND_MIGRATIONS.md#module-catalogues-and-installed-histories) distinguish
native dispatch commitment, missing correlation and future service grants.

The portable forward
`20261021120000_dunning_lifecycle_active_repair.sql` appends position 71 to keep
active subscriptions active on dunning exhaustion (invariant repair). Its exact
bytes are bound by the manifest SHA-256; it replaces only
`dunning_lifecycle_handle_failure`, with no stored-row rewrite or change to
preceding migration bytes, positions or privileges. Exhaustion leaves the case
open and repairable, with its final notice and event; it changes no subscription,
pause window or cycle dates. The [real-PostgreSQL proof](../../../tests/postgres/dunningLifecycleActiveRepair.test.ts)
covers complete-catalogue fresh install, exact position-70 prefix upgrade with
existing rows, ledger replay, exhaustion/recovery and browser EXECUTE refusal.

Native shipping appends the seed-only forward
[`20261021200000_shipping_flat_rate_seed.sql`](../../../db/platform/migrations/20261021200000_shipping_flat_rate_seed.sql)
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
[Native shipping conformance](../../../tests/postgres/shippingNative.test.ts) covers
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
[`20261019200000_communications_native_operations.sql`](../../../db/platform/migrations/20261019200000_communications_native_operations.sql)
at position 70. Its five CREATE-only tables store network targets, immutable
observations, a nonqueue outbox sync sidecar, notification recipients and policy
decisions. Existing consent truth and all earlier forwards remain unchanged.
Deploy the complete schema before selecting the factories; rollback of application
code leaves additive objects and prior data intact. Sparse package projections
are not an install chain. The live selected-catalogue digest is refreshed from
real PostgreSQL. [B3 conformance](../../../tests/postgres/communicationsNative.test.ts)
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
[browser session contract](../IDENTITY_BROWSER_REFERENCE.md).

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
mutation is composed here. See [identity privacy](../IDENTITY.md#identity-personal-data)
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
[managed conformance module](../../../tests/postgres/operatorInvitationManaged.conformance.ts)
replays the complete committed managed chain into a fresh disposable local stack
with ambient default ACLs removed and adds no grant. It proves immediate
activation, repeat/concurrent recovery and revoked-member refusal under the
shipped grants. It does not establish managed/direct lifecycle parity.
The [package guide](../PLATFORM_PACKAGE_REFERENCE.md#operator-invitations) gives
its local endpoints, controlled setup and exact invocation.

Runtime capability regressions execute operator and support gates as
`service_role`, including exact inactive-operator and machine-actor refusals,
missing subjects and prohibited unrelated column access. Two independent
service transactions prove renewal selection skips locked normal and retry rows
and admits them after release. The database owner only creates fixtures and
observes refused mutations. A proposed SQL overlay in a disposable database is
local behavior evidence; committed-chain replay and delivery checks remain
separate requirements.


The application-file lifecycle primitive checks caller-supplied schema ranges
without reading or changing the database. Keep that file-ownership reconciliation
separate from the actual expand/backfill/contract evidence below; its successful
apply does not prove old/new SQL compatibility or authorize a migration.

Every production-shaped schema change follows this order:

1. **Expand** with an additive, backwards-compatible schema change.
2. **Compatible deploy** code that can read the old and new shapes.
3. **Backfill** through a resumable, observable, idempotent process.
4. **Contract** in a later release after the old shape is no longer consumed.

Code rollback must remain compatible with the expanded schema. A destructive
down migration is not a rollback plan. Each stage needs a clear readback and
failure boundary; a backfill that cannot be safely retried is incomplete.

The managed forward `20261003110000_required_platform_policy_data.sql` supplies
configuration omitted by the schema-only baseline. It initially classifies 27
relations referencing clients: four marketing relations carry, account-event
history stays on the archived lead, and the other 22 block absorption. Unknown
future relations still refuse. M3 adds a blocking stock-wait classification,
bringing the current inventory to 28. Existing classifications survive replay.

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

## Identity reference grants

Evidence: historical record, 2026-11-13. Not reader guidance.

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

Evidence: historical record, 2026-11-13. Not reader guidance.

`COMMUNICATIONS_MIGRATIONS` carries byte-identical projections of the existing
canonical comms outbox, transactional receipt, communications control-plane,
native operations and account newsletter withdrawal units at positions
2, 9, 20, 70 and 88 in the legacy catalogue. The withdrawal forward follows the
issued bootstrap tails in qualified plans. Their hashes and canonical paths
are checked against the corresponding legacy manifest entries. This sparse
module projection is not an independent install chain. The full selected canonical
prefix and existing schema probes remain required. Managed receipt RPCs retain
their current service scope; direct receipts retain one role-free transaction per
operation and their accepted/failed replay boundaries.

The narrowed import moves receipt stores and their ledger contracts. Reference
mail-provider timeline/send-ledger implementations remain at their existing
owners; no provider mapping or new schema enters the package.

## Complete account consent choices

Evidence: historical record, 2026-11-13. Not reader guidance.

The opt-in native forward `20261101232000_customer_account_consents.sql` adds
`customer_account_communication_choices_as_actor(uuid)` and
`customer_account_communication_choice_set_as_actor(uuid,text,boolean,text)`.
These are actor SECURITY DEFINER boundaries: `auth.uid()` must own the supplied
client. Authenticated callers receive EXECUTE only; preference, event, evaluator
and sync tables receive no browser DML grant. A pinned `pg_catalog, pg_temp`
search path and qualified references avoid caller name resolution. Invoker
routines cannot write the deliberately ungranted preference/event tables.
The existing newsletter actor reader/setter below retain their behaviour.
Both newly created account tables revoke ALL from PUBLIC, anon, authenticated
and service_role, with RLS enabled and no browser policies. Their definer
routines retain the required access without direct caller table privileges.
Table checks bound lengths, nonblank target identifiers and the two literal copy
versions. The command refuses target control characters, derives a lowercase
SHA-256 fingerprint and constructs the exact copy version for its closed purpose
list. Privileged direct ledger writes no longer have table-level hex or
purpose/version-pair validation; trusted installation code must preserve those
rules. Customers have no direct ledger/configuration write path.

The read returns `customer.account_communication_choices.v1`, with contact and
both `marketingNewsletter` and `marketingGiftsDiscounts`. Each carries purpose,
state, granted, source, reason, capture/update time and nullable consentCopyVersion.
Absent permission is unknown; an owned client without an email returns null.
Read creates no contact or permission. Gifts/discounts is independent of launch
offer. Historical or externally changed evaluator rows retain their state and
times, with null attribution when no matching account event proves it.

The command accepts client UUID, purpose, boolean choice and idempotency key.
It returns `customer.account_communication_choice_result.v1` with permissionEventId,
nullable workId, replayed and current choices. A valid withdrawal with an owned
client and non-null stored email commits the local preference (newsletter),
evaluator denial and permission event immediately. Provider sync is optional:
no usable target or unusable email yields workId=null and no outbox/sync row.
A registration failure also rolls back only optional work for a withdrawal;
grants still require usable email/target and atomic work registration. Null
stored email and invalid command/key still refuse. A suppression always wins.
Exact replay returns the stored event ID and work ID (including null) with
current choices, without reapplying an old choice or filling in missing work.
Conflicting reuse refuses with `account_consent_idempotency_conflict` (23505).
Ownership is checked before replay disclosure.

The new `customer_account_consent_events` ledger records requested choice and
effective state separately, actor/client/email fingerprint, source/reason,
copy version, client/route attribution, capture method/time and work ID. Copy
versions are `customer_account_marketing_newsletter.v1` and
`customer_account_marketing_gifts_discounts.v1`. A current suppression retains
its state and original evaluator timestamps; an account choice never clears it.
The requested choice remains audited, and sync work requests suppress. The read
does not attribute an external suppression to a customer's grant event.

A trusted migration/admin connection configures the single
`customer_account_consent_sync_targets` row with binding, provider_kind and
enabled=true before grants or provider registration. No target is seeded or
inferred. Grants refuse missing/disabled targets or control characters in either
identifier with `account_consent_sync_target_unavailable` (55000), and unusable
email with `account_consent_email_invalid` (22023). A withdrawal records locally
without that work when either prerequisite is unavailable. Customers cannot
configure or select targets. The provider remains unaware of an unsynced denial;
enabling a target later or replaying the original key does not enqueue it.
The target is held stable through the command. Source/work IDs use the reserved
`account-consent:<permission-event-uuid>` namespace; the account-specific command
fingerprint binds its payload/target, while the aggregate and event type match
the existing native sync rail. Hosts must not register that reserved source key
through the separate TypeScript registration API.

For an unusable non-null email, the local recipient fingerprint remains SHA-256
of the normalized stored text, including an empty or otherwise invalid result;
that string is never passed to provider registration. The withdrawal also denies
recipient fingerprints previously recorded by this actor/client for this purpose,
using the existing event ledger, so correcting back to an earlier granted
address cannot resurrect its old grant. Each recipient's suppression and times
remain protected. Event metadata records `recipientFingerprints` and
`syncDeferredReason`; no extra raw email is copied into the ledger. A fresh valid
address is a separate unknown/default-denied recipient, requiring an explicit
new grant. The historical denial is retained, and replay never retargets it or
reapplies it over a later choice. Database/JavaScript case-fold limits below
still apply; there is no general automatic email-change/provider migration.

Owner-only read of locally recorded withdrawals without work:

```sql
-- account-consent-unsynced-denials
SELECT id, principal_id, client_id, purpose, recipient_fingerprint,
       metadata->'recipientFingerprints' AS recipient_fingerprints,
       source, reason, consent_copy_version, source_ref, captured_at,
       metadata->>'syncDeferredReason' AS sync_deferred_reason
FROM public.customer_account_consent_events
WHERE requested_consent = false AND work_id IS NULL
ORDER BY captured_at, id;
```

This audit query includes effective denials and retained suppressions, and may
include historical withdrawals superseded by later explicit choices. It does
not send or retry anything. Operators must reconcile current choices, usable
addresses and trusted targets before any provider action; no reconciliation
writer or automatic backfill is supplied here. Reference fields and idempotency
keys can contain identifying strings: hosts should use opaque references. No
erasure path for this consent history exists yet; transfer does not add one.

`outbox_events` and `communication_native_sync_state` remain the sole sync rail,
with the existing per-contact/target aggregate ordering and worker claims,
leases, retry limits and finalizers. The purpose CHECK additionally admits
`marketing_gifts_discounts`; host composition must classify that purpose as
marketing in its evaluator registry. Nothing here activates provider transport.
No array/jsonb parameter encoding is introduced by these SQL signatures.
The [real PostgreSQL witness](../../../tests/postgres/customerAccountConsents.test.ts)
uses the restricted runtime login and `SET LOCAL ROLE authenticated` for actor
calls, covering refusal, replay, suppression, rollback and worker consumption.
Database lowercase normalization retains the locale/Unicode limits explained
in the newsletter section below; no broader normalization parity is claimed.
The native delivery-observation adapter suppresses newsletter, gifts/discounts,
launch-offer and tester consent after a bounce or complaint. The account-consent
PostgreSQL regression grants the three marketing purposes, applies each provider
hold through the restricted runtime adapter and verifies suppressed evaluator
state, callback replay and suppression retention after subsequent account grants.

## Account newsletter withdrawal upgrade

Evidence: historical record, 2026-11-13. Not reader guidance.

After installing the complete portable chain containing
`20261030110000_customer_newsletter_withdrawal.sql`, every account newsletter
opt-out atomically denies a missing or granted `marketing_newsletter` consent at
the principal's stored email fingerprint. For evaluator-accepted addresses, this
matches the evaluator when database and JavaScript lowercase normalization agree. An existing denial or suppression is unchanged;
an older caller timestamp still denies a grant without moving its timestamp
backwards. Other purposes remain untouched. Opt-in changes only the account
preference: after opt-out and back in, the evaluator still refuses until an
explicit grant is separately recorded, while account read-back shows the preference.

The setter deliberately does not copy the evaluator's address-acceptance rule
into SQL. An evaluator-refused address can receive a denial under a fingerprint
that the evaluator never reads; its answer remains refused.

The explicit trimming set matches the evaluator-accepted JavaScript whitespace
class. Case folding still uses the database's `lower()` and its locale, as the
existing acquisition path does. On the measured `en_US.utf8` image it differs
from JavaScript for Turkish `İ`, context-dependent Greek `Σ` and some newer
letters; a C-locale database also leaves `Ä` uppercase. Withdrawal and the operator
statement target the evaluator's fingerprint only where the lowercase results
agree. No case-mapping change is included here; this withdrawal path assumes a UTF8 database.

An opt-out recorded before this version does not change an existing `granted`
row until an operator runs the following statement through the direct migration
or administration connection. It denies a newsletter grant only when its timestamp
is at or before the matching false preference; a later explicit grant is kept.
The statement preserves suppression, enabled preferences and other purposes.
It is idempotent: a second run changes no row.

<!-- account-newsletter-withdrawal-upgrade -->
```sql
UPDATE public.communication_recipient_consents AS consent
SET state = 'denied',
    updated_at = GREATEST(consent.updated_at, preference.updated_at)
FROM public.clients AS client
JOIN public.customer_communication_preferences AS preference
  ON preference.principal_id = client.principal_id
WHERE consent.recipient_fingerprint = encode(sha256(convert_to(lower(btrim(client.email, E'\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff')),'UTF8')),'hex')
  AND consent.purpose = 'marketing_newsletter'
  AND consent.state = 'granted'
  AND preference.marketing_newsletter_consent = false
  AND consent.updated_at <= preference.updated_at;
```

The account setter registers no external provider synchronization; compose any
provider withdrawal separately. A recorded denial stays keyed to the old email
fingerprint after an email change and does not follow a new address. The distinct
`retention_marketing` purpose requires its own explicit grant at retention creation
and claim; no packaged writer grants it, so the host capturing it also owns its
withdrawal. `marketing_launch_offer` is independent as well. The
[real PostgreSQL witness](../../../tests/postgres/customerNewsletterWithdrawal.test.ts)
executes this exact statement and exercises the real actor setter and evaluator
across the selected legacy, qualified and restricted installation shapes.

## M09 incumbent queue fence

Evidence: historical record, 2026-11-13. Not reader guidance.

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
No data-reading column default is admitted. Creation and seeding of this table
precede every FK-bearing invoicing table, so the history scan holds no locks on
orders or accounting tables and permits order, settlement and dispatch writes.
The subsequent FK installation still takes table locks until the install
transaction commits; schedule that shorter write pause. Sweeps use indexed `NOT EXISTS` against that set, with source/order
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
acceptance cannot re-enter send after lease expiry. Native delivery claims hide
claimed deliveries from the incumbent claimer with `lease_until='infinity'`,
and expired processing receipts become `uncertain` with `lease_expired`, never
eligible for repeat send. Settlement checks exact sent replay first, then refuses expired or
null leases; `failed_before_send` with `retryable:false` parks at infinity,
otherwise it backs off by a whole `retrySeconds` clamped to 60..86400 seconds
(or 900 for absent or invalid values). Source retention is a host
lifecycle obligation until capture or an explicit terminal policy receipt.

Native capture marks genuinely new base duties, including sweep capture, and
the document-effects forward marks genuinely new correction children only when
the seller request wrapper supplies `sellerPolicyVersion=invoicing.seller.v1`.
The later seller
wrappers materialize eligible seller rows; they do not make legacy work new.
The first-ever claim captures the selected host seller and revision in the same
transaction: native duty generation 1 or managed outbox attempt count 1. An
uncaptured revision remains legacy after a bare claim; a later wrapper claim
cannot freeze it. Retry preserves that
seller; new corrections have independent eligibility. A new sidecar around an
old document/request or a duty already claimed before seller freezing is legacy
and returns the execution-supplied fallback. The managed request wrapper accepts
`order_status_reversal` with the order ID, reason and nested payload, preserving
the incumbent result and effects while marking only a newly inserted correction.
For the managed `correction` branch, an unissued parent delegates to the incumbent
void path only when it is the order's latest invoice and the reason is
`order_canceled` or `order_refunded`; other parents/reasons retain scaffold
validation. New scaffold requests store `sellerRequestKey` and an original evidence snapshot
in the correction payload. Replays require the same key and evidence, excluding
`providerCreateIdentity`; conflicts raise SQLSTATE `23505`. Rows without a stored
key keep legacy replay behaviour. Native corrections always delegate to the
reversal RPC's validation and deduplication.
Issued documents and historical seller/buyer/line facts are never rewritten.

`managedInvoicingForwards` is a separate bounded admission, with three fixed
paths and ordered signature sets in the checker: new correction v2 overloads,
legacy fail-closed compatibility replacements, and new seller wrappers plus one
seller table with RLS enabled. Whole-file and function before/after hashes bind their definitions.
It preserves the original `SECURITY DEFINER`, `search_path = public, pg_catalog`
and EXECUTE only to service_role, with PUBLIC/anon/authenticated revokes. The
native creation class additionally admits the exact cutover seed and the
`WITH (security_invoker=true)` view form; existing managed classes are unchanged.
The managed class refuses unexpected signatures, attributes, triggers, tables,
grants or lexical forms. Native structural classification permits a new trigger
with an in-file trigger function. M09's whole-file pins exclude native triggers;
the catalog proof also verifies that these forwards add no explicit trigger
attachments to pre-existing tables.

The [registry](../../../config/reviewed-platform-forwards.json) binds all seven final
fixture paths and hashes. The [catalog proof](../../../tests/postgres/reviewedPortableCreation.test.ts)
applies every fixture to real PostgreSQL, preserving existing object/ACL
boundaries except the exact pinned replacements and checking native invoker
versus managed service-only attributes. Positive and refusal plants exercise
both CI and release admission. Control approval alone provides no runtime,
provider, deployment or fiscal-readiness evidence.

## P4a native store projections

Evidence: historical record, 2026-11-13. Not reader guidance.

`INVOICING_MIGRATIONS.native.units` projects unchanged accounting rails at
positions 7, 13 and 15 and the three pinned M09 forwards at 77, 78 and 79.
Every packaged asset is byte-identical to its canonical file. The
[M09 migration owner](../DATA_AND_MIGRATIONS.md#m09-invoicing-forward-design-and-control-approval) defines
installation order and prefix preservation.
The native descriptor declares child-document corrections and explicit host
fiscal facts. The separate managed descriptor names P3's base-row correction
forwards; neither descriptor claims storage or fiscal parity.

The seller-revision forwards are introduced by this change as described in the
[compatibility lifecycle](../../../packages/core/docs/guide/upgrade/database-migrations.md#check-application-compatibility). Default service activation
remains later work.

The operations package carries an unchanged projection of native forward
`20260814010000_platform_control_plane.sql` at manifest position 28. Its sparse
`OPERATIONS_MIGRATIONS` descriptor is not an install chain: install the complete
canonical native prefix, including prior job-ledger objects. Existing invoker
routines require explicit EXECUTE and underlying relation privileges, and a
current row in `platform_control_operators`. That allowlist does not grant identity
membership or domain write authority. The installed consumer proves the selected
runtime role can write controls/heartbeats while a neighboring subscription write
refuses; managed verification remains unclaimed.

The projection's whole-file SHA-256 is
`b0c8ef6424ebc6f1a84cb132c37908f4831fa40484a729c3713cfb35936559c9`.
Its existing persisted channel enum accounts for exactly one `ui-12` count.
The [neutrality owner](../../../CONTRIBUTING.md#contribution-checks) admits
only this exact package path, digest and 0-to-1 tuple with its matching baseline
key. This preserves canonical bytes without admitting other package SQL,
changing scanner patterns or raising any existing count.

## Native retry timing and timed resume

Evidence: historical record, 2026-11-13. Not reader guidance.

`20261109100000_subscription_retry_resume.sql` replaces
`subscription_retry_open_case(uuid,text,text)`,
`subscription_auto_resume_due(integer,timestamptz)` and the compatibility
`subscription_retry_apply_failure(uuid,text,jsonb)` entry, preserving headers,
invoker security, owners and ACLs. Its service-only timing overload adds a
separate final `jsonb` argument containing `backoffHours`; the original signature
delegates with `[24,72,168]`. Positive numeric offsets are hours after each
failure; array length controls exhaustion, while terminating-class semantics and
receipt-first replay remain unchanged. The native store registry pins all four
definitions and the exact forward bytes. No table, backfill or trigger is added.

The open-case fence precedes case propagation under the subscription lock and
retains terminal-cycle refusal after a later resume. Lifecycle closure already
terminalizes unpaid artifacts; this forward closes the missing-case observation
path. Timed resume uses healthy native method state and existing line, case,
cycle and order ownership relations. Paid orders are associated through their
cycle, renewal operation or activation. The follow-up
`20261109113000_subscription_auto_resume_delivered_history.sql` replaces only
`subscription_auto_resume_due(integer,timestamptz)` and chains its before-hash
to that earlier replacement. The completing follow-up
`20261109150000_subscription_auto_resume_paid_history.sql` replaces that same
function and chains its before-hash to the delivered-history replacement. The
order guard mirrors customer resume: `paid`, `fulfillment_pending` or `fulfilled`
orders block for a cycle of this subscription scheduled at `next_cycle_at`.
An associated order without a cycle blocks only for an unfinished renewal
operation (`claimed`, `reserved`, `attempt_prepared`) or activation (`provisional`).
Terminal operations (`succeeded`, `refused`) and activations (`active`,
`compensated`) do not keep that order in flight. Native shipment delivery leaves
an order `paid`; paid orders of past cycles and completed activations therefore
do not keep a timed pause open. Cancelled pause-closure orders do not block.
That follow-up retains every other guard, the event, date calculation, header
and ACL. The later `20261110105000_subscription_pause_duration.sql` replaces
auto-resume and the two-argument pause-reminder producer, chaining to their
exact replacement and creation pins. A timed pause shifts the stored next cycle
by the actual `ends_at - starts_at` duration and never brings it earlier.
Auto-resume takes `GREATEST(stored_next_cycle_at + duration, p_now)`; the reminder
uses the same shift clamped to the window end for `nextDeliveryAt` and `resumeAt`,
the date a punctual auto-resume executes. A STABLE invoker facts helper is shared
by the producer and retained-ledger delivery; PUBLIC execution is revoked and
only the service runtime receives execution. It reads existing window and cycle
facts without additional table privileges.
It removes the timed whole-cadence roll-forward while retaining all skip guards,
headers, owners and ACLs. Manual customer resume is unchanged. The
[duration witness](../../../tests/postgres/subscriptionPauseDuration.test.ts) covers
reminder agreement and one ordinary renewal under replay. The
[delivered-history witness](../../../tests/postgres/subscriptionAutoResumeDeliveredHistory.test.ts)
covers legacy and both qualified runtimes. Ineligible windows remain open without
writes or batch failure. Eligible windows shift the cycle monotonically, retain
one system event and close atomically. The result preserves native `skippedRows`.
The [workflow owner](../SUBSCRIPTION_WORKFLOWS.md#lifecycle-and-retry) describes host
composition and the resumed-confirmation alias. The
[PostgreSQL witness](../../../tests/postgres/subscriptionRetryResume.test.ts) covers
legacy and both qualified runtime generations.

## Terminal native notice refusals

Evidence: historical record, 2026-11-13. Not reader guidance.

The native lifecycle binding retains `subscription_notice_refusals` by the
original `(source, source_id)`, for event and reminder sources only. Its reason
is the existing `notice_policy_refused` code and its time is database-recorded.
A refusal is terminal, including after recipient, control or consent changes;
it never asserts a send or changes a transactional delivery receipt. The runtime
can insert and read this RLS-protected record, with no update or delete access.
Browser roles have no access. Connected capture and restore retain these opaque
source identities and their refusal times so a store move cannot send them again.
This table contains no recipient address, message content or free-form reason.


The [customer checkout-link forward](../../../db/platform/migrations/20261110115000_customer_checkout_links.sql)
replaces only the actor find/issue bodies, retaining their attributes, defaults
and authenticated execution boundary. It adds an actor-owned fallback reader
and two service-only buyer routines, with no table, index, constraint or raw
DML grants. Provisional activation identity supplies initial checkout context;
a non-null native cycle refuses checkout recovery. Actor issuance preserves
prior links. Buyer issuance uses existing outbox uniqueness to commit its bucket
event and hashed token together, only for the winning event. Both check actual
time after blocking writes and roll back elapsed issuance. The additive buyer
delivery gate leaves automatic and operator authorizers unchanged. See the
[entry-point recipe](../../../packages/core/docs/guide/how-to/build/checkout-recovery.md#add-customer-recovery-entry-points)
for the host authority boundary and configured deadlines.

## Checkout recovery lineage

Evidence: historical record, 2026-11-13. Not reader guidance.

`20261110170000_checkout_recovery_inspection.sql` adds nullable
`commerce_orders.recovery_root_order_id` and `recreated_from_order_id`, each with
an `ON DELETE RESTRICT NOT VALID` self-FK. Existing rows remain null; new writes
must satisfy both constraints. The partial root/created index serves the latest
reader, and the partial unique predecessor index permits one immediate replacement.
The two stable definer snapshots grant execution only to `service_role`, with no
new raw-table grants. Their [package composition](../../../packages/core/docs/guide/how-to/build/checkout-recovery.md#inspect-a-link-before-showing-recovery-controls)
binds client ownership and separates expired inspection from payment authority.
This forward contains no recreation writer or historical backfill.

## Expired checkout preparation

Evidence: historical record, 2026-11-13. Not reader guidance.

`20261110180000_checkout_recovery_recreation.sql` adds the service-only definer
`commerce_prepare_expired_checkout_recovery(text,uuid,uuid,bigint,timestamptz)`.
It replaces no function and adds no table, lifecycle CHECK, trigger or backfill.
It uses the existing recovery lineage, draft receipt, destination, provisional
activation and sandbox payment owners. Its fixed path is `pg_catalog, pg_temp`;
PUBLIC, anon and authenticated have no EXECUTE grant. Exact linked replay precedes
fresh checks; a replacement with either lineage field already populated refuses
fresh preparation. The source payment/window checks follow blocking aggregate
locks. Runtime first payment admission also rechecks source evidence under the
source order lock before any replacement stock or payment write. A fresh initial declaration belongs to the replacement; the predecessor
is never reopened. See the [recreation composition](../../../packages/core/docs/guide/how-to/build/checkout-recovery.md#recreate-a-technically-expired-checkout)
for commercial validation, transaction binding, compensation and profile limits.

## Atomic checkout guidance read

Evidence: historical record, 2026-11-13. Not reader guidance.

`20261110220000_checkout_payment_guidance.sql` creates only
`commerce_checkout_payment_guidance_snapshot(uuid,uuid,uuid DEFAULT NULL)`.
The SQL/STABLE definer fixes `search_path = pg_catalog, pg_temp` and exposes only
service EXECUTE. It replaces no function and adds no table, trigger or backfill.
Pure joins read checkout provenance, token authority, native attempts and bounded
correlated observations/truth/readback evidence together. It neither calls a
materializing reader nor treats observed capture as completed settlement.
Current complete-installation inventories include the new function; historical
prefixes are unchanged. The [composition recipe](../../../packages/core/docs/guide/how-to/build/checkout-recovery.md#show-payment-recovery-guidance-from-one-snapshot)
owns capability opt-in, neutral normalization and the sandbox profile limits.

## Operator shipment evidence

Evidence: historical record, 2026-11-13. Not reader guidance.

The native `20261110230000_operator_shipment_commands.sql` forward adds three
bounded owned shipment commands and reuses the private operator receipt table.
It widens its kind CHECK, adds nullable provider identity to tracking references,
and expands reference uniqueness by provider while preserving duplicate-null
behavior. Explicit same-order reattribution retains displaced reference rows in
the private receipt; it performs no historical backfill. Existing runtime table
privileges and receipt privacy remain unchanged.

A fresh nullable operation actor column references the human principal with
`ON DELETE SET NULL`; historical actors stay null. The arrival recorder retains
its INVOKER header, owner, ACL and subscription-before-parcel lock order.
Ordinary arrival keys retain strict timestamp replay. The operator chronology
namespace permits earlier-only repair and retains the original arrival receipt.
No decision or status evidence alone calls replacement confirmation. See the
[shipment composition and limits](../../../packages/core/docs/guide/how-to/build/fulfillment.md#bind-operator-commands-and-reads).

## Saved subscription destination selection

Evidence: historical record, 2026-11-13. Not reader guidance.

`20261110240000_subscription_saved_address_selection.sql` creates the owned
`subscription_select_saved_shipping_address` wrapper and replaces the existing
subscription destination reader, typed-address command and parcel-contact resolver
without changing their
headers, owners or ACLs. The wrapper retains principal/client ownership,
subscription-event replay precedence, shipping/both-kind validation and the
existing lifecycle/locked-cycle refusals. It persists the existing saved pointer;
a successful typed command clears it. This selection adds no column or raw DML grant;
the same forward also creates the private preference tables described below.
Only `service_role` receives EXECUTE on the new closed definer routines.

New subscription reads create an immutable snapshot of the selected saved row,
including its explicit ID and nullable recipient. Prior destination rows and
retained claims are unchanged; a future unclaimed renewal sees saved-row edits.
The public `read()` contract remains `Promise<DestinationDocument>`; the additive
`readWithSaved()` carries nullable saved snapshots. Typed address input still
requires a recipient. First parcel-contact capture preserves a null saved recipient
even with a nonempty label or current customer name; typed/legacy fallback remains
unchanged. Existing parcel contact ownership
and carrier-completeness checks remain decisive; frozen nulls are preserved.
Saved snapshots use the existing destination personal-data and finite-transfer
boundary. No new destination export/erasure path or blanket erasure coverage is
claimed. See [the package composition](../../../packages/platform/README.md#saved-subscription-shipping-selection).

## Scoped customer preference data

Evidence: historical record, 2026-11-13. Not reader guidance.

The saved-selection forward also creates `customer_payment_preferences` and
`customer_delivery_preferences`, with client cascade, one row per client/scope,
recent-selection indexes, enabled RLS and owner-only raw access. Both are `block`
classified with the admitted service-role client-ID census grant and SELECT policy.
Owned definer routines provide principal/client-checked read/upsert, redacted
checkout hints, private renewal selection and explicit subject export/erasure.
PUBLIC and browser roles receive no routine or raw table access; only
`service_role` receives routine EXECUTE. Payment values and provider families are
closed, with a bijective adopter policy for public values; delivery stores the
configured provider reference separately. No account-event append, instrument or
provider action is performed by a preference save.

`commerce_prepare_subscription_renewal` is the only native fresh cycle-order
writer. Its listed replacement retains its header, ACL and complete body except
for passing new order metadata through the selector. Explicit selections are
preserved; complete subscription/any preferences precede the earliest anchor
order. No trigger is added. Claims, replay, payment selection, delivery alignment
and the monotonic schedule clamp retain their existing owners and behavior.

All preference columns, scope history and pickup/address JSON are personal data.
The required `customer-preferences` identity contributor exports exact rows and
erases by subject client, without relying on client clearing or cascade. Its
preparation lock precedes identity locks; waiting saves recheck ownership.
Other privacy vetoes and retained account events stay separately owned. No
retention period is supplied. Finite native capture/qualified restore carries exact
rows after clients, with unchanged replay. Legacy installations are capture
sources; the compatible-row copier is unchanged. Managed-source nonempty
preferences have no typed projection and explicitly refuse. See the
[composition recipe](../../../packages/platform/README.md#customer-delivery-and-payment-preferences)
for the trusted checkout-client boundary, required billing-hint reader and
redacted `applied:false` defaults. No defaults are applied during import.

## Checkout attempt admission

Evidence: historical record, 2026-11-13. Not reader guidance.

`20261110250000_checkout_recovery_attempt.sql` creates the service-only
`commerce_checkout_recovery_attempt_begin(text,uuid,uuid,uuid,text,jsonb,timestamptz)`
and `commerce_checkout_inline_retry_begin(text,uuid,uuid,uuid,uuid,text,jsonb,timestamptz)`
entry points. Both fixed-path procedural definers lock the existing order and
intent, check checkout provenance and delegate to `payment_simulator_begin_attempt`.
Token payment rechecks its token identity; inline retry locks the exact active
attempt and compares its predecessor or durable transition replay. The latter
uses the existing request key/fingerprint for nonce/rail binding, without new
storage. Captured observations and renewal cycles refuse both mutations.

Only service EXECUTE is granted, after all PUBLIC revokes and grouped role
revokes. No existing function, table, trigger, column or historical row is
changed. The ordered plans append one unit containing both entry points;
current complete inventories advance while issued and released prefixes remain
fixed. See [token payment](../../../packages/core/docs/guide/how-to/build/checkout-recovery.md#retry-payment-with-a-recovery-token)
and [exact inline retry](../../../packages/core/docs/guide/how-to/build/checkout-recovery.md#retry-the-exact-failed-attempt-inline).

## Customer billing profile and invoice buyer data

Evidence: historical record, 2026-11-13. Not reader guidance.

`20261110260000_customer_billing_profiles.sql` adds private
`customer_orderer_profiles`: client cascade, contact/company/tax fields,
verification provenance, source, timestamps, length/enum checks, client/update
index and one-default-per-client partial uniqueness. It is `block` classified
with the exact service-role client-ID census exception. Customer CRUD/default
routines recheck the native principal/client pair. No raw profile grant exists.
Defaults, writes and account-event appends retain separate-commit failures and
stored-but-not-deduplicated request identifiers.

The simplicity pre-check rejects reusing the existing full-facts installer as
the request freeze point: request and installation are separate native calls.
The selected billing invoice-store factory uses the owned
`customer_billing_capture_invoice` transaction to delegate invoice request
ownership. Capture itself now freezes one `invoicing_buyer_snapshots` row for
every new original duty, including direct, payment-truth and sweep paths.
Selection is order facts, then default/latest profile and billing/both address,
then marked shipping fallback. Paid capture uses the order destination; handoff
capture uses the owned parcel destination. Later full fiscal composition reads
the component; the selected installer checks its retained fields before calling
the existing immutable full-facts owner. The later first-duty capture forward
below also installs this component on the native payment path. The selected
retained-source sweep calls the same atomic wrapper.
Creation eligibility is checked under the existing invoice order advisory lock;
a prior duty or document never acquires a component on replay, including an owed
duty without installed facts. Historical obligations receive no component backfill. The public
buyer contract adds optional fields only, and provider projection carries line2
and provenance without flattening or fabrication. This profile-storage forward
replaces no existing function, trigger, grant or fiscal policy.

Contact/tax/company/verification/source values, linked events and frozen buyers
are personal data. The explicit `customer-billing` contributor exports both
new tables, erases subject profiles through an owned routine after preparing
relation locks, and retains frozen buyers under the existing rule:
[Invoices are retained outside identity](../../../packages/core/docs/guide/concepts/personal-data.md#personal-data-coverage),
with document export, retention and processor handling supplied by invoicing.
There is no default statutory duration or new erasure claim for financial facts.
Identity field clearing and client cascade are insufficient coverage; account
event retention remains separately owned. Other subjects remain unchanged.

Finite native capture classifies both new tables as owned rows, outside the
smaller compatible-row utility. Qualified restore inserts profiles after clients
and components after invoice duties, with exact row/replay witnesses. Legacy
is capture-only. Unsupported nonempty managed-source profile relations refuse
rather than disappear. No restore applies profile defaults, rewrites invoices,
performs fiscal/provider work or activates a target. See the
[package recipe](../../../packages/platform/README.md#customer-billing-profiles-and-frozen-invoice-buyers)
for explicit ports, handler binding and the required privacy contributor.

## First-duty invoice buyer capture

Evidence: historical record, 2026-11-13. Not reader guidance.

`20261110270000_invoicing_duty_buyer_capture.sql` replaces only
`invoicing_capture_duty(text,text,uuid,uuid,jsonb,timestamptz)`, retaining its
installed header, owner, search path and ACL. It delegates to the new closed
`invoicing_capture_duty_with_buyer` routine. The latter preserves capture
validation, the order advisory lock and source/key receipts, and freezes the
existing buyer component only for its own fresh original-duty insertion.
An existing original document suppresses selection too. No duty or invoice is
backfilled, even if an older owed duty has no full facts yet.

The selection is the existing lossless billing rule: order buyer facts, then
the owned default/latest profile and billing-or-both address, then the marked
shipping fallback. The second address line and selection provenance remain in
`invoicing_buyer_snapshots`. The component and duty commit atomically; a failed
component insert rolls both back. Payment truth passes exactly its existing
inputs and keeps its existing bounded capture-fault/retry behavior. Payments
receives no account-data reader, callback or grant. There is no opt-in: first
native capture uses this rule, including the fallback when no profile exists.

Only `service_role` receives EXECUTE on the new definer routine. Its direct call
has the same fresh-insert guard, so it cannot be used to backfill a duty. Browser
roles remain denied; no raw table grant, table, trigger, status or public type
is added. The selected billing store reads the frozen component and validates
later host fiscal facts; it never rereads a mutable profile for that duty.
Edits affect later captures and cannot rewrite requested facts or issued bytes.
The existing billing privacy contributor, invoice-document retention owner and
exact finite transfer/qualified restore coverage continue to cover these rows.

A new source whose destination was never recorded refuses with the existing
`commerce_destination_unavailable` result and leaves no duty, buyer component
or source receipt. Record the owned order destination before retrying retained
capture; no address is inferred from another customer or field. Payment truth
continues to commit money and record its bounded capture fault independently.

Handoff capture must name a shipment owned by the order; otherwise it refuses
with `customer_billing_shipment_mismatch`. Destination reads use the existing
owner's locks; other buyer-selection lookups are plain reads. These reads remain
inside the payment owner's bounded, absorbed capture subtransaction when called
from payment truth.

Correct missing destination or shipment data while the capture fault remains
retryable. The sweep stops rediscovering a source after its eight-attempt ceiling
marks it `faulted`. There is no supported operator reset/requeue command: merely
recording a destination after that point does not resume the source. Escalate for
an invoicing-owned recovery procedure; do not edit or delete ledger rows to reset
it. Settled money and historical documents remain unchanged.

## Checkout recreation buyer snapshot repair (slot 28)

Evidence: historical record, 2026-11-13. Not reader guidance.

`20261110280000_checkout_recovery_buyer_snapshot.sql` replaces only
`commerce_prepare_expired_checkout_recovery(text,uuid,uuid,bigint,timestamptz)`.
Its installed header, owner, `pg_catalog, pg_temp` search path and ACL remain
unchanged. The forward adds no table, grant, trigger or backfill.

Fresh preparation copies a recorded source `invoiceBuyerSnapshot`, preserving
its JSON value exactly. A nonempty `runtimeFinalize.invoiceBuyerSnapshot` keeps
its existing precedence over the top-level snapshot; recorded empty objects
remain explicit. When neither source contains a snapshot, preparation adds no
snapshot key. Runtime metadata and lineage fields retain their existing behavior.

The first-duty buyer rule remains unchanged: an explicit object, then the owned
billing profile/address, then the marked shipping fallback. A recreated order
without explicit buyer facts can now reach those existing fallback branches.
Preparation replay never rewrites its linked replacement, and later profile or
address edits cannot change the buyer frozen by first capture. Historical orders
and previously captured duties are not repaired or reselected.
