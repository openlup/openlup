# @openlup/outbox

`@openlup/outbox` provides transactional PostgreSQL enqueue, at-least-once dispatch,
lease-bound schedules and registry composition. The application supplies handlers,
credentials and transaction ownership. This is a development preview with no stable
API or universal exactly-once guarantee: pin an exact version and upgrade the
`@openlup/*` set together.

```sh
npm install --save-exact @openlup/core @openlup/outbox
```

```ts
import { createPostgresOutboxStore } from "@openlup/outbox/postgres";
import type { SqlExecutor } from "@openlup/core/readiness";
export const bindStore = (executor: SqlExecutor) => createPostgresOutboxStore(executor);
```

This CI-compiled example binds a store; the executor must commit each operation
before resolving. Read [installation and transactions](#postgresql-installation-and-transactions) before use.
[AGENTS.md](AGENTS.md) explains application ownership and extension boundaries.
Node 24 or newer is required. Declaration maps connect `dist/` declarations to
shipped `src/`; JavaScript source maps are not shipped.

## Package Surface Maturity

<!-- generated:maturity:outbox -->
| Export | Role | Maturity |
| --- | --- | --- |
| `.` | rail | experimental |
| `./postgres` | rail | experimental |
| `./testing` | testing | testing |
<!-- /generated:maturity:outbox -->

## Guide

- [Deliver events with the outbox](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/how-to/build/outbox.md) — handler composition, schedules, readiness and retention.
- [Idempotency](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/concepts/idempotency.md#handler-effects-across-retries) — effects across retries.
- [Start and tutorial](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/start/README.md).
- [Extension seams](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/how-to/extend/choose-an-extension-seam.md).
- [Upgrade an application](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/upgrade/README.md).
- [Glossary](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/glossary.md).

## Installed agent context

Core's installed `openlup-context` searches core's installed reader guide under
`docs/guide/`, package `AGENTS.md`, `README.md`, declarations and exports, and
`CHANGELOG.md` for upgrade questions offline.
See [lookup instructions](https://github.com/openlup/openlup/blob/main/packages/core/README.md#agent-context-lookup); your application's instructions govern.

## Dispatch configuration and optional diagnostics

Moved to [Bind scheduled or immediate dispatch](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/how-to/build/outbox.md#dispatch-configuration-and-optional-diagnostics).

The parser and `validateScheduledConfig` share [`src/config.ts`](src/config.ts).
The optional diagnostics deadline in `src/worker.ts` is three seconds.

## PostgreSQL installation and transactions

Moved to [Install and enqueue](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/how-to/build/outbox.md#postgresql-installation-and-transactions).

[`sql/manifest.json`](sql/manifest.json) binds [`sql/0001_outbox.sql`](sql/0001_outbox.sql)
to its public migration owner. PostgreSQL 16 or later supplies the validated
timestamp parser used by compaction. Claims retain six timestamp digits.
Prune defaults are 30 days for processed and 90 for discarded, in batches of 500;
`src/postgres.ts` owns the terminal compaction statement and stamps.

## Readiness and verification

Follow [the composition guide](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/how-to/build/outbox.md#admit-and-bind-the-candidate)
for runtime admission. Contributor verification belongs to the
[contribution guide](https://github.com/openlup/openlup/blob/main/CONTRIBUTING.md#test-scope-and-diagnostics)
and the source [packed consumer proof](https://github.com/openlup/openlup/blob/main/scripts/packages/outbox-consumer-proof.ts).

From an OpenLup task checkout, the existing packed proof accepts an explicit disposable loopback PostgreSQL database and a verified cold-set manifest:

```sh
node --experimental-strip-types scripts/packages/outbox-consumer-proof.ts \
  postgresql://postgres@127.0.0.1:5432/openlup_outbox_proof \
  .context/scratch/outbox-packed-proof \
  --manifest "$OPENLUP_PACK_MANIFEST" --expected-commit "$OPENLUP_PACK_COMMIT"
```

Supply both manifest inputs together. The runner verifies the exact publishable inventory, versions, commit and tarball digests before installation; missing or damaged input refuses without repacking. It installs only Core and Outbox, the packages imported by this reference composition; unrelated modules have their own consumers. It installs outside checkout ancestry with scripts disabled, records consumed artifacts and installed identities in task scratch, injects only the host PostgreSQL test driver and compiles the actual reference composition. Omitting both inputs retains manual packing of already-built packages. The caller owns the disposable database; the proof closes its pools and removes its temporary consumer on success or failure. Required CI and its local runner provide an owned PostgreSQL 17 instance and an enclosing deadline.

For the local required route, run `node --experimental-strip-types scripts/packages/outbox-disposable-postgres.ts --manifest <manifest-path> --expected-commit <full-sha>`. It owns a fresh pinned PostgreSQL 17 container, loopback port, database and cleanup; it refuses invalid artifacts before starting the service. The CI form receives the exact pinned container ID and mapped port from the explicit CI startup step, creates only this proof's UUID-named database and drops it afterward, including when the CREATE response is lost. The manual proof above retains its fixed disposable database name; the owned route uses `openlup_outbox_proof_<32 lowercase UUID hex digits>`. Neither form adopts an ambient service. Before creating a local container, the owner resolves the CI image inventory's exact PostgreSQL pin through the shared mirror-first pull helper, verifies its RepoDigest and starts the returned local reference with `--pull=never`. Containers supplied by that step retain the exact container ID, running state and mapped-port checks; only the canonical or configured pinned image references with a matching local RepoDigest are accepted. Image acquisition responds to cancellation before container creation. Local cleanup can recover the container by its known unique name if its creation response is lost, and requires the actual name, ID and owner label before removal. Startup is bounded at 30 seconds, packed child work at 180 seconds, and each Docker operation at 30 seconds; interruptions terminate the child process group before owned cleanup. Repeated signals forwarded by npm or the package wrapper remain handled until cleanup finishes. The actual proof owner also shields its bounded cleanup inspect, container removal and database DROP commands from verifier group signals. The owner stays in that group until those commands finish; their existing 30-second limits and all ownership checks remain. Local containers use one CPU and 512 MiB of memory. These are proof bounds, not package runtime settings.

Before SQL, the Outbox binding supplies its actual installed schema/probe/checker exports and reference input to the common repository test utility `scripts/packages/schema-budget-proof.mjs`. Future modules can reuse that utility with their own installed requirement and input callback; it carries no package registry or duplicate schema inventory. Its positive serial model uses 250 ms setup plus 100 ms per presence operation, so actual schema growth participates automatically. A single operation longer than the unchanged 3000 ms waiting deadline proves timeout refusal even if the adapter later batches reads. Completeness and overload cases follow the supplied schema's capabilities. Timer cleanup does not imply cancellation of pending driver work; the proof settles its owned fake queue before restoring real timers. The same real database then demonstrates absent table, column and function-overload observations. A single replay witness accepts a synthetic durable effect, loses acknowledgement, reclaims the same event through scheduled work after immediate work, refuses the formerly valid token and acknowledges the new claim. Multiple attempts with one application-owned deduped effect demonstrate at-least-once recovery for this synthetic example, not provider recovery or a universal exactly-once contract.

The same installed Core tarball also executes the additive grouped readiness
catalog query in [the neutral grouped proof](https://github.com/openlup/openlup/blob/main/packages/outbox/smoke/groupedSchemaProof.ts).
Within a host-owned read-only repeatable-read transaction it compares grouped
presence with every scalar probe, including the existing Outbox requirement,
exact overloads, absent objects, dropped/system columns, views and sequences,
quoted relation names, duplicate ordinals and an empty request. Independent
catalog reads verify constraints, indexes, noninternal triggers, policies and
function definitions. Fresh tables/partitions, identity/generated/default
columns, RLS, ACL and function configuration/security/volatility exercise rich
and empty shapes. The proof requires jsonb text rows, definition-string arrays,
null empty aggregates, raw policy OIDs/command codes/booleans and exact parsed
jsonb property/nested ordering. Parsed driver objects are refused.
Invalid catalog resolution still propagates to the host. This reuses the existing
pinned PostgreSQL service, artifact checks and cleanup; it adds no gate or host
admission policy and does not prove effective authorization or SQL behavior.

The root companion tests prepare that verified local image in a separate 330-second hook before their interruption and lost-response deadlines begin. Their fixture containers use `--pull=never`, so those scenarios do not depend on a registry request. The tests also refuse an untrusted service image reference or wrong RepoDigest before SQL, leaving the supplied service running. The root companion tests retain real interruption and lost-response fixtures. Their owned JSON witness markers are written completely to a same-directory temporary file and then renamed into place, so readers never treat a newly created, partially written file as a ready observation. A plain Node process owns each fixture's service and launcher and stays in the root test process group until teardown finishes, even when Vitest's worker exits. Only the bounded Docker cleanup commands detach; their process-start window can still receive a group TERM. The companion fixture allows one recovery only for a child terminated by SIGTERM with no reported error, inside the original 10-second inspect or removal deadline. An interrupted removal is followed by actual Docker inspection: normal no-such-object refusal confirms absence, otherwise the same full ID, name and UUID label must still match before one removal retry. The recovery never resets its deadline, treats a signal as absence, or masks a timeout, nonzero result, wrong owner or second interruption. Cleanup recovers by the known unique name after a lost creation response. Root cancellation regressions interrupt actual Vitest workers after service creation and after detached proof readiness, and check resource termination before releasing their own test lock. They create no verification stamp or shared verifier lock. Separate teardown regressions cancel the actual npm/launcher route during each cleanup operation and assert that its container or UUID database is removed while an unrelated supplied-service database remains.

The standalone-driver fixtures run builtin-only proof stubs or stop before the
packed consumer starts, so they need no Zod directory copy. Artifact-set and
digest refusals remain in [the manifest-input tests](https://github.com/openlup/openlup/blob/main/scripts/packages/pack-manifest-input.test.ts);
installed missing-export refusal remains in [the required-package-gate tests](https://github.com/openlup/openlup/blob/main/scripts/packages/required-package-gates.test.ts).
The required cold package gate executes the actual installed reference proof,
including the replay and token-fencing witness above. The root companion tests
focus on cancellation, ownership and bounded cleanup without repeating that
consumer proof against planted artifact or replay faults.

The root group-liveness fixture keeps polling after a signal-zero `EPERM`, which
can occur for zombie-only groups on Darwin. Only `ESRCH` establishes group
absence; the original cancellation deadline still applies.

Upgrade the complete `@openlup/*` set together after reading each changelog. Use ports and composition; do not edit or patch installed package bytes. Sources are in `src/`, built JavaScript/declarations in `dist/`. Synthetic packed-consumer proof is first-party package evidence, not an independent adopter, provider-delivery or deployment certificate.

## Adoption and native extensions

Follow [extension seams](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/how-to/extend/choose-an-extension-seam.md)
and [upgrades](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/upgrade/README.md). The installed
[agent guide](AGENTS.md#using-this-package-in-an-application) retains the dependent
hold and compatible recovery rules.

## Package artifact limits

The monorepo's package artifact checker enforces this package's
`release-gates.json` caps and packed content allowlist. Only
`--release-set <version>` checks compressed growth against the last released
baseline, with explanations in the new set's changelog section and release body. See the
[package artifact policy](https://github.com/openlup/openlup/blob/main/.github/VERSIONING_AND_EOL.md#package-artifact-limits)
for measured sizes, current caps, the S1 baseline refresh and refusal remedies.
Artifact checks require a clean package directory; `--manifest-only` supplies no
artifact evidence.

## Release notes

Read [the changelog](CHANGELOG.md#0390) before upgrading the package set.
