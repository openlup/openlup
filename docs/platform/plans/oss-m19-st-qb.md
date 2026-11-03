# PostgreSQL quote catalog read adapter

Status: focused local proof complete; stabilized API decision pending.

## Outcome and scope

Add `createPostgresCommerceQuoteCatalogReadPort(executor, options)` to the
existing `@openlup/platform/catalog` entry. Implement the existing quote catalog
port using strict SKU envelopes, guarded current-document payload reads and a
required host document verifier. Values remain database configuration.

This is an independent package leaf. Later starter composition may stack on
it. This run prepares a reviewable local candidate and API decision packet;
it does not sign off a commit, submit, push, review, verify canonically, merge
or release. The implementation worker owns this worktree's adapter, tests,
additive entry/API inventory and related documentation changes.

## Exclusions and limits

No SQL asset, grant, export subpath, starter composition, price authority
or promotion reader changes. The sole control exception is the pinned opaque
payload handoff in the catalog document boundary scanner and its contribution
guidance. Existing strict envelope readers remain unchanged.
Current-direct row consistency does not establish a publication-wide snapshot
or a publication-head protocol. Document schema admission, semantic identity
and canonical digest verification remain required host policy. No fallback,
global cache or application schema is introduced.

## Acceptance and sufficient evidence

- Read active SKUs sellable in at least one mode, validate current provenance
  before excluding inactive products, and preserve primary/addon/physical facts.
- Scan deterministic keyset pages of 100 with a positive safe integer ceiling
  (default 500); exactly the ceiling succeeds and excess refuses without a
  partial result. Reject duplicate variants/codes and repeated cursors.
- Compare the complete current revision tuple before invoking the host verifier;
  preserve the existing nine-code error class and map unknown failures to
  authority unavailable. A failed read never becomes an empty success.
- Prove real PostgreSQL reads through existing restricted runtime SELECT grants,
  seeded through the owned catalog installation seam. Exercise races and
  impossible relational corruption at an injected executor boundary.
- Run affected existing tests, package/API/import-boundary checks, strict types,
  build, lint, structural rules, neutrality and documentation policy. Measure
  real packed and code-class bytes against exact main before the decision read.

## Risk and proof plan

Risks are mixed revision facts, incomplete catalog scans, accidental host-policy
bypass and size pressure. Reuse the strict reader unchanged; add only the
guarded payload reader and bounded quote projection. Use one owned disposable
PostgreSQL container/volume with host TCP readiness and complete installer
bindings. Run focused expensive stages only after machine admission, serialize
shared build outputs, and remove the owned database resources afterwards.

Required next step after focused proof: stabilize the API, record exact local
source/diff identities and measurements in the decision packet, then stop for
the maintainer read before DCO sign-off. Later review and delivery require their
own current evidence and authority.

## Execution evidence

The first focused PostgreSQL invocation stopped before container startup: the
fixture tried to resolve a dependency manifest through an unexported subpath.
No database assertions ran. Dependency discovery now uses the existing Node
package search locations rather than a public export. Memory was checked at
75% free; this was a fixture input error, not a capacity failure. The failed
attempt remains in the local evidence; the next invocation is the corrected
setup attempt, without changing installer or runtime controls.

### Rethink after two setup evaluations

The corrected dependency discovery reached the installed consumer, whose strict
compiler then refused before database startup. The remaining acceptance gap is
execution of the read boundary, not a runtime failure. Both evaluations stopped
in cold fixture composition; neither started a PostgreSQL container. Expose the
compiler diagnostic and first prove the isolated consumer declaration contract,
then resume database proof only with complete inputs. No infrastructure timeout,
spawn failure or database launch retry has occurred. A compiler refusal is a
proof failure to diagnose, never a reason to relax strict checking.

Lesson: incomplete cold fixture composition → prove and report the installed
contract before spending a database startup.

