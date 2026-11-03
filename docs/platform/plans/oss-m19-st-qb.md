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

No SQL asset, grant, export subpath, control, starter composition, price authority
or promotion reader changes. Existing strict envelope readers remain unchanged.
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
