# M14 B — existing-store transfer and recovery

Status: development-preview task record. The bounded B primitives landed in
[PR #400](https://github.com/openlup/openlup/pull/400). The separate connected-native
candidate below is still a source followup; M14/D32 remains incomplete.

## Approved task and authority

The finite programme outcome is retained managed → portable → portable store
transfer, interruption/catch-up/resume, identities, objects/history, active
subscriptions/frozen terms, unsettled money, duties/outbox/replay/provider
ledgers, enforced ownership handover and measured recovery. Executor isolation
must not pause subscription state. B's first delivered slice proves only bounded
capabilities within that outcome.

The continuing human M14 C2 grant covers implementation, owned synthetic proof,
DCO, independent native review, PR/receipt, required source/group checks and
queue merge. Master M14 coordinates shared dependencies; the assigned transfer
session now leads its finite continuation. This grants no secrets, signed-in
browser, live-store/provisioning/provider activation, settings, deployment,
production or release dispatch. Follow [contribution and delivery rules](../../../CONTRIBUTING.md#deliver-a-change),
[instruction freshness](../../../CONTRIBUTING.md#instruction-freshness-and-handoffs)
and [native review](../../../CONTRIBUTING.md#native-review-and-accountability).

The [programme record](oss-m14-operations-portability.md) owns the thirteen merged
M14 PRs through source `53534905`, published `0.30.0`, later followups and remaining D32.
Published package assets and later source catalogue qualification are distinct.
Legacy 88-unit history remains issued; qualified E89, restore F90 and source91
retain their own selected plans, binding shapes and inventory expectations. All
six approval pins, issued SQL and actual R/S restrictions remain governed by the
[migration owner](../DATA_AND_MIGRATIONS.md#module-catalogues-and-installed-histories).
No new SQL, grant, API or budget change follows from this task record.

## Smallest sufficient scope and proof

Use canonical target migrations and explicit compatible-data mapping, never a
managed schema or migration-ledger restore. Server object byte/version/metadata/
access transfer is separate from the browser storage port. Source isolation,
target freshness and all-writer/DDL exclusion must be observed by the actual
host; callbacks, inventory labels and snapshot hashes do not establish them.

An old worker paused before a provider request may retain a usable cached bearer
after its database is cloned. Prefer provider/deployment-enforced revocation and
drain; if old requests cannot be excluded, refuse effect activation while
preserving service, subscriptions and duties. A check-then-dispatch callback
cannot close that pause gap. Reconcile accepted-before-ACK and late observations
without inventing provider exactly-once or successful delivery.

### First bounded candidate (source frozen 2026-10-26)

The delivered Node-only [`@openlup/platform/portability`](../../../packages/platform/src/portability/index.ts)
entry provides three finite capabilities:

- Object copy requires an explicitly complete immutable/quiesced inventory,
  exact versions, byte hashes, metadata and explicit access mapping. Readback
  precedes checkpoint; lost write ACK and interrupted-copy replay recognize
  exact retained bytes and refuse divergence.
- Private filesystem publication uses exclusive writes, fsync and directory
  rename. Owner-controlled 0700/0600 single-link files are required; unsafe modes,
  symlinks/hardlinks or unsupported access labels refuse. One shared 262,144-byte
  encoded-descriptor ceiling and JSON-string key hashing preserve admitted
  Unicode metadata and UTF-16 key identity. This certifies no remote ACL.
- Compatible PostgreSQL rows use one read-only repeatable-read snapshot and an
  atomic target transaction. Columns/types/primary keys and table locks precede
  writes. The generic transport refuses **every** enabled user INSERT trigger,
  with no name exception, disabling or replication-role change. Raw PostgreSQL
  JSON text preserves bigint/timestamp precision; exact replay leaves tuples
  unchanged, and differing/unique-key rows roll back the whole packet.

Parents remain explicit prerequisites. There is no generic upsert/deletion scan,
identity relinking, ledger copy, environment bootstrap or target activation.
The [architecture owner](../ARCHITECTURE_AND_EXTENSIONS.md#existing-store-transfer-and-recovery)
and [data owner](../DATA_AND_MIGRATIONS.md#compatible-data-transfer) retain those
contracts. The actual HTTP-client witness proves cached-token refusal and
accepted-before-ACK/late readback only against its owned synthetic provider.

## Evidence and current blockers

| Delivered or prepared source | Actual evidence and limits |
| --- | --- |
| B, [#400](https://github.com/openlup/openlup/pull/400), head `f6f0b15c3422dd8e16aea7965b180fc584eb159c`, merge `a03d920eec32bfb3d0de90b9a12535cc57f88d53` | Two fresh FULL reviews closed the representation findings; full `verify-local.mjs --pgtap` passed 14 phases, 21,984 root cases and 226 pgTAP files/5,199 assertions. Cold/installed package, API, actual PG, neutrality and DCO proof belongs to that exact source. |
| Connected-native prior candidate | Two owned native91 installations completed one connected witness; FS/S3 44 cases, lint, five type projects, three APIs and current packs passed on that prior source. Administrative restore used M-super, not an S-session or managed/no-super profile. |
| Connected-native current correction | After the reviewed runtime/control-witness dependency integration, both PG cases and 44 filesystem/S3 cases passed, including manifest identity, trigger tamper, pre-existing obligation refusal and pruned/retained history. Lint/types/APIs/current cumulative pack/browser checks passed. These are working results; new committed-candidate FULL reviews and final verification remain due. |
| H1/H2 host/effect continuation | Source wiring remains unintegrated/unexecuted; it is not delivered all-writer fencing, hosted recovery or measured whole-service RPO/RTO. |

Historical failed attempts and consumed limits remain material:

- B's five-minute install wait ended with broker exit 74 before installation.
  Later admission followed changed measured pressure. Loopback EPERM required
  the approved scoped boundary; a failed listen stayed the primary error.
- `B0-S1` exposed unreadable admitted Unicode descriptors; the shared descriptor
  ceiling repaired it. `B1-I1` exposed lone-surrogate/U+FFFD key aliasing; JSON
  string hashing repaired it after the required regroup. Those repairs used
  cycles one and two of the same three-cycle history; #400 closed the cards.
- The measured B code-gzip approvals were exactly
  1,648,000 → 1,650,493 → 1,650,621 → 1,650,631 bytes, with zero forecast headroom.
  They granted no other cap or future-module allowance. Current package gates
  and their owner reads still bind; historical measurements are not new proof.
- Original committed cold/Docker-metadata and full-run failures remain failures.
  The unchanged cold rerun followed an explicitly authorized host restart; the
  complete passing full run used the pinned CLI and unchanged gate budgets.
- The first connected F90 attempt failed source-R media confirmation with 42501
  before its main restore case. Source91 later reached that case. The original
  failure remains attributed; later working PASS never rewrites that failed attempt.

Native evidence expires 24 hours after the earliest counted PASS for its actual
candidate. Reviewer exclusions, findings, repair counts and owner continuations
carry through the same append-only history; a source/intent/session change does
not reset them. The current connected task retains its earlier cycle-zero
history; material repair needs new committed-candidate review under that history.

The [immutable pre-compaction record](https://github.com/openlup/openlup/blob/535349050419abe5122bd74fa6766c58947be3dd/docs/platform/plans/oss-m14-existing-store-transfer.md)
retains exact earlier predecessor/tree/packet/budget identities, measurements,
author roles and failed attempts. Its intermediate waits, open-card and
uncommitted-status paragraphs are historical; [#400](https://github.com/openlup/openlup/pull/400)
records the delivered B outcome. It grants no fresh expiry, retry or authority.

### Connected-native candidate: explicit trigger boundary (2026-10-28)

The separate root-host [connected restore](../../../server/adapters/postgres/connectedStoreRestore.ts)
previously admitted named triggers and compensated one generated outbox row
without recording that extension here. This owner decision admits that finite
native route explicitly. The generic B transport above continues to refuse
**every** enabled user INSERT trigger; its API and admission remain unchanged.

Connected restore requires the complete selected qualified catalogue, including
function bodies, trigger definitions/enabled states, constraints, roles and
permissions. It compares the actual ledger's full path/hash/position sequence
with the selected manifest, including its length and tail. Catalogue inspection
follows target table locks and precedes retained-data writes. A trigger name
alone is insufficient: a changed selected-catalogue payload or unknown INSERT
trigger refuses before import. The finite admitted set is:

| Table | Enabled INSERT triggers |
| --- | --- |
| `clients` | `customer_subject_capture_lifecycle_trigger` through existing F13 import |
| `subscription_cycles` | `trg_subscription_delivery_alignment_guard_cycle_insert` through existing F8 import |
| `commerce_orders` | `trg_commerce_orders_line_sum` |
| `commerce_order_items` | `trg_commerce_order_items_line_sum` |
| `commerce_order_holds` | `trg_fulfillment_emit_shipment_exception`, `trg_subscription_delivery_alignment_exception_case` |
| `fulfillment_shipments` | `trg_subscription_delivery_alignment_on_delivery` |

The exact current definitions and import ordering matter. Alignment control
must be pristine/off until retained rows and cases are restored; source policy
is restored last. Deferred order totals remain active. No trigger is disabled,
no replication role is changed, and no grant is added by the adapter.

One compensation is permitted inside the same owner transaction: remove only
a `commerce.shipment.exception` notification newly generated by replaying an
active historical fulfillment-exception hold whose deterministic notification
was absent from the source. The source key census must exclude it. Its hold,
aggregate, payload, metadata, pending/default processing fields, transaction
creation/availability times and current-transaction `xmin` must all match.
Deletion rechecks the exact observed row, ID and transaction identity. A retained
source notification, pre-existing target obligation or divergent row is never
eligible. If an observed row fails these checks, or any other row delta remains,
restore refuses/rolls back; an absent generated row needs no compensation. There
is no arbitrary outbox cleanup or inference that an external obligation completed.

Before commit, all 73 retained tables must equal the captured source exactly,
the qualified catalogue and target migration ledger must remain unchanged, and
the target installation-key tuple identity must be preserved without reading its
payload. The host must actually exclude all source/target writers and DDL, retain
the migration lock and transaction, and keep the target inactive through both
DB and filesystem publication. This remains an administrative M-super native
profile, with no managed, no-super, all-writer or full-store qualification claim.

This choice keeps the existing fixed native adapter and its transaction/readback
checks. The alternative is a new durable domain SQL/import API, permissions,
qualified control and inventory for the additional domain tables. Avoiding that
cost does not establish that a trigger is harmless. New known-name body tamper,
unknown-trigger refusal, retained/pre-existing obligation preservation and
pruned-history compensation need working proof, followed by two fresh FULL
reviews and final verification in the same task history. Earlier candidate PASS
reports cover their own source only.

### Remaining obligations and limits

D32 still requires:

- Complete managed identity/history/privacy mapping with explicit subject
  bindings, redaction/erasure preservation and a decision on private keyed
  replay/dedupe continuity; no email inference or secret-key transfer.
- Connected managed → portable → portable data/object catch-up, including updates
  and deletions; actual authenticated source traversal, effective storage/domain
  access and compatible retained business history. The fixed native73 graph and
  current S3 protocol do not establish this complete source profile.
- Actual all-writer/DDL retirement, DB/object/effect recovery and old-executor
  exclusion, accepted/uncertain-effect reconciliation, safe activation and measured
  installation-specific RPO/RTO across restored domain databases.
- The current native candidate's two fresh FULL reviews and required final
  verification before authorized delivery; working proof does not substitute. The separate restricted
  installer/bootstrap and adopter C6 remainder retain their own owners/gates.

Changed existing rows deliberately refuse in generic B. A new complete object
snapshot is not a generic live delta protocol. No primitive, adapter or source
record establishes whole M14 completion or activates a source, target or provider.

## Handoff and self-retro

Continue only the finite approved dependency/working/review/delivery route, with
actual history and current evidence. The bounded correction now records the
separate connected trigger decision; it does not relax generic B or claim a
harmless trigger. Long chronology is preserved in immutable Git rather than
repeated as current instructions. Lesson: compare a new adapter's accepted
criteria with its canonical owner before signing; representation and refusal
witnesses must exercise the actual read/replay boundary. No successor or new
process registry is created by this compaction.
