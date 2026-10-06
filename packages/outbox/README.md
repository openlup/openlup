# @openlup/outbox

Development preview, kind `rail`. One at-least-once dispatch engine, lease-bound dispatch and terminal-compaction schedules, registry composition, transactional enqueue and a driver-free PostgreSQL default. No stable API or universal exactly-once guarantee is claimed.

The publication catalogue admits this complete rail to the release set. Catalogue admission does not publish it: direct directory publishing still refuses, and the reviewed release workflow owns provenance-backed publication. New API and shipped SQL require the next minor set.

## Package Surface Maturity

| Export | Role | Maturity |
| --- | --- | --- |
| `.` | rail | experimental |
| `./postgres` | rail | experimental |
| `./testing` | testing | testing |

The application supplies its driver, committed-operation executor, lease adapter, effect handlers, explicit ordered known event vocabulary and host trigger bindings. `createOutbox` validates effective composed timeouts before construction and matches the run-built registry before the first claim. The lease must cover the full declared host execution window, including finish time; the factory has no renewal loop. Build after the lease; a builder owns partially acquired resources until it returns a scope. A returned scope closes after finish, including failure. Hook metadata cannot replace reserved run identity or worker counters. A resolved negative business observation is nonfatal; a thrown business hook prevents claims and attempts a failed finish once. A failed finish remains observable; cleanup errors do not turn accepted effects into retries.

The bare `runOutboxDispatchWorker` supports immediate dispatch without a job lease. The registry alone supplies its claim allowlist. `knownEventTypes` is explicit and is never derived from enabled handlers. A composed handler replays its first component when the second retries, sums timeouts, and retains the original nested details and top-level delivery observations. Its components deliberately do not receive the transient execution context. Effects must honor abort and enforce their own idempotency; timeout cannot cancel a request already accepted by a provider.

## PostgreSQL installation and transactions

Apply [the baseline](sql/0001_outbox.sql) through your own migration chain on a fresh PostgreSQL database. [The manifest](sql/manifest.json) binds its bytes to their public migration owner. PostgreSQL 16 or later supplies the validated timestamp parser used by compaction. Importing the package never applies SQL. Existing managed schemas need their own compatibility assessment; do not apply the fresh-install baseline over them. The default does not supply provider recovery, RLS or role grants.

`buildOutboxEnqueue` returns bound SQL for the producer's transaction. Execute the domain write and enqueue on the same transaction client; commit or roll back both. Duplicate `(event_type,idempotency_key)` enqueue creates no second row. The dispatch executor must commit each claim/ack/failure/release operation before its promise resolves, with no transaction held across handler I/O. A type-compatible executor alone does not prove this property. Compaction likewise commits per operation.

Claims retain six timestamp digits, per-aggregate ordering, exact dormant identities and claim-token fences. An unknown non-dormant predecessor blocks its aggregate; a known but currently unclaimed type may be bypassed. Snooze and release refund attempts. Storage errors remain exceptions; unstarted claims from an interrupted batch expire rather than being falsely settled.

Prune defaults to 30 days for processed and 90 for discarded, in batches of 500. It empties terminal payload/error and stamps `retentionCompactedAt`, `retentionCompactedBy` and `retentionCompactedStatus`; rows and unique dedupe keys survive. Missing/malformed discard timestamps are ineligible. Pending, failed and processing work remains untouched. Application delivery/ledger adjunct retention remains application-owned.

## Readiness and verification

<!-- openlup-doc-impact {"unit":"outbox-rail","digest":"sha256-6bc205f704ca152c57fdd23d0be222509e20f7906ebb973a0cdced8e8b5114c4","reason":"The outbox manifest version and exact core peer pin move together from 0.13.0 to 0.13.1. API snapshots, runtime behavior, shipped SQL, composition seams and package gates are unchanged; the patch repairs publication without changing application migration or readiness responsibilities."} -->

Compose the contribution with `@openlup/core/readiness`, actual loaded package metadata, selected-adapter schema observations and host bindings to the exact contribution run/handle functions before activating the exact new candidate. Only `ready` admits; `unknown` and `unsatisfied` leave the serving version running. Descriptors are inert; the builder supplies the same actual event identities and effective timeouts after lease acquisition. The default schema declaration describes catalog existence and overloads; it does not prove bodies, ACL or recovery. Use framework-free fence conformance from `./testing` and real transactional proof for your adapter. No ambient database URL is used by the packed proof.

From an OpenLup task checkout, the existing packed proof accepts an explicit disposable loopback PostgreSQL database and a verified cold-set manifest:

```sh
node --experimental-strip-types scripts/packages/outbox-consumer-proof.ts \
  postgresql://postgres@127.0.0.1:5432/openlup_outbox_proof \
  .context/scratch/outbox-packed-proof \
  --manifest "$OPENLUP_PACK_MANIFEST" --expected-commit "$OPENLUP_PACK_COMMIT"
```

