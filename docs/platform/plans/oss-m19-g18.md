# Own-stack integration sample

Status: configuration repair in progress, pending a delta maintainer read before
commit. The preceding integrated candidate passed source review and PostgreSQL
proof, then failed the canonical repository neutrality gate on ambient
configuration reads. The existing gate and baseline remain unchanged.

Outcome and scope: a small independently routed/authenticated application outside
the platform checkout uses released public factories and ports on portable
PostgreSQL. Files: `examples/own-stack/**`, the architecture pointer, publication
catalogue rows, generated source map and this record. The lead also assigned one
additive `examples/own-stack/**` row in `config/doc-routing.json`, pointing to
`ARCHITECTURE_AND_EXTENSIONS.md#own-stack-integration-sample`; existing rows and
ordering are preserved. The private manifest is a template copied to package.json
only outside the repository, so the sample is neither a workspace nor a package
publication input.

Choose catalog draft authoring: its public handler/store demonstrate a durable
success, conflict refusal and exact replay without subscription fixtures or
cycle changes. No starter or private helper. No platform export, SQL, grant,
package dependency, served-rail behavior, release control or adopter-source change.
A missing public seam goes to the programme lead, not into this change.

Authority: the accountable maintainer assigned local implementation and supervision
under the foundation stream and programme lead. The programme permits local
proofs, DCO commits and native review as Bart Roszkowski <dev@openlup.com>.
Programme delivery remains delegated within the lead's landing line and the
VERIFIED prerequisite release line. The lead authorized replacing ambient reads
with an external gitignored JSON file, with a standard-input fallback if a
configuration-path argument conflicts with publication policy. This repair run
ends at the delta read, before any commit, push, PR, receipt or queue.
No publication, tag, release dispatch, hosted resource, cost, production or
credential/settings operation. The prerequisite release line is VERIFIED.
Focused stages use the host gate without intermediate stops; canonical verify
waits for the lead's named landing turn. The coordinator's recorded sample
decision keeps the manifest template, uses an imported factory plus tiny runner
without a process.argv guard, and requires a stable read packet before DCO.
Publication-control files remain unchanged. The template pins remain on 0.36.0,
whose registry tarball lacks the complete qualified chain; they move to the
programme release at S1.