The isolated diagnostic identified the missing explicit `@types/pg` peer in the
cold fixture. It is already a declared package peer. Pack its locked dependency
closure as well, including Node declarations, and resolve all consumer types
inside the consumer. This supplies required inputs without skipping library
checking or borrowing workspace declarations.

The next invocation reached PostgreSQL and all 52 assertions passed, but the
command failed on an unhandled installer-pool connection during container
removal. This is not a passing suite. Track the installed driver's migration
pool explicitly through the existing factory seam, preserving qualified startup
options, and close it with the other fixture pools before removing the container.
Memory remained 75% free; owned container and named volume were removed.

## Focused results and completion boundary

The final installed-artifact PostgreSQL suite passed 52/52 assertions, without
unhandled errors or skips, in 24.94 seconds including package builds and setup.
It proves both strict consumer declaration modes, qualified runtime SELECTs,
current-payload races, tuple guards and all named refusal classes. Production
strict types passed with library checking enabled; the public five-project
check reported zero unresolved edges and zero consumer errors (24.07 seconds).
All 32 existing selected files passed unchanged (3254 cases,
69.74 command seconds); this includes catalog, inventory consumers,
package boundary, import map, outcome projection and existing PostgreSQL suites.
This is focused proof, not a full canonical verification or native review.

On the pinned Node/npm toolchain, a real pack against exact main adds 4,296 B
packed and 3,224 B code, reaching 2,443,751 B packed / 1,956,115 B code, with
three added package files. The earlier design estimate is met. Assuming the
price-read, contact-client and recovery leaves precede this one, arithmetic
using their reported measured deltas reaches 2,456,620 B packed / 1,967,466 B
code. The resulting 2,534 B code margin is tight; an actual combined pack at the
selected landing position remains required. No cap is changed by this leaf.

The stabilized decision packet identifies the exact local WIP tree/diff, source
mapping, host-verifier placement, measurements and remaining proof. The combined
host verifier runs before inactive-product exclusion; this preserves pre-filter
schema admission but also checks excluded documents' digest/identity. That
precise placement is part of the pending API decision. The original callback
and current-direct boundary remain the accepted design. No DCO sign-off, push,
PR, native review or canonical verification is performed in this run.

Self-retro: a hidden dependency manifest and omitted declaration peer wasted
cold-fixture setup attempts; an unowned migration pool caused a teardown error
after all assertions passed. Proving the isolated consumer first and explicitly
owning all installer pools removed those causes without relaxing any check.
The pack gate alone waited 424 seconds. One production module rather than two
keeps the implementation and measured growth within the forecast. No further
process or runtime change is needed within this task.

## Measured per-case deadlines

A predecessor's hosted PostgreSQL history case reached 10,726 ms against the
10,000-ms default and measured 2,759.601 ms locally, giving an observed scaling
ratio of 10,726 / 2,759.601 = 3.886794. One focused real-PostgreSQL run on
Node 24.21.0/npm 11.19.0 with one Vitest worker passed all 52 cases in 22.23
seconds including setup. These are local case measurements; scaled hosted
values are estimates. No case exceeds 5,000 ms locally or an estimated
5,000 ms, half the ordinary default.

The three volume-scan witnesses and real pointer race use the existing explicit
third-argument convention and 30,000-ms coverage floor. The slowest case measured
80.023958 ms: 80.023958 × 3.886793779 = 311.036622 ms estimated hosted cost;
approximately 4× headroom gives 1,244.146488 ms. The deadline is therefore
max(1,244.146488, 30,000) = 30,000 ms, the existing PostgreSQL value. The same
calculation for each other selected case remains below that floor. This follows
the price-reader and contact-client measurement convention without an arbitrary
60-second bound. The optional duration manifest's 1.5× factor is for whole-file
pins; this workflow supplies no manifest, so the explicit per-case argument
is sufficient. Global defaults, retries, assertions, fixtures and production
behavior remain unchanged. The measurement is not rerun after this timing-only edit.

