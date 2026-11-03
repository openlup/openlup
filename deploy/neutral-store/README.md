# Local starter image build and rollback

Status: development-preview quickstart. This proves image rollback only, not a
live store, database continuity, data preservation or migration compatibility.
The starter host boots pending bindings, accepts only localhost/loopback
Host authorities and does not connect a database. Store actions are unbound
except `offer.validate` and `application.status`.

Prerequisites: Node 24.21.0, npm 11.19.0, Docker and an exact source checkout
with the matching locally packed three-package candidate set. These candidates
are not published release pins. Follow the starter's
[candidate artifact instructions](../../examples/neutral-store/artifacts/README.md).
Do not substitute floating registry packages.

## Prepare the application

Run from the source checkout. Choose an empty application destination and a
scratch parent outside it. These commands write only local application/scratch
files. Replace the three absolute tarball paths with the selected candidate set:

```sh
node examples/neutral-store/extract.mjs .context/scratch/recipe-app
node .context/scratch/recipe-app/lifecycle.mjs candidate /absolute/core.tgz /absolute/outbox.tgz /absolute/platform.tgz
```

Candidate import verifies the equal package versions and records SHA-256
identities, then generates the application's lockfile. The proof builds from
copies of this prepared application; it never edits the source starter.
The published [public-reference descriptor](../oci/public-reference.Dockerfile)
serves read-only reference pages and is unrelated to this application image.

## Check and exercise image rollback

```sh
node deploy/neutral-store/prove.mjs edge .
node --test deploy/neutral-store/prove.test.mjs
node deploy/neutral-store/prove.mjs rollback .context/scratch/recipe-app .context/scratch/recipe-proof
```

The proof builds A with the starter's Dockerfile, starts it only on a dynamically
selected loopback port, and requires a healthy `GET /api/config`. It changes one
owned English copy string in the scratch build context, builds B and requires
health again. Finally it starts the original A by its immutable image ID and
requires health. Each observation prints the running container's `sha256:` image
ID. These are local OCI configuration digests, not registry manifest digests.
A and B must differ; the final A must equal the first A exactly.

For a separate comparison, pass the three observed IDs in order:

```sh
node deploy/neutral-store/prove.mjs digest <A-image-ID> <B-image-ID> <restored-A-image-ID>
```

Replace the angle-bracket placeholders before running. A mismatch, malformed ID,
unhealthy response or failed cleanup exits nonzero. Containers have a unique
proof label, publish only loopback, and are removed along with proof-built images
and scratch copies. The prepared application remains for inspection. The proof
does not run Compose, mount a database or perform installation/migrations.
An image rollback says nothing about whether a schema/data rollback is safe.

The Edge check requires zero runtime imports/configuration hooks in recipe and
starter source. It conservatively scans source text, including recipe prose;
ignored generated dependencies/artifacts/build output and test instruments are
not application runtime input. The pure test plants imports and hooks and
requires refusal. This is a bounded source check, not a general code analyser.

The starter's passwordless Compose/HBA is accepted only as an isolated local
demonstration and is not reused here. Any deployment that connects a database
needs real credentials supplied by its operator through the target platform's
own secret mechanism. Never put credentials in a repository, Dockerfile, build
argument, image or committed configuration. This image-only proof uses none.
System fonts remain the starter's presentation choice. No supported, stable or
production-ready deployment is claimed.

## Executed local evidence

The image-only A → B → A run passed on 2026-11-02 with all three configuration
health checks passing and exact restoration of A. The
[task record](../../docs/platform/plans/oss-m19-recipes.md) quotes commands,
candidate identities and full image digests. No database was connected.

## Public host / Vercel blockers

This is a blocker list, not a deployment recipe or configuration template:

- The host starts pending bindings. Store actions lack a binding except the
  local offer validator and application-status report; successful configuration
  health does not prove purchase, accounts or persistence.
- The host accepts local authorities only. An operator-configured public origin
  belongs in the starter host and its origin/authority validation (starter scope),
  not under this deployment directory. Do not bypass these checks with header
  rewriting.
- The binder remains application-owned at
  [host/bindings.ts](../../examples/neutral-store/host/bindings.ts). A deployment
  recipe must not introduce a second binder or a new platform bundle.
- Portable PostgreSQL needs operator-supplied credentials through the host
  platform's secret mechanism, separate runtime/installation authority and an
  actually connected binder. The local demo's trust authentication is unsuitable.

A data-bearing rollback and a real public-host recipe wait for actual store
bindings. No hosted resource or account is created by this quickstart.