Initial code base: `bb0008481a11267ec6dbe3e7e531299777cddc19`. Repair base:
`97ec7274aed606862171d656a72c90c636f56471`. Current policy pin:
`4c7afd2590dc6998e22464153fca70a92eecfeb2` (fresh origin/main on resume,
2026-11-02). Worktree `oss-m19-g18`, branch
`codex/oss-m19-g18`. Follow the [agent guide](../../../AGENTS.md),
[contribution rules](../../../CONTRIBUTING.md) and
[architecture owner](../ARCHITECTURE_AND_EXTENSIONS.md#own-stack-integration-sample).

Acceptance and sufficient proof: copy only the sample outside every OpenLup
checkout and install real exact registry artifacts or tarballs, never source links.
On a real complete qualified-v2 PostgreSQL 16 installation, the actual HTTP route
must commit a draft, refuse missing/invalid credentials and a changed request
under the same key, then replay the original after recreating the application.
SQL readback binds the persisted actor to the application-verified ID and proves
one revision/receipt with unchanged tuple versions on refusal/replay. Request
identity and email inference are never authority. The witness must use a
nonowner, non-superuser, NOBYPASSRLS runtime login and its existing service lane.
No hand-written grants or installer-login bypass substitutes for the final chain.
Schema setup uses the documented public migration factory from a real tarball
built from the merged installer source. Never edit another worktree or import
private helpers into the application. A sparse-schema run cannot establish acceptance.

Risk and proof plan: one application factory, a tiny runner, one host-owned product
type and one HTTP/SQL witness. Authentication precedes store access, tokens stay
external, and request bodies are bounded. The smallest alternative considered is
catalog reads; draft commands additionally distinguish retained replay from a
repeated read with little setup. Complete structural scan, policy/typecheck/lint,
stable maintainer read, two fresh native reviews and final verify before delivery.

Initial source checkpoint evidence (2026-11-01): registry installation in the independent
`m19-own-stack-g18-consumer` directory outside all platform checkouts succeeded (16 packages).
Core/platform 0.36.0 and pg 8.22.0 resolve to registry tarballs with integrity values
and no symlinked package directory. The imported public catalog/data factories
and app module load. Its retained lockfile SHA-256 is
`d7ba81f680c3eff582a13599c591a12d7d71faa35dece8f9d95a6a53ca6fbb73`.
The installed openlup-context package-code query and dependency evidence are in
ignored scratch. Root npm ci passed (727 packages). Syntax, whitespace, structural
scan and gitleaks 8.30.1 sample scanning pass. Prerequisite package builds,
`npm run oss:published-tree -- --typecheck` (five projects, zero unresolved edges
and zero consumer-side errors) and `npm run lint` pass. Lint included its
prerequisite builds, eight structural-rule suites and ESLint.
No actual PostgreSQL run or passing acceptance result is claimed.

Exact SQL prerequisite inspection: platform-0.36.0.tgz matches its registry
SHA-512. It contains 53 SQL assets, 51 of 95 selected qualified units. The directly
needed 20260908100000_catalog_draft_foundation.sql is present with canonical
SHA-256 ac0d614cdb2874df8fbdbbbda4f9455986ef95241fe1334b0b54a1fa6478ab2e.
The chosen service lane also needs q2_20260810180001_self_host_actor_auth.sql
(role graph) and q2_20261026130000_runtime_capabilities.sql (draft table grants,
RLS policies and four routine grants). Both and the qualified baseline are absent.
The runtime-capability unit references the broader graph: these direct dependencies
are not an independently installable sparse chain. No later qualified unit changes
draft privileges. Complete-chain proof therefore remains mandatory.

Original source checkpoint policy: the post-commit `npm run oss:published-tree -- --policy` exited zero
with both documentation obligations answered and the scoped ownership trailer
accepted. Navigation and publication checks pass completely. No publication-
control row was changed. The signed contribution includes the proposed
OpenLup-Doc-Impact trailer. Native review has not yet been prepared; cycles: 0.
No external write or canonical verification. Package publication inputs are
unchanged; no packed-byte measurement or package delta is claimed.

Maintainer read: ACCEPTED on 2026-11-01 for base bb000848, staged tree
79c657026f2c148517a99f1cff56fcb7e813db1a and diff SHA-256
1cbcc659f571f250d014dc4c6d6a60904602ffc0763497008c0625f54dee0121
(11 paths, 483 insertions). The requested prose corrections only narrow this
record; the exact accepted and corrected full-diff hashes are retained in the
commit's read-comparison trailers and ignored evidence. Every other accepted
file stays byte-identical. This is the prose-repair no-read carve-out.

Original source sequence (2026-11-01): DCO commit, complete policy PASS and two
fresh native source reviews, then wait for the committed installer head.
The complete-chain PostgreSQL proof must pass before any verify slot. A failing
proof that requires code changes returns for a new maintainer read and delta
review. No hand-written grants, owner-login bypass or invented chain is allowed.
At that checkpoint, full acceptance and canonical verification remained pending that proof.

Closure cleanup remains: remove the owned independent consumer directory
`m19-own-stack-g18-consumer` (a maintainer-local checkout outside the repository) only when its PR closes. Keep it available through
repair review and delivery; proof logs and actual outcomes stay in ignored scratch.

Self-retro: the requested record corrections preserve the read-bound code.
Earlier shared resource waits included 541-second and 547-second focused-gate
timeouts followed by the required retries. Appending the
architecture section preserved installed context excerpt spans. A private manifest
template and separate runner keep the example small within existing controls.

Configuration repair (2026-11-02): use a gitignored app.local.json containing
databaseUrl, operatorToken and optional port. The runner consumes JSON on
standard input; the existing witness reads that filename relative to its working
directory and still creates its own token. Credentials stay in the external file,
never in command-line values. An argument-based version was actually checked and
refused as an unregistered direct entrypoint; the authorized standard-input
fallback needs no new entrypoint or policy row. Document the JSON shape in the
README rather than add another public file. Parse errors are replaced with
fixed messages so malformed configuration does not expose credential contents.

Repair proof plan: execute repository-wide neutrality before the delta read,
then policy/navigation, types, lint, structural and secret checks. The only
existing test that references the sample module is its own HTTP/SQL witness;
repeat it and exercise the standalone runner using a fresh PostgreSQL 16
installation from the current merged platform tarball. Preserve all prior auth,
conflict and immutable replay assertions. No control or baseline change. The
previous integration is cycle 1 of 3; this staged repair is not prepared or
committed. After approval, fresh review of the repaired delta receives its own
24-hour evidence clock. Stop at the delta maintainer read.

Rethink: ambient startup reads were refused by neutrality, and the replacement
file-path argument was refused by direct-entrypoint admission. Both concern the
startup input boundary. Standard input already carries the complete external
file without a new admission row or an alias for an ambient reader. The
discriminating checks are both unchanged gates against this version, followed
by real runner and witness execution. Lesson: incompatible input boundaries →
use the existing input channel, without a control exception.

Repair self-retro: the external configuration shape fits in the README; a
separate published example file adds no necessary behavior. Configuration
parse refusals use fixed messages, preserving credential secrecy. Runtime proof
results and the exact staged identity belong in the ignored evidence and delta
read packet, not in a post-review outcome edit here.
