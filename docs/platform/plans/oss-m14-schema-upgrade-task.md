# M14 D32: schema upgrade and backfill proof

Status: stabilized working candidate; NEEDS_READ before DCO. Release 0.23.0
supplies the nearest applicable real backfill. M14 remains open.

## Outcome, scope and authority

Prove a real released-predecessor-to-current schema upgrade containing an actual
data backfill, using PostgreSQL 16 and the current qualified profile (legacy
where applicable). Retain representative data; interrupt the canonical runner
between units and inside a long unit; resume/replay with an exact ledger prefix;
check backfilled data and business invariants, including a late delivery
extending the next subscription cycle once and never earlier. Exercise previous
application code against the upgraded schema only within promised compatibility.
Preserve the separate application-file upgrade proof in #408.

The active supervisor is the single writer. The M14 programme coordinator owns
coordination. The owner's 28 October grant covers local work, commits, push, PR
delivery and merge after all gates pass. DCO identity is Bart Roszkowski
<dev@openlup.com>. Release dispatch, publication, secrets/account access, settings,
deployment and production are not granted. API, security-control or
migration-control changes require a stabilized maintainer-read packet before DCO.
Independent fresh-context review and current verification remain mandatory for
delivery; the public guide itself grants no external authority.

Excluded: restricted-bootstrap qualification, hosted endpoints, transfer,
release, database rollback, invented migrations and repeating #408. CD-M14-17
corrects the earlier wording: scan published releases newest first and select
the nearest released predecessor with a real backfill on an applicable chain.
The existing issued legacy chain is preferred; a released qualified chain must
not be inferred for an older set that did not ship one. If none qualifies,
stop with NEEDS_OWNER.

## Acceptance and execution

First identify actual published set/tag identities, exact migration manifests,
forward SQL and compatibility promises. Establish whether a real backfill exists
in that range before running a database or changing implementation. If it does,
reuse existing runner, connection recipe and retained-data fixtures; freeze
inputs, serialize heavy proof, capture interruption/atomicity and exact replay,
then check business invariants and compatible code rollback. Run cheap policy,
inventory, structural and secret checks before broader required gates. Record
actual evidence and limits; no same-schema witness substitutes for this outcome.

Initial code base and policy pin: `2688f517c7df40a2e8d2d4a3741ef642555a68f9`.
Main then changed the same contributor and data-owner files. The unreviewed
candidate integrated that actual overlap; current code base and fresh policy
pin are `6869465b306cdfa4efe46782d3dc85528ed19815`. The active manifest
and released predecessor selection did not change.
Native review has not started; no repair cycles consumed and no passing receipt
or verification stamp exists.

## Evidence and remaining work

The public npm registry reported all three packages at `0.30.0`; GitHub release
readback agreed. Main prepares `0.31.0` but that is not a published predecessor.
The released `openlup-platform-v0.30.0` tag peels to
`fea0854a1a5a27c1a48f8c2c9078c618f47f66a3`.
Its migration-manifest SHA-256 is
`b8073ba16df4b81a1514171ca00fc91c99edb45e6b6f341a253cc880d753e0ed`;
current main's is
`60e558fba87b1b863d28649c01536c99d0b187ad821f83caf59b133b4afba43f`.

Exact manifest comparison proves the legacy baseline, 87 forwards and inventory
unchanged (88 units total). Qualified baseline and all 89 released forwards are
an exact prefix; current main adds only these two units (90 to 92 total):

- `q2_20261028100000_runtime_capability_completion.sql`, SHA-256
  `ec05d0e86a570724fad21916a6fd06976a5e32ae0d0323b1ff902f69c2ae189e`:
  validates the role/owner binding and grants existing runtime capabilities.
- `q2_20261029100000_owner_path_name_resolution.sql`, SHA-256
  `33b0bc85b0c0fe55b2beb08fb121e4fdc891f14f9e1ab276563ffa72a88bb7d3`:
  replaces nine function definitions with pinned name resolution. Its DML is
  inside function bodies; applying the unit does not execute that business DML.

