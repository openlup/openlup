# Managed pgTAP on plain PostgreSQL

Status: owner go-ahead on 2026-10-30 to prepare W1, W2 and W3 as stacked draft
pull requests; merges wait for the owner. The recommendations below are the
provisional decisions (see [Recorded decisions](#recorded-decisions)). This
planning change alters no CI behaviour.
Read the [intent](neutral-postgres-pgtap-intent.md) first.
Audience: the maintainer and the agents implementing the programme.

## Task record

- **Outcome.** The raw `pgtap` check runs every shipped `supabase/tests` file
  against the shipped managed baseline and forwards on one digest-pinned stock
  PostgreSQL 17 server, with one reviewed managed-compatibility adapter. The
  Supabase CLI, its derived images and CLI image-mirror planning leave hosted CI.
- **Smallest complete scope.** One compatibility SQL file, one extension supply
  route, one runner, a parity comparison, the workflow switch, and the removal of
  the CLI lane and its mirror derivation. Update the owning documentation sections
  in the same change.
- **Exclusions.** Migration or test edits; the portable `db/platform/migrations`
  chain and its native lanes; the opt-in subscription reference
  (`scripts/public-reference/`); the identity acceptance's `node-supabase`
  bundle; required context names; the legacy `db/bootstrap/vanilla-pg` prelude;
  [openlup/openlup#443](https://github.com/openlup/openlup/pull/443).
  Moving the `managed-batch-postgres` consumers in required `test` is a separate
  wave that needs its own decision (D2).
- **Authority.** This record grants nothing. Each implementation wave needs the
  owner's approval of the decisions below and an explicit delivery grant. The
  workflow, image pins and runner are CI controls, so each wave gets two
  independent fresh reviews.
- **Evidence for completion.** The parity proof below, passing on the agreed
  shadow window, then one green `pgtap` run on the switched lane with the old lane
  removed.

## Current state (verified 2026-10-30 at `6700bcfe`, after #443)

Per run, the `pgtap` job in `.github/workflows/published-tree-ci.yml` installs
the checksum-verified native Supabase CLI 2.122.0 through
`scripts/install-supabase-cli-ci.sh`, logs in to GHCR and runs
`scripts/public-ci-pgtap.mjs`. The runner:

1. binds the 29 committed `supabase/migrations` files to their Git blob identities;
2. renders `config/public-reference-subscription-supabase.toml` (PostgreSQL 17,
   Auth enabled) into a scratch project and pre-pulls the five CLI images
   through mirror, GHCR, ECR and Docker Hub fallbacks. `scripts/ci-image-mirror.mjs`
   derives the set from the CLI binary and the exclusion list, and
   `config/ci-images.json` `cliImages` pins each derived pair to a reviewed digest
   (`supabase/postgres:17.11.0.006`, GoTrue, Realtime, Storage API, `pg_prove` 3.36);
3. starts the stack excluding every long-running service. The GoTrue, Realtime
   and Storage schema-init images still run;
4. disables `supautils.hint_roles` and restarts PostgreSQL, because enhanced
   denial hints crash the pinned image (supabase/supautils#214);
5. revokes the CLI's default grants for `postgres` and `supabase_admin`, applies
   `scripts/public-reference/subscription-prereqs.sql` (`pg_trgm` in `public`,
   role `openlup_mcp_reader`), replays the baseline and forwards as `postgres`
   in one transaction, then installs `pg_cron` and pgTAP and grants
   `EXECUTE` on pgTAP's member functions to `PUBLIC`;
6. runs `supabase test db` over the 226 test files (the CLI supplies `pg_prove`
   and its image; `.sql`/`.pg` are discovered and `.inc` is not).

### What the SQL actually needs

These are textual counts (including comments) from
`rg -i -o --no-filename -g '*.sql' PATTERN DIR | wc -l`, so they are approximate:

| Dependency | Migrations | Tests | Notes |
|---|---:|---:|---|
| `auth.uid()` | 253 | 11 | RLS and authorization identity |
| `auth.role()` | 2 | 0 | two admin guards |
| `auth.jwt()` | 0 | 0 | |
| `auth.users` | 10 | 66 | columns `id`, `email`, `raw_app_meta_data`; tests snapshot whole rows with `to_jsonb(u)` |
| `auth.identities` | 3 | 0 | `user_id`, `provider`, `identity_data`, `updated_at` |
| `request.jwt.claims` / `request.jwt.claim.sub` | 0 | 29 / 3 | JSON claims plus the legacy scalar `sub` |
| `extensions.` | 3 | 221 | migrations: historical `extensions.%` operators; tests: all `dblink` |
| `CREATE EXTENSION` | 0 | 17 | 13 `dblink WITH SCHEMA extensions`, 4 `pgtap` |
| `cron.job` / `schedule` / `unschedule` | 0 | 18 / 6 / 10 | tests need real persisted jobs |
| `SET LOCAL ROLE` | 0 | 223 | `service_role` 170, `authenticated` 29, `postgres` 10, `anon` 8, test-created roles |
| `supabase_admin` / `authenticator` | 0 | 1 / 2 | default-ACL and privilege assertions |
| `storage.`, `realtime.`, `vault.`, `net.`, `pg_net`, `pgsodium`, `graphql`, publications | 0 | 0 | not needed |

Other facts that bind the design:

- Three foreign keys reference `auth.users(id) ON DELETE SET NULL`, and one
  deferred constraint trigger (`customer_support_identity_email_ownership`) is
  `AFTER UPDATE ON auth.users`.
- `pg_trgm` must be in `public` (baseline GIN indexes use `public.gin_trgm_ops`).
  No `pgcrypto`, `uuid-ossp`, `citext` or `btree_gist` dependency was found.
- dblink tests connect over TCP to `inet_server_addr()`/`inet_server_port()`
  with `user=postgres password=postgres`.
- The baseline starts with `\restrict`, so the replay `psql` must be a release
  that understands it.
- The baseline clears `search_path` and disables function-body checking, so
  successful DDL alone does not prove that runtime resolution works. Only the tests prove it.

### Existing precedents

- `tests/helpers/postgresContainer.ts` already runs digest-pinned stock
  PostgreSQL with disposable labels, tmpfs data, TCP readiness and mirror-aware
  pulls. `config/ci-images.json` pins `postgres:17`
  (`sha256:ae69c452…`, the install-proof image) and `postgres:16`.
- `db/bootstrap/vanilla-pg/` holds a donor-era prelude: roles, a JSON-only
  `auth.uid()`, an `auth.users` table without `raw_app_meta_data`, and inert
  `cron`, `net` and `vault` stubs. No CI lane applies it. Its inert cron
  stubs cannot satisfy the cron tests, and its storage, net and vault stubs
  add surface these tests do not need. The design borrows its approach, not the file.
- Several `tests/postgres` suites already build small inline auth and role stubs on
  stock PostgreSQL (for example `tests/postgres/omsQueueLadder.test.ts`, which
  includes the scalar `sub` fallback).
- The `managed-batch-postgres` pin (`supabase/postgres:17.11.0.004`) runs without
  the CLI in required `test` (`reviewedBatchForwards`, `riskControlFixture`,
  several `*Managed*` suites). That image remains a CI dependency until a later
  wave (D2).
- `ui-11` counts only the Supabase npm scope prefix. The CLI action reference, the bare
  word `supabase` and Docker repository names do not match it. Today's lane adds
  no `ui-11` debt. The pressure in #443 came from a launcher route that the
  neutral lane makes unnecessary, not from an exception to remove here.

## Target design

### Server and extensions

The lane runs one container from the pinned `postgres:17` digest, with the following settings:

- `POSTGRES_USER` is set to a neutral bootstrap superuser (for example
  `ci_bootstrap`), so that `postgres` can be created as an ordinary role with
  the managed attributes (see risk R2).
- The test-only password is `postgres`, for the `postgres` login that dblink and
  `pg_prove` use.
- `-c shared_preload_libraries=pg_cron -c cron.database_name=postgres` and an
  explicit `-c timezone=UTC` (see risk R6).
- Data lives on tmpfs, port binding is loopback only, and the container carries
  the existing disposable labels and cleanup from `tests/helpers/postgresContainer.ts`.

pgTAP, `pg_cron` and `pg_prove` come from one pinned route chosen in D3. The
recommended route installs version-pinned PGDG packages for PostgreSQL 17
(`postgresql-17-pgtap`, `postgresql-17-cron`) and Debian's
`libtap-parser-sourcehandler-pgtap-perl`. Each `.deb` comes from an immutable
archive URL with its SHA-256 committed, like the gitleaks install step, and
GitHub Actions cache keeps the downloads. The lane installs the packages into a
throwaway container layer, or with `docker build` from a committed Dockerfile
that names the digest. It makes no anonymous `apt-get update` against moving
indexes. `pg_prove` runs inside the container over TCP so that
`inet_server_addr()` is non-null.

The pgTAP and `pg_cron` versions should match the versions the
`supabase/postgres:17.11.0.004` image ships. The first implementation step records
both versions from that image. A version difference is a parity finding, not a
silent upgrade.

### Managed-compatibility adapter

One SQL file, a proposed tests/postgres/managed-compat/supabase.sql, is the only place
that encodes the managed host. Its location and name are decided in D4. Its
header names it as a Supabase-environment test adapter that is never applied to a
real managed project or installed by any runtime. It runs as the bootstrap
superuser before the existing prerequisites, and it is idempotent. It holds:

1. **Roles.** `postgres`, `anon`, `authenticated`, `service_role`,
   `authenticator` and the administrative identities that tests name
   (`supabase_admin`, and `supabase_auth_admin` as the `auth` owner). Each has the
   attributes and memberships recorded from the managed image, not guessed (see
   the environment fingerprint below).
2. **`auth` schema** owned by the auth administrator, with:
   - `auth.jwt()`, `auth.uid()` and `auth.role()` copied from the managed image's
     definitions, so they read `request.jwt.claims` and fall back to
     `request.jwt.claim.sub`/`.role`;
   - `auth.users` with the columns the SQL touches (`id` primary key, `email`,
     `raw_app_meta_data`, `raw_user_meta_data`, timestamps), plus the columns
     needed so `to_jsonb(u)` snapshots compare equal within one lane;
   - `auth.identities` with `id`, `user_id` (FK to `auth.users ON DELETE CASCADE`),
     `provider`, `provider_id`, `identity_data jsonb` and timestamps;
   - the schema `USAGE` and function `EXECUTE` grants that the managed image
     gives the browser and service roles. Table grants are copied only where the
     fingerprint shows them.
3. **`extensions` schema** with the managed image's `USAGE` grants. `dblink` and
   pgTAP install there, as they do today.
4. **Search path.** `ALTER ROLE`/`ALTER DATABASE … SET search_path` values copied
   from the managed image, so unqualified pgTAP assertions resolve identically.
5. **`cron` access.** The managed image's grants on the `cron` schema and tables
   for `postgres`.

The adapter has no storage, realtime, vault, net, GraphQL or supautils objects,
because nothing tested needs them. `scripts/public-reference/subscription-prereqs.sql`,
the default-privilege revocation and the pgTAP `EXECUTE` grant loop stay as
they are. The supautils formatter workaround and the restart drop out, because
stock PostgreSQL has no supautils.

### Runner and workflow

A new stock-PostgreSQL runner script beside the current one reuses
`readManagedMigrationChain` and the replay SQL assembly from the current runner,
and reuses the shared container helper and pull retry. It writes the per-file TAP
stream to `.context/scratch/pgtap/latest.log`. Like the CLI, it runs
`pg_prove --ext .sql --ext .pg -r` over a copy of `supabase/tests` that includes
the `.inc` migration includes. In the shadow stage it is a separate,
non-required job, `pgtap-postgres`. At the switch, the `pgtap` job runs it
under the same context name.

## Stages

| Wave | Delivers | Exit |
|---|---|---|
| W0 | This intent and plan (draft PR). | Owner decisions D1–D10 recorded. |
| W1 | Adapter, extension supply, runner, parity tooling and a non-required `pgtap-postgres` job beside the unchanged `pgtap`. No other CI change. | The parity proof passes locally and on the first hosted run. |
| W1s | Shadow window: both lanes run on every PR, merge group and main push. | D6's window is met with zero unexplained divergence. |
| W2 | The `pgtap` job runs the neutral runner. The changes: delete `scripts/public-ci-pgtap.mjs`'s CLI path, the native CLI install steps in both workflows and `scripts/install-supabase-cli-ci.sh` if nothing else uses it, CLI image derivation in `scripts/ci-image-mirror.mjs` and `mirror-ci-images.yml`, the `cliImages` pins in `config/ci-images.json`, and the GHCR login if nothing else needs it; update their tests; update the owning docs. | One green `pgtap` on the switched lane, and the published-tree policy report settled. |
| W3 (D2) | Move the `managed-batch-postgres` consumers in required `test` to the same image and adapter; then drop that pin. | The same parity method applied per suite. |

W1 and W2 are separate PRs so that the shadow evidence comes from the merged W1
lane, not from a candidate branch.

## Parity proof

The old lane is removed only when all of the following hold for the same
candidate tree:

1. **Same inputs.** Both lanes read the migration chain through
   `readManagedMigrationChain` and test bytes from the same checkout. The
   comparison records the tree SHA and the SHA-256 of each test file. W1 and W1s
   change no file under `supabase/`.
2. **Same results, assertion by assertion.** For every test file, the plan
   count, the ordered assertion descriptions, `ok`/`not ok`, and the SKIP/TODO
   markers are identical across lanes. A deterministic comparison script fails
   on any difference, including a file that runs in one lane only. File totals
   alone are not enough.
3. **Same installed contract.** After replay and before the tests, each lane
   dumps a normalised catalog snapshot of `public` and `private`: objects,
   definitions, ACLs, RLS policies, owners and triggers, including the
   `auth.users` trigger and the foreign keys into `auth`. The snapshots must be
   equal.
4. **Recorded environment fingerprint.** A query run on both lanes records, for
   the roles in the adapter and for the database, each role's attributes,
   memberships, per-role and per-database settings, default ACLs, and grants on
   `auth`, `extensions` and `cron`. It also records each extension's version and
   schema, and the `auth` function definitions. Every difference is either
   listed as an accepted adapter difference (for example supautils, absent
   services, GoTrue-only `auth` columns) or fixed in the adapter. The accepted
   list is part of the review packet.
5. **Not vacuously green.** A small fixed set of sabotage runs must fail in
   both lanes:
   - `auth.uid()` returns NULL;
   - one RLS policy is dropped;
   - one `service_role` grant is revoked;
   - `pg_cron` is unloaded;
   - the dblink password is wrong.

   Each sabotage is a local
   script argument, not committed SQL in the shipped tree.
6. **Vacuity audit.** The audit lists every assertion whose subject exists
   only because the adapter created it, such as the `supabase_admin` default-ACL
   check and the `authenticator` privilege checks. Reviewers confirm that each
   still tests what its description says.
7. **Shadow window.** The window set in D6 is met with no divergence. A divergence
   is closed at its root cause in the adapter or supply route. Neither a test edit
   nor a retry closes it, and a run gets at most one blind retry.

## W1 evidence

Local proof on 2026-10-30 for the W1 candidate (branch `claude/neutral-pgtap-w1`),
Docker Desktop on arm64. Both lanes read the committed chain through
`readManagedMigrationChain` and the same `supabase/tests` bytes; nothing under
`supabase/` changed. The old lane is the unchanged `scripts/public-ci-pgtap.mjs`
under the checksum-verified Supabase CLI 2.122.0, driven by
`node scripts/pgtap-parity.mjs cli-lane --supabase <absolute CLI path>`. That driver adds `--debug` to
`supabase test db`, so `pg_prove` adds `--verbose` and logs every assertion.

- **Supply.** The packages match the managed image exactly: pg_cron 1.6.4
  (`1.6.4-2.pgdg130+2`), pgTAP 1.3.3 (`1.3.3-3.pgdg130+1`) and `pg_prove` 3.36
  (`3.36-2.pgdg130+1`). They come from the PostgreSQL apt archive. The SHA-256 values
  were cross-checked against the archive's `trixie-pgdg-archive` package index
  for amd64 and arm64.
- **Same results.** Both lanes ran 226 files and 5,199 assertions. The
  per-assertion comparison is identical: plan, order, description, `ok`/`not ok`,
  with no SKIP or TODO markers.
- **Same installed contract.** The `public`/`private` catalog snapshots are equal
  (5,356 rows, including the three foreign keys into `auth.users` and the
  `auth.users` constraint trigger).
- **Not vacuously green.** Every sabotage fails on the stock lane:
  `auth-uid-null` (48 `not ok`), `drop-rls-policy` (6), `revoke-service-role-grant`
  (3, and one file aborts), `wrong-dblink-password` (231 assertions lost to
  aborted dblink files) and `no-pg-cron` (the replay refuses). The three SQL
  sabotages also ran on the CLI lane. Their per-assertion results are identical
  across the two lanes, so the adapter also behaves like the managed host under failure.
  `no-pg-cron` and `wrong-dblink-password` change server setup that the CLI owns,
  so they have no CLI-lane form; parity item 5 is met for them on the stock lane
  only, which is an accepted deviation.
- **Timing.** On a warm cache the stock lane takes about 18 s end to end, of
  which `pg_prove` takes 15 s. The CLI lane takes about 33 s with its images
  already local.

Divergences found and closed at their cause, all in the adapter or the server
setup:

1. On the managed host, supautils lets `postgres` create dblink as a privileged
   extension. Stock PostgreSQL refused the tests' `CREATE EXTENSION dblink` in 13
   files. The adapter now creates dblink in `extensions` as `supabase_admin`.
2. On the managed host, supautils lets `postgres` set `session_replication_role`
   through its privileged-role settings. The stock lane refused this in three
   files. The adapter now grants the native equivalent, `GRANT SET ON PARAMETER`.
   Before these two fixes, the first comparison showed 277 assertion differences
   in 18 files.
3. The managed database uses ICU `en-US`, while the stock default is libc
   `en_US.utf8`. The two order punctuation differently. No assertion depended on
   it, but the server now initialises with ICU `en-US`. The snapshot orders ACLs
   bytewise, so collation cannot hide a difference there.
4. The managed `postgres` and `supabase_admin` search paths contain the literal
   identifier `"\$user"`; the adapter copies it.

Accepted fingerprint differences (160 rows, from
`pgtap-parity.mjs diff` of the two fingerprints):

- Roles of absent services and their memberships, settings, default ACLs and
  ACL entries: `dashboard_user`, `pgbouncer`, and the `supabase_*_admin` roles
  for etl, functions, privileged, read-only, realtime, replication and storage.
- `supabase_admin`, `supabase_auth_admin` and `authenticator` are NOLOGIN
  placeholders (D5). Their other attributes and settings match.
  `authenticator` lacks the supautils/safeupdate preload.
- The bootstrap superuser `ci_bootstrap` exists, and it owns `plpgsql`.
- GoTrue-only `auth` tables, columns, indexes and constraints are absent.
  `auth.users` keeps `id`, `email`, the two metadata columns, `is_sso_user` with
  GoTrue's partial unique email index, and timestamps. `auth.identities` matches
  GoTrue's columns.
- The `auth` function bodies are byte-identical. Their ACLs are implicit rather
  than explicit, and differ only by the absent `dashboard_user`.
- Extensions: dblink is preinstalled (item 1). pg_cron reports control version
  `1.6` for the same 1.6.4 build. `pg_stat_statements`, `pgcrypto`,
  `uuid-ossp` and `supabase_vault` are absent, and nothing tested uses them.
- Parameter ACLs: the `session_replication_role` grant (item 2) is present, and
  the realtime `log_min_messages` grant is absent.
- Preload libraries differ (`pg_cron` only, with no supautils). The CLI-only
  `app.settings.jwt_*` database setting is absent. The ICU collation versions are
  153.121 (managed) and 153.128 (stock).

Vacuity audit: two assertions name identities that exist only through the
adapter. `inherited_table_privilege_class_test.sql` checks the `supabase_admin`
default ACL in `public`, and `inventory_recount_reserved_balances_test.sql`
checks that `authenticator` cannot execute the operator recount. Both subjects
carry the managed privileges, memberships and defaults, so each assertion still
tests what its description says.

Review repairs: the job restores the packages through a SHA-pinned
`actions/cache` step (v6.1.0) keyed by the pin file, as D3 decided, and the runner
re-verifies every cached file. Only a cold cache reaches the apt archive. The job
never reuses main-push evidence, because `scripts/public-ci-reuse.mjs` does not
cover its own merge-group result.

Still open for W1: the first hosted `pgtap-postgres` run. The job is skipped on
draft pull requests, as `pgtap` is.

## Risks

| ID | Risk | Mitigation |
|---|---|---|
| R1 | `supabase/postgres` and stock `postgres:17` differ in minor version, build options, locale and collation, or `psql` version (`\restrict`). | The pinned stock digest is `PG_VERSION=17.11-1.pgdg13+2` (Debian trixie), the same minor as `supabase/postgres:17.11.0.004`, and 17.11 `psql` supports `\restrict`. Record both builds in the fingerprint. Collation-sensitive assertions surface in the per-assertion diff. The `.deb` packages in D3 must target `pgdg13` and PostgreSQL 17. |
| R2 | Role semantics. In the managed image, `postgres` is not a superuser and `supabase_admin` is. On stock PostgreSQL, `postgres` is normally the superuser, which bypasses RLS and every grant check. | Create a neutral bootstrap superuser, and create `postgres` with the managed attributes recorded in the fingerprint. Tests and replay run as `postgres`, as they do today. Sabotage runs prove that refusals still fire. |
| R3 | Extension defaults. The managed image preinstalls extensions, schemas and grants; stock PostgreSQL has none. Missing pieces fail loudly, but extra broad grants in the adapter could mask a missing platform grant. | The adapter grants only what the fingerprint shows, and the catalog snapshot of `public` and `private` must be equal. Revoke grants rather than adding them. |
| R4 | GUC and JWT semantics. A hand-written `auth.uid()` might differ from GoTrue's (claims JSON, then the legacy scalar, then empty-string handling). | Copy the managed function bodies byte-for-byte into the adapter and compare definitions in the fingerprint. |
| R5 | `pg_cron` needs `shared_preload_libraries` and `cron.database_name`, and its job table has row security keyed to `username`. Superuser-only behaviour could differ. | Set both on the server command line. Cron tests run as non-superuser `postgres` in both lanes, and the cron grants come from the fingerprint. |
| R6 | Server time zone and other cluster GUCs (for example `timezone`, `DateStyle`, `statement_timeout`) differ between images. | The fingerprint records cluster settings, and the server command line pins the values the managed image uses. |
| R7 | The lane loses managed-host fidelity: supautils guards, GoTrue-owned `auth` columns and triggers, and future managed-image changes stop being exercised in CI. | Accepted by design. Adapter fidelity belongs to the opt-in reference and an optional non-blocking lane (D7). The plan claims a PostgreSQL contract, not managed-host certification. |
| R8 | A new external supply route (PGDG/Debian archives) replaces the registry pulls. | The route uses immutable URLs, committed checksums and the Actions cache, matching the CI external-dependency rule. The mirror registry is a fallback if D3 chooses a prebuilt image. |
| R9 | The CLI's `supabase test db` may add `pg_prove` flags or wrapping. | Discover the CLI's exact `pg_prove` argv from the pinned binary during W1 and reproduce it. Any difference appears in the per-assertion diff. |
| R10 | Overlap with #443 and with concurrent edits to `public-ci-pgtap.mjs` or `ci-image-mirror.mjs`. | W1 adds files only. W2 starts from the current main after #443 and owns the removal. |

## Cost and budget

These are planning estimates to check in W1:

- **Implementation.** W1 is about 150 lines of adapter SQL, 200 of runner, 150 of
  comparison and fingerprint tooling, the tests and one workflow job. W2 is mostly
  deletion (runner CLI path, mirror derivation, setup-cli in two workflows) plus
  documentation. W3 is sized after W2.
- **CI time.** The neutral lane pulls one roughly 150 MB image and a few MB of
  packages, against today's five CLI images plus restarts. Target ≤ 8 minutes,
  inside the existing 20-minute job limit. The shadow window costs one extra
  `pgtap`-sized job per run.
- **Review.** Each of W1 and W2 touches CI controls, so each gets two
  independent fresh reviews and the standard three repair cycles. A loop
  triggers the regroup procedure; it does not add cycles.
- **Retries.** At most one blind retry per hosted failure, then root-cause
  diagnosis.

## Owner decisions

| ID | Decision | Recommendation |
|---|---|---|
| D1 | Approve the end state: raw `pgtap` proves the managed SQL on stock PostgreSQL 17 plus one Supabase adapter file, and the Supabase CLI leaves hosted CI. | Approve. |
| D2 | Scope: the `pgtap` lane only (W1–W2), or also the `managed-batch-postgres` consumers in required `test` (W3). | Run W1–W2 now. Decide W3 after W2, with its own parity proof. |
| D3 | Extension and `pg_prove` supply: checksum-pinned PGDG/Debian `.deb` packages per run; a prebuilt image published to the existing mirror and pinned by digest; or a source build. | Checksum-pinned `.deb` packages with the Actions cache. This needs no new registry publication and no compiler toolchain. |
| D4 | Adapter location and relation to the legacy `db/bootstrap/vanilla-pg`. | A new test-only file, proposed as tests/postgres/managed-compat/supabase.sql. Leave the legacy prelude untouched and decide whether to retire it separately. |
| D5 | Managed-only role identities that tests name (`supabase_admin`, `authenticator`, `supabase_auth_admin`): create them as non-login placeholders in the adapter, or change the tests. | Placeholders in the adapter, so that tests stay unchanged and the vacuity audit covers them. |
| D6 | Shadow window length and divergence policy. | 10 consecutive green main and merge-group runs or 7 days, whichever is later. Any divergence restarts the count after a root-cause fix. |
| D7 | After W2, keep a non-blocking scheduled fidelity lane on the digest-pinned `supabase/postgres` image (no CLI), or none. | None in CI. The opt-in subscription reference already exercises the real managed stack. Revisit if a managed-only regression escapes. |
| D8 | PostgreSQL version policy: reuse the install-proof `postgres:17` digest and refresh it with the managed image's major version. | Reuse the existing pin. Refresh it deliberately when the managed major changes. |
| D9 | Required-check status of `pgtap`. | Unchanged; this programme does not make it required. |
| D10 | Delivery authority for the W1 and W2 PRs (exact-PR merge by the owner, or a programme grant). | Exact-PR owner merge, since both waves change CI controls. |

## Recorded decisions

On 2026-10-30 the owner asked for W1, W2 and W3 to be prepared by Claude Opus
agents as draft pull requests, stacked one on another, with merges deferred until
other sessions finish. This is the go-ahead for D1 and for W3 under D2.
Every other decision provisionally takes the recommendation in the table above.
D6's shadow window cannot start until W1 is merged, so W2 stays a draft until
the window passes. Local parity evidence on the W1 branch is the pre-merge proof.
Merging any wave remains an exact-PR owner act (D10).

## Documentation impact

When implemented, the change updates these sections in the same change:

- in [Data and migrations](../DATA_AND_MIGRATIONS.md#database-test-fixtures-and-witnesses),
  the CLI runner cleanup sentence;
- in [Canonical contracts](../CANONICAL_CONTRACTS.md), the image-inventory paragraph:
  the CLI-derived images and the pgTAP pre-pull;
- the CI description in [Development and release](../DEVELOPMENT_AND_RELEASE.md).

This planning change alters no behaviour and therefore needs no other section.
