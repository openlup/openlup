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

<!-- openlup-doc-impact {"unit":"outbox-rail","digest":"sha256-3f759fc267ff16991d7b0ef205c06a257655d54a0bd359e3436ab95c6614fc95","reason":"Release preparation changes the outbox manifest version and exact core peer pin to 0.13.0. The reference admission test uses the existing installed-package observer instead of hard-coded 0.12.0 fixtures and also verifies refusal for either mismatched package. Exports, runtime implementation, shipped SQL, readiness composition, publishing configuration and package gates remain unchanged; the changelog identifies the prepared set and retains its migration guidance."} -->

Compose the contribution with `@openlup/core/readiness`, actual loaded package metadata, selected-adapter schema observations and host bindings to the exact contribution run/handle functions before activating the exact new candidate. Only `ready` admits; `unknown` and `unsatisfied` leave the serving version running. Descriptors are inert; the builder supplies the same actual event identities and effective timeouts after lease acquisition. The default schema declaration describes catalog existence and overloads; it does not prove bodies, ACL or recovery. Use framework-free fence conformance from `./testing` and real transactional proof for your adapter. No ambient database URL is used by the packed proof.

Upgrade the complete `@openlup/*` set together after reading each changelog. Use ports and composition; do not edit or patch installed package bytes. Sources are in `src/`, built JavaScript/declarations in `dist/`. Synthetic packed-consumer proof is first-party package evidence, not an independent adopter, provider-delivery or deployment certificate.