Supply both manifest inputs together. The runner verifies the exact publishable inventory, versions, commit and tarball digests before installation; missing or damaged input refuses without repacking. It installs only Core and Outbox, the packages imported by this reference composition; unrelated modules have their own consumers. It installs outside checkout ancestry with scripts disabled, records consumed artifacts and installed identities in task scratch, injects only the host PostgreSQL test driver and compiles the actual reference composition. Omitting both inputs retains manual packing of already-built packages. The caller owns the disposable database; the proof closes its pools and removes its temporary consumer on success or failure. Required CI and its local runner provide an owned PostgreSQL 17 instance and an enclosing deadline.

For the local required route, run `node --experimental-strip-types scripts/packages/outbox-disposable-postgres.ts --manifest <manifest-path> --expected-commit <full-sha>`. It owns a fresh pinned PostgreSQL 17 container, loopback port, database and cleanup; it refuses invalid artifacts before starting the service. The CI form receives the exact pinned job service container ID and mapped port, creates only this proof's UUID-named database and drops it afterward, including when the CREATE response is lost. The manual proof above retains its fixed disposable database name; the owned route uses `openlup_outbox_proof_<32 lowercase UUID hex digits>`. Neither form adopts an ambient service. Local cleanup can recover the container by its known unique name if its creation response is lost, and requires the actual name, ID and owner label before removal. Startup is bounded at 30 seconds, packed child work at 180 seconds, and each Docker operation at 30 seconds; interruptions terminate the child process group before owned cleanup. Repeated signals forwarded by npm or the package wrapper remain handled until cleanup finishes. The actual proof owner also shields its bounded cleanup inspect, container removal and database DROP commands from verifier group signals. The owner stays in that group until those commands finish; their existing 30-second limits and all ownership checks remain. Local containers use one CPU and 512 MiB of memory. These are proof bounds, not package runtime settings.

Before SQL, the Outbox binding supplies its actual installed schema/probe/checker exports and reference input to the common repository test utility `scripts/packages/schema-budget-proof.mjs`. Future modules can reuse that utility with their own installed requirement and input callback; it carries no package registry or duplicate schema inventory. Its positive serial model uses 250 ms setup plus 100 ms per presence operation, so actual schema growth participates automatically. A single operation longer than the unchanged 3000 ms waiting deadline proves timeout refusal even if the adapter later batches reads. Completeness and overload cases follow the supplied schema's capabilities. Timer cleanup does not imply cancellation of pending driver work; the proof settles its owned fake queue before restoring real timers. The same real database then demonstrates absent table, column and function-overload observations. A single replay witness accepts a synthetic durable effect, loses acknowledgement, reclaims the same event through scheduled work after immediate work, refuses the formerly valid token and acknowledges the new claim. Multiple attempts with one application-owned deduped effect demonstrate at-least-once recovery for this synthetic example, not provider recovery or a universal exactly-once contract.

The root companion tests retain real interruption and lost-response fixtures. A plain Node process owns each fixture's service and launcher and stays in the root test process group until teardown finishes, even when Vitest's worker exits. Only bounded Docker cleanup commands leave that group, so repeated TERM cannot interrupt their response; each has a 10-second limit. Cleanup checks the known name, full container ID and UUID label, and recovers by name after a lost creation response. Root cancellation regressions interrupt actual Vitest workers after service creation and after detached proof readiness, and check resource termination before releasing their own test lock. They create no verification stamp or shared verifier lock. Separate teardown regressions cancel the actual npm/launcher route during each cleanup operation and assert that its container or UUID database is removed while an unrelated supplied-service database remains.

Upgrade the complete `@openlup/*` set together after reading each changelog. Use ports and composition; do not edit or patch installed package bytes. Sources are in `src/`, built JavaScript/declarations in `dist/`. Synthetic packed-consumer proof is first-party package evidence, not an independent adopter, provider-delivery or deployment certificate.

## Adoption and native extensions

One npm package owns the dispatch algorithm. Application drivers, handlers,
policies, host bindings and compatible native stores remain editable through
public seams without a nomination or per-function ownership record. Do not
autonomously fork, vendor, monkey-patch, shadow or restore a copied engine; use
only the installed package's declared exports. A missing seam follows the
[agent guide's dependent hold and compatible recovery route](AGENTS.md#using-this-package-in-an-application).

At first adoption compare the actual selected artifact with current consumer
behavior, including producer payload/schema and composition changes outside the
extracted engine. On upgrades, preserve pending obligations, transactional enqueue,
claim/ack/fencing and native recovery. Compatible native schema additions remain
permitted; published SQL stays immutable. Validate the actual adapter and serving
binding. For full or partial absorption remove only proven duplicate behavior,
retain distinct effects sharing an event, and demonstrate durable success and
unfinished work across retries and replacement. Catalogue existence, a handler
return or an upstream merge alone cannot establish that proof.

The public [adopter recipe](https://github.com/openlup/openlup/blob/main/docs/platform/adopter-kit/README.md#adopt-or-upgrade-a-package)
explains source-local nominations and full/partial/retained/hold dispositions.
Select that optional source guidance at a deliberate revision against your
installed contract. This package guide conveys version-bound contract information,
not tool permissions, an automatic control installation or external-write authority.
The existing wiring and packed protocol examples remain narrow package evidence;
a complete extension/absorption/retry witness belongs to the actual module adoption.