Complete SQL inspection finds no retained-data backfill in either addition.
The managed migration directory is also unchanged. The retained-client/cycle
import unit already exists in the released qualified prefix, and exposes import
functions rather than executing a predecessor-to-current backfill. Older business
backfills cannot be counted again as new work in this selected range.
The current runner's ledger admission/transaction fixes and merged connection
recipe remain the canonical implementation; neither creates a missing backfill.

CD-M14-17 authorizes the nearest eligible older released predecessor. Registry
versions 0.30 through 0.15 have matching platform tags. The scan found no new
legacy units in 0.30, 0.29 or 0.28; releases 0.27 through 0.25 add only the
support-authority function unit; 0.24 adds six more schema/function units but
no top-level retained-data backfill. The nearest qualifying tag is
`openlup-platform-v0.23.0`, peeled commit
`d430754f63e494ab3de3e625b860a210e44e78dc`. Its 77-unit legacy baseline
and forward list are an exact prefix of current main's 88-unit legacy list.
The first added unit with a data transformation is
`20261022190000_invoicing_durable_duties.sql`: top-level `INSERT INTO
public.invoicing_cutover ... SELECT` copies every existing settlement-transition
and shipment-operation identity into a new cutover table. Those rows prevent
historic source events from becoming new invoicing duties. This is a retained
row transformation at migration apply time, rather than a function body or
static configuration seed. It is already present in release 0.24.0, establishing
0.23.0 as the nearest predecessor for this backfill. Release 0.23.0 shipped no
qualified manifest, and legacy ledger relabeling as qualified is prohibited;
the applicable upgrade route is legacy 77→88, not qualified 0.23→92. Current
qualified installation remains separately qualified by its own existing tests.

The previous stop recorded a too-narrow predecessor interpretation. That
history and its zero review cycles remain; the current owner decision supersedes
the stop without resetting any evidence. `npm ci`, structural scan and tracked
publication-policy check passed before this continuation. No native review,
DCO, PR, receipt, queue or release action has occurred yet.

The selected 0.23.0 manifest SHA-256 is
`abaad6e8b68bcb071ad6c2911c47c580feaa122da5c7f9eb287ca3a15da03bad`.
The integrated-tree focused PostgreSQL 16 witness passed (one test, 4.09 seconds): the
canonical runner installed all 77 released legacy units, then retained a
settlement, shipment operation, order and subscription. A child blocked inside
the first actual backfill transaction died by SIGKILL; the ledger remained the
exact 77-row prefix and `invoicing_cutover` did not survive. A second child
committed that unit, parked before the next `BEGIN` and died by SIGKILL; the
ledger was the exact 78-row prefix with all original source identities in the
cutover table. Resume applied the remaining ten units to 88 and replay applied
zero. Every ledger path, hash and position matched the current manifest.
Original rows survived; a late arrival extended one cycle once, replay did not
stack it, and an earlier arrival did not move another cycle earlier.

The optional local run bound the published `@openlup/platform@0.23.0` payment
adapter, registry integrity
`sha512-YoVSnWwQws1DVLDFsfuslRPmk/fKt6tGkj6uMwYSHVwG8tOjBDNKSU8PzV4lg7akep3EOBWK3xiKJm2AG3C/tA==`.
That previous code, under a separate nonowner NOSUPERUSER/NOBYPASSRLS login
with explicit disposable grants, read and idempotently replayed the retained
payment event on the upgraded schema; one durable row remained. The offline
test path does not claim this optional package observation. Code rollback does
not restore the old schema or backfill state. Qualified-v2 fresh installation
remains separately qualified; no older qualified upgrade is claimed.

Working-tree publication policy, inventory, ast-grep, lint (0 errors, 33
existing warnings), five-project typecheck and redacted Gitleaks directory
scan passed. Initial focused fixture execution found an already-paid order;
a separate open order fixed that setup. Four TypeScript literal-type errors
were corrected without a runtime behavior change. Native review remains 0/3,
with no DCO, PR, receipt, queue or full committed-candidate stamp. The
registered child execution surface and migration proof require the stabilized
maintainer read before DCO under the task's inherited authority.

Self-retro: checking issued lineage and top-level SQL found the nearest real
backfill before PostgreSQL work. The existing runner and fixtures kept the
proof bounded; the two working failures needed fixture and type corrections,
not another migration mechanism.
