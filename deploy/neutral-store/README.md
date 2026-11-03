# Local starter image build and rollback

Status: development-preview quickstart. Both image-only and local data-bearing
application-image rollback have been exercised. Neither
configuration health nor image rollback establishes a complete live store.
The binder remains application-owned at
[host/bindings.ts](../../examples/neutral-store/host/bindings.ts).

Prerequisites: Node 24.21.0, npm 11.19.0, local Docker with Compose supporting
scratch list replacement, and an exact source checkout with matching locally
packed three-package candidates. These are not published release pins. Follow
the starter’s [candidate artifact instructions](../../examples/neutral-store/artifacts/README.md).
Do not substitute floating registry packages.

## Prepare the application

Run from the source checkout. Choose an empty application destination and a
scratch parent outside it. Replace the three absolute tarball paths with the
selected candidate set:

```sh
node examples/neutral-store/extract.mjs .context/scratch/recipe-app
node .context/scratch/recipe-app/lifecycle.mjs candidate /absolute/core.tgz /absolute/outbox.tgz /absolute/platform.tgz
```

Candidate import verifies equal versions, records SHA-256 identities and generates
the lockfile. Proofs build scratch copies and never edit the source starter.
The [public-reference descriptor](../oci/public-reference.Dockerfile) serves
read-only reference pages and is unrelated to this application image.

## Exercise local rollback with data

```sh
node deploy/neutral-store/prove.mjs edge .
node --test deploy/neutral-store/prove.test.mjs
node deploy/neutral-store/prove.mjs data-rollback .context/scratch/recipe-app .context/scratch/recipe-proof
```

The data proof uses the starter’s lifecycle sequence: its Dockerfile build, its
Compose database, its one-shot `lifecycle.mjs install` with the packaged migration
history and demonstration seed, then its application with the restricted runtime
URL. A scratch override accompanies all four operations; the source Compose file
is unchanged. The demonstration database has no published port. Application
publication uses one chosen loopback port for the entire run.

Before A is built, scratch owned configuration receives a loopback publicOrigin.
All health and write requests send its configured Host; writes also send Origin,
`X-Starter-Request: 1`, JSON content type and an Idempotency-Key. The proof observes
the starter’s `starter_local_host_required` refusal for an ordinary loopback Host
that differs from the configured authority.

Under A, `partners.submit` writes a fictional inquiry and returns its reference.
B changes only an owned English copy string, then replaces only the application
on the same volume. Replaying the first command must return its original reference;
B writes a second inquiry. Restoration starts the original A by immutable image
ID, replays both commands and requires both original references. Read-only SQL
through the disposable database’s internal local socket also requires exactly
the two records, unchanged seeded catalogue counts and an identical applied-ledger
row count and SHA-256 content hash, including execution timestamps.

Each phase prints its running `sha256:` image ID, ledger observations and row
counts. These are local OCI configuration digests, not registry manifest digests.
A and B must differ and restored A must equal the original exactly. The final
result records the operation, command keys, references and unchanged package-input
hashes. The proof refuses a non-local Docker context. Runs share an exclusive
local lock; project names and labels are unique. Cleanup removes proof containers,
networks, volumes, built images and scratch copies, also on failure. Failed cleanup
exits nonzero; the prepared application remains for inspection.

The passwordless database is acceptable only as the starter’s own isolated,
loopback-only, disposable local demonstration. This establishes nothing about
real credentials, a hosted database, TLS or production deployment.

The proof covers an application-image swap over an unchanged schema and package
set, for the two records it wrote. It says nothing about rolling back a package
or schema upgrade. The [compatibility lifecycle](../../docs/platform/DATA_AND_MIGRATIONS.md#compatibility-lifecycle)
requires additive expansion, compatible code, resumable backfill and a later
contracting release. Code rollback must work with the expanded schema; it does
not restore the old schema or undo backfill, and destructive down migrations
are not a rollback plan. The [application CLI](../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md#application-command-line-tooling)
plans/applies application files without installing packages or running migrations;
its schema-range check and read-only diagnosis do not prove SQL compatibility.

## Retained image-only proof

```sh
node deploy/neutral-store/prove.mjs rollback .context/scratch/recipe-app .context/scratch/recipe-proof
node deploy/neutral-store/prove.mjs digest <A-image-ID> <B-image-ID> <restored-A-image-ID>
```

Replace the angle-bracket placeholders before running. This earlier subcommand
builds A and B and restores A using configuration health only. It runs no Compose
installation or database and establishes no data preservation. Its executed
2026-11-02 result is recorded in the [part 1 task](../../docs/platform/plans/oss-m19-recipes.md).

The Edge check requires zero runtime imports/configuration hooks in starter and
recipe source, including recipe prose. Generated dependencies/artifacts/build
output and test instruments are excluded. Pure tests plant imports and hooks
and require refusal. This is a bounded source check, not a general code analyser.
System fonts remain the presentation choice. Portable payments are sandbox only;
real money runs only on the managed rail for now. No supported, stable or
production-ready deployment is claimed.

## Current limits

The starter runs on its local demonstration database only; a hosted database
connection is not part of this release.
See the [starter’s limits](../../examples/neutral-store/docs/limits.md).

## Executed data proof

The local A → B → A data run passed with both original partner references,
unchanged ledger and catalogue observations, configured Host health and the
observed ordinary-loopback Host refusal. Cleanup passed. Exact commands, image
IDs, hashes and output are in [the task record](../../docs/platform/plans/oss-m19-recipes2.md).