- reads exactly 500 facts in UUID order, using pages of 100 and deduped payload batches: 48.654 ms local, 189.107 ms estimated hosted, 30,000 ms explicit.
- excludes inactive and unsellable SKUs, validates inactive products before exclusion, and retains secondary/addon facts: 44.007 ms local, 171.047 ms estimated hosted, 30,000 ms explicit.
- allows exactly a configured maximum, refuses one excess without partial success, and bounds empty filtered pages: 80.024 ms local, 311.037 ms estimated hosted, 30,000 ms explicit.
- refuses invalid technical maximum 0: 0.178 ms local, 0.693 ms estimated hosted, 10,000 ms default.
- refuses invalid technical maximum -1: 0.060 ms local, 0.233 ms estimated hosted, 10,000 ms default.
- refuses invalid technical maximum 1.5: 0.043 ms local, 0.166 ms estimated hosted, 10,000 ms default.
- refuses invalid technical maximum NaN: 0.039 ms local, 0.150 ms estimated hosted, 10,000 ms default.
- refuses invalid technical maximum Infinity: 0.035 ms local, 0.136 ms estimated hosted, 10,000 ms default.
- refuses invalid technical maximum 9007199254740992: 0.063 ms local, 0.245 ms estimated hosted, 10,000 ms default.
- refuses a missing verifier instead of trusting opaque JSON: 0.170 ms local, 0.659 ms estimated hosted, 10,000 ms default.
- refuses guarded payload product absent before calling the verifier: 3.786 ms local, 14.716 ms estimated hosted, 10,000 ms default.
- refuses guarded payload slug moved before calling the verifier: 3.656 ms local, 14.212 ms estimated hosted, 10,000 ms default.
- refuses guarded payload pointer moved before calling the verifier: 3.513 ms local, 13.655 ms estimated hosted, 10,000 ms default.
- refuses guarded payload revision missing before calling the verifier: 3.452 ms local, 13.418 ms estimated hosted, 10,000 ms default.
- refuses guarded payload revision id before calling the verifier: 3.526 ms local, 13.704 ms estimated hosted, 10,000 ms default.
- refuses guarded payload revision product before calling the verifier: 3.522 ms local, 13.688 ms estimated hosted, 10,000 ms default.
- refuses guarded payload revision number before calling the verifier: 3.575 ms local, 13.895 ms estimated hosted, 10,000 ms default.
- refuses guarded payload revision schema before calling the verifier: 3.401 ms local, 13.218 ms estimated hosted, 10,000 ms default.
- refuses guarded payload revision digest before calling the verifier: 3.472 ms local, 13.494 ms estimated hosted, 10,000 ms default.
- refuses guarded payload invalid lifecycle before calling the verifier: 3.485 ms local, 13.545 ms estimated hosted, 10,000 ms default.
- refuses duplicate joined product rows: 3.498 ms local, 13.598 ms estimated hosted, 10,000 ms default.
- detects a real pointer change between envelope/identifier read and guarded payload SELECT: 6.261 ms local, 24.336 ms estimated hosted, 30,000 ms explicit.
- lets the host refuse document schema using the shared error class: 3.279 ms local, 12.744 ms estimated hosted, 10,000 ms default.
- lets the host refuse document semantic identity using the shared error class: 3.110 ms local, 12.088 ms estimated hosted, 10,000 ms default.
- lets the host refuse document digest using the shared error class: 3.167 ms local, 12.311 ms estimated hosted, 10,000 ms default.
- forwards an arbitrary typed host refusal unchanged and maps an untyped host error safely: 9.088 ms local, 35.323 ms estimated hosted, 10,000 ms default.
- maps strict envelope missing primary SKU: 1.505 ms local, 5.851 ms estimated hosted, 10,000 ms default.
- maps strict envelope missing current revision: 2.137 ms local, 8.305 ms estimated hosted, 10,000 ms default.
- maps strict envelope zero weight: 2.366 ms local, 9.197 ms estimated hosted, 10,000 ms default.
- refuses absent primary unit facts: 2.133 ms local, 8.289 ms estimated hosted, 10,000 ms default.
- refuses invalid primary unit facts: 2.030 ms local, 7.890 ms estimated hosted, 10,000 ms default.
- refuses ambiguous primary unit facts: 2.047 ms local, 7.956 ms estimated hosted, 10,000 ms default.
- refuses duplicate variant instead of silently overwriting: 4.089 ms local, 15.895 ms estimated hosted, 10,000 ms default.
- refuses duplicate code instead of silently overwriting: 3.796 ms local, 14.755 ms estimated hosted, 10,000 ms default.
- refuses a repeated keyset cursor from a faulty executor: 7.255 ms local, 28.199 ms estimated hosted, 10,000 ms default.
- never returns [] after a failing page executor: 0.115 ms local, 0.446 ms estimated hosted, 10,000 ms default.
- never returns [] after a failing identifiers executor: 1.594 ms local, 6.197 ms estimated hosted, 10,000 ms default.
- never returns [] after a failing payload executor: 2.834 ms local, 11.016 ms estimated hosted, 10,000 ms default.
- reads afresh on repeated calls without process or factory caching: 36.139 ms local, 140.463 ms estimated hosted, 10,000 ms default.
- uses only existing runtime SELECT authority and leaves all catalog rows unchanged: 35.195 ms local, 136.794 ms estimated hosted, 10,000 ms default.
- requires host schema admission even when the full revision tuple agrees: 3.813 ms local, 14.821 ms estimated hosted, 10,000 ms default.
- refuses incomplete primary facts and nonpositive grams stored by the installation owner: 9.184 ms local, 35.697 ms estimated hosted, 10,000 ms default.
- does not return earlier pages when a later page fails: 3.906 ms local, 15.181 ms estimated hosted, 10,000 ms default.
- maps the existing authority error catalog_sku_authority_sku_absent to catalog_revision_invalid: 0.100 ms local, 0.389 ms estimated hosted, 10,000 ms default.
- maps the existing authority error catalog_sku_authority_product_absent to catalog_revision_invalid: 0.057 ms local, 0.222 ms estimated hosted, 10,000 ms default.
- maps the existing authority error catalog_sku_authority_primary_sku_invalid to catalog_primary_trade_item_invalid: 0.053 ms local, 0.204 ms estimated hosted, 10,000 ms default.
- maps the existing authority error catalog_sku_authority_selector_ambiguous to catalog_revision_invalid: 0.049 ms local, 0.190 ms estimated hosted, 10,000 ms default.
- maps the existing authority error catalog_sku_authority_current_document_absent to catalog_revision_invalid: 0.048 ms local, 0.186 ms estimated hosted, 10,000 ms default.
- maps the existing authority error catalog_sku_authority_current_document_invalid to catalog_revision_invalid: 0.046 ms local, 0.178 ms estimated hosted, 10,000 ms default.
- maps the existing authority error catalog_sku_identifier_authority_absent to catalog_primary_trade_item_invalid: 0.045 ms local, 0.176 ms estimated hosted, 10,000 ms default.
- maps the existing authority error catalog_sku_identifier_authority_ambiguous to catalog_primary_trade_item_invalid: 0.048 ms local, 0.187 ms estimated hosted, 10,000 ms default.
- maps the existing authority error catalog_sku_identifier_authority_invalid to catalog_primary_trade_item_invalid: 0.046 ms local, 0.180 ms estimated hosted, 10,000 ms default.

## Document verification boundary

The authorized repair admits exactly this reader's single payload projection,
unknown field and direct unread handoff to required host verification. Refusal
witnesses retain other-path, extra-read, interpretation, inspection and logging
exclusions. The lexical guard supports independent behavior review. Local signed
repair and two fresh full reviews are authorized; canonical verification and
external delivery retain the existing supervisor gate.
