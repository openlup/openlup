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
