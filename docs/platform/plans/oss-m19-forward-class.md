# Closed native forward admission class

Status: accepted repair and main merge committed; supervisor changed (see Actors); two new independent reviews pending.

Outcome: admit one separately approved, finite native forward inventory for
neutral-store work. This control contains no active SQL, feature code, package
source or package/migration manifest change. Scope: registry data and reader,
adjacent inert fixtures/Git witnesses, publication catalogue rows and the data
owner section. At most seven exact ordered slots follow `20261030122000`.
Unknown class paths, signatures and preimages refuse. Feature SQL binds whole-file
and function after-hashes separately; it cannot change this control in that PR.

Authority: CD-M19-39/40 and CD-M19-41 as amended by 41a. Function DO blocks contain
one guarded constant privilege statement; closed roles are anon, authenticated
and service_role, with anon revoke-only. CD-M19-47 adds PUBLIC/conditional table
revokes and ENABLE ROW LEVEL SECURITY only for tables created earlier by accepted,
qualified unconditional CREATE TABLE statements in that same file. Table GRANT
always refuses. Each feature PR must prove its required restricted-runtime access
on real PostgreSQL after narrowing; this control supplies no behavioral proof.

CD-M19-63 replaces CD-M19-41a's key with uniqueness per role, verb AND
object kind (FUNCTION/TABLE). One function revoke and one table revoke can coexist
for one role; duplicates of either kind refuse. CD-M19-63 also accepts a
third closed list: grant-only existing functions, disjoint from replaced/created,
with base-chain existence, no before-hash/redefinition and only pinned conditional
role/verb capabilities. Grant-only-only blocks need no new created-function PUBLIC
revoke. Both refinements and table narrowing as built are accepted by CD-M19-63;
the feature PR retains the real-PostgreSQL RLS/access proof duty. CD-M19-56 requests additive CHECK evidence and a question
confirming that inherited ADD COLUMN/CHECK grammar falls within CD-M19-39; it
introduces no grammar change here.

The worker operates locally under foundation supervision. CD-M19-63 accepts
the stabilized read below for DCO. Native review then requires two independent fresh
reviewers, and canonical verify waits for the supervisor's named slot. No native
review, PR, merge, publishing, settings, credentials, production or budget grant
is inferred from this implementation or its preliminary proofs.

Actors and supervisor change (2026-11-02, coordinator decision). Contexts in
this history: implementation and original supervision, Codex context
`01a19916-f1a0-7273-8962-2370c73127fd` (author of every committed change up to
merge commit `cfcf523c`); reviewers `/root/forward_review_a67` and
`/root/forward_review_b67`, both FAIL, their cards retained. The Codex context
was stopped by a model safety flag at its resume after the repair commit and was
not resumed again. The stream supervisor, Claude Code context
`local_488b5a69-693b-44d8-ad08-f9cb9501f02a` (never a reviewer in this history),
is now the active delivery supervisor. Facts: no parser, registry, SQL or
package change was made as part of the change of supervisor; the staged merge of
`origin/main` `4c7afd2590dc6998e22464153fca70a92eecfeb2` was completed at its
exact tree `9dcd6034a7eb0984e3219b8fd9ce93698d8b4312` and signed. Budgets,
cards, repair cycles and expiry rules carry over unchanged; a supervisor change
adds no cycle. The next prepare uses the existing `prepare --new` route in the
same history; new reviewers are fresh contexts excluded from this list. Any
material repair is decided by the coordinator first because the original writer
is no longer available.

Regroup and material bar (2026-11-02, coordinator decision). Three review rounds
each found a new gap between the hand-written lexer and PostgreSQL; the fourth,
a function header that hides its attribute list inside a quoted default, is
reproduced on real PostgreSQL by the new catalog test. The parser is therefore
not repaired further. A required real-PostgreSQL catalog test,
`tests/postgres/nativeStoreForwardCatalog.test.ts`, is the truth for function
identity, security attribute, `search_path` and privileges: it replays one chain,
the legacy selection, for every bound forward, applies the forward and compares
what PostgreSQL reports with the slot's lists, with and without `service_role`.
The static class stays as a first gate for ordinary mistakes, and the test is a
protected control (a feature PR cannot edit it unseen). Material bar for review: a
static divergence whose effect the catalog test refuses is not material; a
difference in what the test claims to compare that it misses, or an unsound
comparison, is material; an object kind outside its lists is material only with a
demonstrated mechanism reaching a privilege or a listed boundary; function bodies,
data statements and statement kinds keep the existing review duty. Reviewers also
confirm the required-path claim against `scripts/ci-test-scope.mjs` and that an
unbound forward cannot skip the test. The writer of this change is the
stream supervisor context listed above. The reviewers of the previous candidate
(`claude-code-subagent:opus:a937309dd655ccb76`, PASS, and
`claude-code-subagent:opus:a69a6a422b5ef53c7`, FAIL with one material card) are
excluded from the next reviews, and that card (the header boundary) closes
through the catalog test's refusal case, not through the header reader.
Registered, not changed here: the co-location diff lacks `--no-renames`
(F-FORWARD-COLOCATION-RENAMES); backslashes in registry data statements, empty
today (F-FORWARD-DATA-BACKSLASH); the older legacy-class identity example
(F-FORWARD-LEGACY-KELVIN). Duties for the S1 seal: verify the rows added by later
small controls are present before setting `sealed`, run the catalog test with
all bound forwards, and record one run of all of them on the `qualified-v2` chain
as evidence, not as a new gate.

Catalog test review and repair (2026-11-02). Two fresh reviewers
(`claude-code-subagent:opus:a1a3af2b073cd45df` and `...:a7cff8b6348ef112b`) both
returned FAIL on tree `f01b417b03adc7fd06a196c910782fd565de4614` (native cycle 2).
The header card closed: the catalog test refuses the quoted-default statement for
the right reason. Seven material gaps were in the new test and its protection, not
in the static parser: the purpose CHECK rule used the slot values as additions
instead of the preimage values and compared only the quoted literals; system
schemas, schema owners and privileges, role memberships, trigger definitions and
view definitions were not read; the owner of a new object was not pinned; and the
files that select and run the test were not protected controls. The repair keeps
the design and widens what is read, with one uniform list instead of a query per
finding: a digest of PostgreSQL's own function and relation privileges, user
objects read by OID, the owner pinned to the migration role, the exact deparsed
CHECK form, one list of guard catalogs read whole through `to_jsonb` with parser
positions normalized, a test that ties that list to the documentation, a chain
replay that runs with no bound forward, and the controls list extended to the
test's selection and runtime files. Every rule has a refusal case and a
rule-removal check. The static parser is unchanged. Before the last automatic
cycle (3 of 3) the real forwards of the dependent rows run through the final test
locally, so a defect in the comparison is found before it costs a cycle.

Third review cycle and continuation (2026-11-02). Two more fresh reviewers
(`claude-code-subagent:opus:ac6997cec81bddc8f` and `...:a23c4d1f8f81a22a7`) returned
FAIL on tree `e51517754391827ced8d0a8b47eb819eb6be0b37` (native cycle 3 of 3). Both
closed the same seven cards and reported the same two gaps: the protected-control
claim reached files the named controls import, and the documentation said the guard
catalogs are read whole while some rows were filtered, so an internal-trigger change
such as `DISABLE TRIGGER ALL` on an existing table passed. The coordinator authorized
one more review cycle through `continue` with a narrowed scope: the claim names its
files and leaves code those files run, and deliberately evasive changes, to review;
every trigger that existed before the forward is compared as a whole row, internal
ones included, and only the enforcement trigger of a constraint the forward adds may appear;
the remaining row filters are removed or stated; the documentation and the code are
tied by tests (the guard catalogs and the named protected files). The real forwards
of the dependent rows run through the changed test before the next prepare. A
failure of that cycle returns to the coordinator without further repair. Lesson:
a comparison that claims to read a catalog whole must either read it whole or name
each filter, and a claim about protection must name the files it covers.

Fourth review cycle and bar correction (2026-11-02). Two more fresh reviewers
(`claude-code-subagent:opus:a4ef2dfbcb965ea37` and `...:affd81d10d4f9d351`) returned
FAIL on tree `d9c729a8bdf5544309c5ec330434244833b099c5` (native cycle 4). Both closed
the same five of six cards: every protection card and the internal-trigger card.
They reported three classes: row scopes the guard applied without stating them
(constraints and relations at the OID floor, relations of six kinds, rows on
relations PostgreSQL ships), an internal-trigger exception wider than the stated
foreign-key one, and catalog reads that a temporary object could shadow. The
coordinator then returned the review bar to the contribution guide: a finding is
material only with a demonstrated forward that passes the static class and this
test and gains a privilege or breaks a stated boundary (function identity, security
attribute, `search_path`, function ACL, relation and column privileges, row
security), or with a wrong refusal of a valid forward. Wording that is inaccurate
without such an effect is advice, recorded here and fixed in prose by the next
change that touches the section; it never blocks. The fifth cycle deletes the
filters instead of stating them: an existing relation is any relation present
before the forward, PostgreSQL's own included; constraints and relations are read
without an OID floor or a relation-kind filter; an added internal trigger is
admitted only for a constraint the forward adds; the catalog reads pin
`search_path`. Advice recorded for the next documentation change: the freeze of
replaced functions and the grant-only ACL rule are not stated in the section; the
extended protected-file list also applies to the other reviewed classes' co-located
changes and is not mentioned in the co-located approval section.

Fifth review cycle and ruling (2026-11-02). Two more fresh reviewers
(`claude-code-subagent:opus:a30eb2562be925e01` and `...:a054755e3617bdb71`) returned
FAIL on tree `d890faf48dde0d5eb2ff05e16d486b1fd0177aa1` (native cycle 5). Both
closed all seven open cards and each reported one new gap. The coordinator ruled on
both. The gap reported against the relation snapshot did not block: an ALTER TABLE
that rewrites an existing table replaces its TOAST relation and index with new OIDs,
which the OID-keyed comparison refuses, but none of the seven slots rewrites a
table and a refusal is fail-closed; here "a wrong refusal of a valid forward" means
a forward of this programme's slots. Registered follow-up F-FORWARD-TOAST-REWRITE:
compare TOAST relations without OID identity, for example by name, together with
the change that first adds such a forward. The other gap was material. The native
splitter read a backslash in a quoted literal as an escape while PostgreSQL ends a
standard literal at the quote after it, so one admitted CREATE FUNCTION was several
statements for the database, including an operator for `(oid, integer)` in
`pg_catalog` that resolved the catalog test's own integer floor and hid an unlisted
definer from it. The repair is scoped to three changes. A candidate native file
refuses a backslash in a quoted literal or identifier (earlier files of the prefix
keep the older reading), with a static witness using the reviewer's text; none of the
seven forwards has one outside a dollar body. The catalog test types its floor as
`oid`, reads the snapshot under hostile operators in one test, and refuses the
reviewer's SQL directly. `pg_parameter_acl` joins the guard catalogs, with a refusal
case for `GRANT SET ON PARAMETER`, because a privilege on a server parameter was not
seen. Advice for the prose of the G4+G3 control: created functions' language and
leakproof flag are not compared; the freeze of replaced functions and the grant-only
ACL rule are not stated in the section; manifest units are replayed in path order;
the earlier trailer wording about OID floors. A failure of the sixth cycle returns to
the coordinator without repair.

Code base: `bb0008481a11267ec6dbe3e7e531299777cddc19`.
Separately fetched policy revision (2026-11-01):
`3887ee7425fd0eddeecd9a8e2ef3e1420bcf640d`; applicable instruction paths are
unchanged from the base. No main merge solely for freshness was performed.
Branch: `codex/oss-m19-forward-class`. At the original read no task commit, native
review session, admission receipt, expiry or canonical verification existed. The
CD-M19-63 DCO commit and subsequent repair state are recorded below. Repair cycles: zero.
Earlier read packets were unreviewed and are superseded, not accepted evidence.

Current firm inventory, in timestamp order (exact signatures remain registry data):

- G6 `20261101222000_sandbox_payment_attempts.sql`: five replacements, four
  creations pinned to pg_catalog, pg_temp, no grant-only functions. All five
  before-hashes were independently computed from the ordered base chain and
  match the supplied values.
- G2 `20261101223000_subscription_purchase_renewal.sql`: one composite-argument
  activation-commit replacement and seven creations pinned to pg_catalog, pg_temp.
  Replacement preimage: `d378b4e190ec10ffe9d7e9e27d46a02e33ed8950f29f276220ab9d7001933d73`.
- G7 `20261101230000_subscription_renewal_terminal_replay.sql`: exactly the supplied
  `public.subscription_claim_due_renewal(text,text,jsonb,text,integer,timestamptz)`
  replacement, no other supplied objects/ACL changes. Independently recomputed
  latest preimages on both base and current main match the writer:
  `4814d98dbc9e6495af8d1d4d411a6a40d68cb5bcbd53aa41006bea6a34189af8`, from
  `20260815120000_automatic_subscription_renewal.sql`. Header remains unchanged.
- G8 `20261101231000_native_paid_email.sql`: one replacement and eight grant-only
  signatures, all found in the base chain, each service_role GRANT-only.
- G11-c `20261101232000_customer_account_consents.sql`: two created definers pinned
  to pg_catalog, pg_temp, new-table revokes/RLS and the sole widening purpose CHECK.
  Original raw table SHA: `e16287fc4243fc5be3ddc0a67647b3823ad871865fa7bd7448eeac41c6810797`;
  old values: marketing_launch_offer and marketing_newsletter. No replacements.
- G4/G3 remain absent and follow small controls/reads before S1; G4's growing
  compensation inventory is outside this control. There are no empty path
  reservations: omission avoids a second inventory or provisional permission.
  Their fixed timestamps remain fenced. G5 is empty and gets no entry.

Replacement ownership is unique per normalized signature and binds the last
base definition, never an earlier slot's unknown after-hash. Replacement headers
stay unchanged. A class-local reader supports exact normalized scalar, composite/
table and array identities; shared generic/batched readers stay unchanged.
Created functions require PUBLIC revokes before grants/blocks naming creations;
definers require the exact pinned search_path. S1 seals the registry: later slot
changes or unsealing refuse. Missing earlier non-empty slots are never skipped.
DROP NOT NULL, other CHECK replacements, triggers, policies, role/default-privilege
statements, unnamed top-level DML and broader DO shapes remain refused.

The existing default expand-only predicate admits G6's nullable review_required_at
ADD COLUMN and additive review-terminal CHECK on payment_truth_events. A combined
accepting fixture now uses an existing synthetic-prefix table. Refusals exercise
its named CHECK drop/replacement, G11-c's named DROP in another slot, and DROP NOT
NULL. The inherited grammar also admits NOT NULL ADD COLUMN without a default;
a tracked accepting witness records that fact rather than inventing a refusal.
This is lexical admission; feature PostgreSQL/replay proof retains applicability.
No generic parser, operator/cast vocabulary or foreign-key action was widened.

Smallest adequate design: three function lists, a class-local identity reader and
adjacent bounded privilege/table rules. A file-local set of accepted qualified
CREATE TABLE names proves same-file narrowing without duplicating a registry
inventory; IF NOT EXISTS, unqualified and other-slot tables do not qualify.
The source/release caller routes even expand-only reserved SQL through reviewed
admission; the queue caller does so even without a registry edit. Both changes
are needed to prevent bypassing prior slots and feature bindings.

Proof plan: inert seven-slot fixtures discriminate path/order/seal, exact lists,
last/base hashes, headers, normalized types, privilege sequencing and all refusal
boundaries. Real Git witnesses cover separate controls, SQL-plus-pins, issued
immutability, release introduction and PR/merge-group admission. Production data
is checked against the immutable native prefix. Complete the focused test files,
ast-grep, public-tree typecheck, lint, policy/navigation and fresh actual packs.
No canonical verify or PostgreSQL feature qualification belongs to this run.

Read-only writer-shape evidence: G2 WIP fd9296f9 passes all eight definitions and
six blocks. Prior G11-c WIP fd402e5b passed all 19 statements, including unchanged default
table/index/ADD CHECK grammar and the class's explicit narrowing/CHECK rules.
Its shape probe uses synthetic predecessors and proves no feature ordering.
G6's actual available SQL SHA is
`7cbe956e51c16eb2f88ca0430e60a5a3bb9b67e4ebee10f9463723e776852b29` (requested prefix
matches): all 26 statements/nine definitions pass the complete class against the
real base prefix, including both additive statements. No writer file/ref changed.

Proof history: earlier native runs had 63, 98 and 129 passing cases, with 691
existing-forward, 24 qualified, 189 queue and 19 manifest cases green; real packs
were byte-identical. Initial missing declaration builds, the historical unchanged-
registry fast-path regression and fixture-string/diagnostic expectation mistakes
were corrected; failed attempts are not passing proof. No actual native cycle,
receipt or expiry was created or reset. Prior patches/logs remain in scratch.
Original read evidence: 134 native, 691 existing-forward, 24 qualified, 189 queue and
19 manifest cases pass (1,057 total). Ast-grep/whitespace pass, public typecheck
has zero unresolved edges/consumer diagnostics and lint has zero errors/same 33
warnings. Fresh paired npm packs, including both prepack builds, are byte-identical
for Core/Outbox/Platform: zero packed/unpacked delta and zero changed entries.
The focused admissions waited 0 and 32 seconds; the legacy suite took 260 seconds.
Policy/navigation output and its source-bound impact proposals accompany the read;
full policy PASS after the accepted read and DCO remains mandatory. Policy freshness
was fetched again at the same revision above; no main integration is claimed.

Self-retro: repeated firmness updates made old HOLD directives stale; one current
inventory and a short proof history retain the actual authority and budgets.
Using the writer file for a bounded shape probe and a real existing-table fixture
settles the additive-CHECK question without a parser change or another approval
mechanism. Stop NEEDS_READ after the refreshed evidence and identity, before DCO.

CD-M19-61 evidence continuation: check final G11-c head 241d6c1d read-only at
whole SQL SHA `01acd691f9918af6025c975028e31028df02105d36b123dde41c29dc02bcecf6`.
Its two created definer signatures are unchanged; work_id is nullable within
its own CREATE TABLE. The hash is informational here, not a new registry field.
The packet asks explicitly whether the class list must also pin this whole-file
hash or the feature PR binds it with after-hashes under brief point 5. Preserve
the latter design until the coordinator answers. Explain the extra per-slot field,
validation/refusal work and final-byte coordination cost of the alternative;
control and SQL still land separately. Refresh the shape result, policy and read
identity. No admission source, registry, fixture or package input changes in
this continuation; existing tests/pack evidence remains applicable.

Final G11-c result: exact head `241d6c1d4500aec7fe47c4ea5acd04253076349b`
independently hashes to the supplied `01acd691f9918af6025c975028e31028df02105d36b123dde41c29dc02bcecf6`.
All 19 statements/two definitions pass; no refused statement remains. Nullable
work_id is inside its own new-table definition, with no DROP NOT NULL exception.
The shape probe retains synthetic predecessors and establishes no feature ordering
or PostgreSQL runtime proof. No registry hash field or admission rule changed.

Continuation self-retro: an exact-byte check resolves the narrow admission
question without changing the hash-ownership design. A per-slot hash field would
need schema/equality/refusal changes and final-byte coordination, but need not
co-locate SQL if validation waits to read those bytes until the feature PR.
That alternative remains a coordinator question. Existing implementation/pack
inputs are unchanged from the prior staged read; only task/read evidence changes.
No broad check is repeated without an affected input. Stop NEEDS_READ with the
new identity; no DCO, review cycle, PR or canonical verify was started or reset.

CD-M19-63 accepted read identity: code base bb000848, staged tree
`09b58a2b5c4e66c0bf1b4944041c6657e1c3462a`, binary staged-diff SHA-256
`2b5ebab4ae2e1df4b4520069cdd7be72060d903a557060f4895465599b190f9b`, ten paths.
The coordinator accepted the three-list design, role/verb/object-kind key,
table narrowing, closed path/row/order and omitted G4/G3 reservations, G6's
inherited additive grammar, and the two caller edits as additional refusals.
This task-record correction is prose only and changes no accepted implementation,
registry, fixture, package input, rule or gate budget; the rest of the tree must
remain byte-identical to that accepted identity. Earlier open-question notes
above are historical and superseded by these answers.

S1 duty (accepted answer 4): keep nativeStoreForwardClass.sealed false in this
control; S1 MUST set it true. No slot additions/changes or unsealing follow S1.
The lead carries that duty on S1's checklist. This records the implemented
boundary and introduces no new check here.

Hash ownership (accepted answer 6): NO whole-file hash belongs in the class.
The feature PR binds its SQL's file hash and function after-hashes under brief
point 5. Correcting an unissued forward's bytes needs no control change unless
its signatures change; issued-file/binding immutability remains in force. The
CD-M19-61 exact-byte G11-c PASS is informational proof, not a class-list file pin.
The per-slot-hash alternative discussed above is rejected and is not built.

Authorized next steps: DCO-sign as Bart Roszkowski <dev@openlup.com>, complete
policy with the computed impact trailers, then prepare and two fresh independent
sensitive native reviews. Stop READY_FOR_VERIFY forward-class afterwards; do not
run canonical verify, push, open a PR or queue. This is a no-read prose repair.
Self-retro for this handoff: record the accepted S1 and hash duties once in the
existing task state and keep the executable tree fixed; no new process is needed.

Native preparation continuation: CD-M19-63 was DCO-committed as 8da8774 with
passing policy (zero unanswered), clean status and a clean gitleaks contribution
scan. No task WIP refs exist. Native prepare then refused a conflict with current
main. A single publication-catalog insertion conflict was resolved as the union
of both exact rows; every other task blob and every main row/order was preserved.
The automatic no-read integration exception is not satisfied because resolution
was manual and context-bound patch IDs differ. Read coverage for the staged
catalog union was requested; no answer has been inferred from elapsed time.

Author boundary validation found material FC-IDENTITY-001 before counted review:
JavaScript Unicode whitespace/case folding can reinterpret PostgreSQL identifier
characters as an approved ASCII name. The full G6 forward, changed only to append
NBSP to a created function and its ACL references, was admitted. An owned pinned
PostgreSQL 16 probe confirmed the suffixed function exists while the listed ASCII
name does not. The probe container was removed. The local class-only repair uses
ASCII separators/trim, guards identifier/type case folding and exact closed-role
membership. Fully repinned refusals cover NBSP/other whitespace, Unicode case
folding, types, privilege targets and roles; Unicode literals remain accepted.
147 focused native cases and ast-grep pass. Shared readers/expand-only grammar,
registry data and the accepted S1/file-hash duties remain unchanged.

This executable repair is a material delta from the accepted read; it is not the
prose-only exception. Refresh the sensitive read before signing the repaired
merge, then prepare and two fresh reviewers with the finding card. No real native
session/report or repair cycle exists yet: prepare stopped at preflight before
creating one. Keep all evidence; no authority, findings or budgets were reset.
This material repair stops at the applicable read gate if it remains unanswered,
not READY_FOR_VERIFY. Self-retro: a real PostgreSQL lexical witness exposed a
normalization gap that green parser fixtures missed; use SQL identifier semantics
at the class boundary while preserving Unicode data and the shared grammar.

Repair-read evidence: 147 native, 691 existing-forward, 24 qualified, 189 queue
and 19 manifest cases pass (1,070 total). Lint has zero errors/same 33 warnings,
public typecheck has zero unresolved edges/consumer diagnostics, and ast-grep,
whitespace and staged gitleaks pass. Legitimate G6/G2/final G11-c files still pass;
the independently repinned mutated G6 now refuses. Fresh paired packs against
current main, including prepack builds, have byte-identical tarballs and zero
packed/unpacked delta for all three packages. Before R0 integration, normal policy reflected
uncommitted main plus the repair against the old fork: five obligations, two
unanswered; the original DCO policy PASS is not reused as a repair PASS. The
prospective-base impact proposal in the refreshed packet is diagnostic only.
After accepted DCO integration, normal policy must pass with any appropriate
non-merge impact-trailer commit before counted review. This changes no gate.
The repaired merge is staged and unsigned. No counted reviewers, PASS timestamp,
expiry, native repair cycle, canonical verify, push, PR or queue exists. The
remaining bounded action is acceptance of the exact repair-read identity, then
DCO integration and two fresh native reviews under the existing attack criteria.

Main advanced again during the read wait: R0 landed as 09cd599b. The unsigned
3887ee74 integration was preserved as a patch and rebuilt against that actual
R0 main. Only the publication-catalog insertion conflicted again; the resolution
preserves all main rows/order and all four control rows. R0's owner-page additions
were retained, then the class-local repair was reapplied unchanged. No other
worktree or branch was modified. The read must bind this latest staged merge,
not the superseded 9cc5cd6b catalog-only snapshot. Full-index whitespace against
old HEAD sees an inherited R0 SQL blank EOF; the net control diff against R0 is
clean and that generated main file is not changed by this task.

Current policy revision and pending integration base (2026-11-02):
`09cd599bfef6bff74f4431b0cf7a00ebf80f1e6a`. Applicable instructions are unchanged
from 3887ee74; R0's data-owner additions were read and preserved. The native SQL
prefix and reviewed registry on those main revisions are identical. Fresh lint,
public typecheck and 147 native tests pass on the R0 integration; paired real
packs remain byte-identical (Core 182,855 B, Outbox 41,350 B, Platform 2,318,731 B).
Normal policy against the still-unmerged old fork reports nine obligations/five
unanswered; prospective R0-base analysis has only the unchanged configuration
answer and the new tooling answer to bind after accepted DCO. This diagnostic is
not a policy PASS. No publication, SQL or package-source change is introduced by
the ten-path net control delta. The manual catalog union and identity fix are
nonmechanical; no new admission or merge authority is inferred. The original
three-cycle native allowance remains unused, with no counted PASS or expiry.

Final R0 repair-read proof: 147 native, 691 existing-forward, 24 qualified,
189 queue and 19 manifest cases pass (1,070 total); the legacy suite took 217 s.
Ast-grep, lint/typecheck and net whitespace checks pass, and the staged scan has
no leaks. The legitimate G6/G2/final G11-c probes still admit their exact bytes.
Focused admission waited zero seconds. No counted native session or reviewer
was created, so earliest counted PASS/expiry are absent. Stop NEEDS_READ with
the computed staged identity and retain the unsigned merge; the new security
control read is mandatory before repaired DCO and the two fresh native reviews.

Accepted repair continuation (CD-M19-67, 2026-11-02): the coordinator accepted
HEAD 8da87741, MERGE_HEAD 09cd599b and staged tree
8e4e08c99cc349623128270dfa43e0ffb34bec83, including the material identity repair
and exact catalog union. DCO merge b4fb886e retained that tree. Non-merge empty
commit 9199d70c recomputed both source-bound documentation digests and recorded
fresh configuration/tooling trailers. Normal policy has two obligations, zero
unanswered; the worktree and contribution gitleaks scan are clean. No other
worktree, feature SQL, package source, control shape or budget was changed.

The lead's line rule was recomputed from direct changed-code and JSON references,
plus its required shared session/decision suites. There are 26 unchanged existing
files, ten using their own PostgreSQL containers, and one new native-class file.
No existing test differs from review base 09cd599b. An additional raw git-show
copy of the accepted pre-repair native test (8da87741) also passes unchanged
against the repaired code. Each execution had its own focused admission; no
canonical verify was run. The complete file results are:

| File | Result |
| --- | --- |
| `tests/postgres/accountSupportUpgrade.test.ts` | PASS: 2 passed (2) |
| `tests/postgres/commerceManagedRail.test.ts` | PASS: 26 passed (26) |
| `tests/postgres/dunningAttemptReplay.test.ts` | PASS: 20 passed (20) |
| `tests/postgres/expandOnlyExpressions.test.ts` | PASS: 19 passed (19) |
| `tests/postgres/invoicingManagedCorrection.test.ts` | PASS: 26 passed (26) |
| `tests/postgres/reviewedBatchForwards.test.ts` | PASS: 106 passed (106) |
| `tests/postgres/reviewedPortableCreation.test.ts` | PASS: 20 passed (20) |
| `tests/postgres/starterGraduationCadence.test.ts` | PASS: 14 passed (14) |
| `tests/postgres/subscriptionManagedStock.test.ts` | PASS: 12 passed (12) |
| `tests/postgres/subscriptionRenewalLifecycle.test.ts` | PASS: 66 passed (66) |
| `scripts/agent-review-gate.test.ts` | PASS: 22 passed (22) |
| `scripts/agent-review-queue.test.ts` | PASS: 189 passed (189) |
| `scripts/agent-review-session.test.ts` | PASS: 98 passed (98) |
| `scripts/check-publishable-gap-enumeration.test.ts` | PASS: 5 passed (5) |
| `scripts/ci-test-scope.test.ts` | PASS: 58 passed (58) |
| `scripts/documentation-bundle.test.ts` | PASS: 20 passed (20) |
| `scripts/documentation-cli.test.ts` | PASS: 3 passed (3) |
| `scripts/oss-published-tree-check.test.ts` | PASS: 74 passed (74) |
| `scripts/packages/package-release.test.ts` | PASS: 18 passed (18) |
| `scripts/packages/set-release.test.ts` | PASS: 68 passed (68) |
| `scripts/public-ci-neutrality.test.ts` | PASS: 60 passed (60) |
| `scripts/qualified-migration-admission.test.ts` | PASS: 24 passed (24) |
| `scripts/reviewed-batch-forward.test.ts` | PASS: 691 passed (691) |
| `scripts/reviewed-native-store-forward.test.ts` | PASS: 147 passed (147) |
| `scripts/source-preview-release.test.ts` | PASS: 718 passed (718) |
| `scripts/source-release-preparation.test.ts` | PASS: 7 passed (7) |
| `scripts/verify-local.test.ts` | PASS: 14 passed (14) |
| `base-native-8da87741` | PASS: 134 passed (134) |

Net control paths (separate control authority, outside the general CD-M19-10 control exclusion):

- `config/openlup-publication-catalog.json`
- `config/reviewed-platform-forwards.json`
- `docs/platform/DATA_AND_MIGRATIONS.md`
- `docs/platform/plans/oss-m19-forward-class.md`
- `scripts/agent-review-queue.mjs`
- `scripts/fixtures/reviewed-native-store/before.sql`
- `scripts/fixtures/reviewed-native-store/registry.json`
- `scripts/oss-source-release-contract.ts`
- `scripts/reviewed-native-store-forward.test.ts`
- `scripts/reviewed-platform-forward.ts`

The first verification-harness run had four npm-pin failures before commands:
Homebrew supplied npm 11.19.1 while the unchanged fixture requires 11.19.0.
The test and runtime-pin module both match base. A checkout-local copy of the
same Node 24.22.2 binary, its existing relative library link, and npm 11.19.0
resolved the environment mismatch: the unchanged file then passed all 14 cases.
The initial failed attempt and raw log remain retained; no source, test, policy
or global toolchain was changed.

No test was edited to pass; all recorded test-file SHA-256 checks match after
execution. Detailed commands, per-module selection, raw-base identity and logs
remain in ignored task evidence under `.context/scratch/line-rule/`. Focused
admission wait totaled 1657 s; test execution totaled 844 s.
The actual paired Core/Outbox/Platform packs under pinned npm 11.19.0 are byte-identical against R0,
with zero packed/unpacked delta and zero changed entries; all package inputs
remain unchanged. Native prepare/review follows this frozen proof: two fresh
whole-candidate reviewers, the complete attack list, independent assessment of
FC-IDENTITY-001, and a reporting-only reachable-example check of older classes
and the shared expand-only parser. Older pre-existing behavior is not repaired
here. The three-cycle native allowance is unused at this pre-review snapshot.

Self-retro: JavaScript identifier matching can differ from database lexing →
prove the mismatch on real PostgreSQL and constrain the local identity boundary.
Runtime pin mismatch → select the exact checkout-local toolchain without
changing a test or policy. Per-file admission waits dominated the broad unchanged-line proof; no gate,
fixture or budget was relaxed to reduce that delay. Stop after native review at
READY_FOR_VERIFY; final verification and all external delivery await the lead.

First native review and necessary repair (2026-11-02): two independent fresh
whole-candidate reviewers returned FAIL on ed99d2ca/tree 453ae2c2, before any
counted PASS. Their five material cards describe three causes: Unicode structural
spellings (including the fixed role-catalog guard and leading whitespace),
case-varied OR REPLACE misclassified as creation, and commas in quoted DEFAULT
text manufacturing a listed argument identity. Both reports remain recorded in
the existing native session. The author identity card is not considered closed:
one reviewer reopened its broader family, and fresh review must validate all
five cards. Cycle is still zero of three; the first repaired prepare will consume
cycle one after its required read and DCO. There is no earliest PASS or expiry.

The repair opts only native callers into ASCII structural validation before
splitter whitespace skipping, uses ASCII matching for the constant privilege
shape, recognizes creation kind consistently, and separates actual arguments
through quotes, comments, dollar literals and nesting. Identifier-adjacent dollar
markers remain identifier content. Older splitter modes, identity readers and
expand-only grammar retain their behavior. Registry data, caller edits, active
SQL, package inputs and budgets are unchanged. The canonical data owner section
now describes these exact boundaries. No general parser or dependency was added.

Independent raw-definition/file pins show all four concrete mutations admitted
before repair and refused after it, while the unmutated G6 control admits. An
owned network-isolated pinned PostgreSQL 16 probe confirms the default creates
one actual argument instead of five, the long-s guard names another relation,
mixed-case OR REPLACE replaces the object, and leading NBSP causes SQLSTATE
42601. Its container was removed. Twenty appended native cases distinguish the
failures, legitimate complex defaults, Unicode data and identifier-adjacent
dollars; earlier assertions were not edited.

The complete unchanged line rule was recomputed and repeated on frozen repaired
source: 26 existing files match main byte-for-byte, the new native file passes
167 cases, and an exact raw copy of its accepted 147-case ed99d2ca version also
passes unchanged. Every execution used focused admission. Results:

| File | Result |
| --- | --- |
| `scripts/reviewed-native-store-forward.test.ts` | PASS: 167 passed (167) |
| `tests/postgres/accountSupportUpgrade.test.ts` | PASS: 2 passed (2) |
| `tests/postgres/commerceManagedRail.test.ts` | PASS: 26 passed (26) |
| `tests/postgres/dunningAttemptReplay.test.ts` | PASS: 20 passed (20) |
| `tests/postgres/expandOnlyExpressions.test.ts` | PASS: 19 passed (19) |
| `tests/postgres/invoicingManagedCorrection.test.ts` | PASS: 26 passed (26) |
| `tests/postgres/reviewedBatchForwards.test.ts` | PASS: 106 passed (106) |
| `tests/postgres/reviewedPortableCreation.test.ts` | PASS: 20 passed (20) |
| `tests/postgres/starterGraduationCadence.test.ts` | PASS: 14 passed (14) |
| `tests/postgres/subscriptionManagedStock.test.ts` | PASS: 12 passed (12) |
| `tests/postgres/subscriptionRenewalLifecycle.test.ts` | PASS: 66 passed (66) |
| `scripts/agent-review-gate.test.ts` | PASS: 22 passed (22) |
| `scripts/agent-review-queue.test.ts` | PASS: 189 passed (189) |
| `scripts/agent-review-session.test.ts` | PASS: 98 passed (98) |
| `scripts/check-publishable-gap-enumeration.test.ts` | PASS: 5 passed (5) |
| `scripts/ci-test-scope.test.ts` | PASS: 58 passed (58) |
| `scripts/documentation-bundle.test.ts` | PASS: 20 passed (20) |
| `scripts/documentation-cli.test.ts` | PASS: 3 passed (3) |
| `scripts/oss-published-tree-check.test.ts` | PASS: 74 passed (74) |
| `scripts/packages/package-release.test.ts` | PASS: 18 passed (18) |
| `scripts/packages/set-release.test.ts` | PASS: 68 passed (68) |
| `scripts/public-ci-neutrality.test.ts` | PASS: 60 passed (60) |
| `scripts/qualified-migration-admission.test.ts` | PASS: 24 passed (24) |
| `scripts/reviewed-batch-forward.test.ts` | PASS: 691 passed (691) |
| `scripts/source-preview-release.test.ts` | PASS: 718 passed (718) |
| `scripts/source-release-preparation.test.ts` | PASS: 7 passed (7) |
| `scripts/verify-local.test.ts` | PASS: 14 passed (14) |
| `base-native-ed99d2ca` | PASS: 147 passed (147) |

All 28 executions / 2,694 cases pass. Focused test admission waited
3617 s and test execution took 860 s; logs, module selection and every
file hash remain in ignored repair1-line-rule evidence. No existing test was
changed to pass. The previous npm-pin failure remains recorded; this rerun uses
the checkout-local pinned Node/npm, with the Docker CLI available to the ten
owned-container PostgreSQL suites.

Ast-grep, lint and public typecheck pass. Lint has zero errors and 99 warnings:
33 existing warnings in the checkout plus the same warnings in two full baseline
pack archives under ignored scratch. No lint rule or ignore was changed. Real
paired Core/Outbox/Platform npm packs against main 09cd599b are byte-identical:
0 B packed/unpacked delta, no changed entries. The normal policy check currently
reports two obligations and one unanswered tooling digest because repaired
control code is not DCO-signed before its new read. Its exact proposed trailer
is in the stable packet; after accepted read it must be committed and policy
must show zero unanswered. No policy PASS is inferred for this unsigned tree.

F-FORWARD-LEGACY-KELVIN is registered as a follow-up by CD-M19-72, not fixed
here. The older legacy-class Kelvin-sign example is unreachable with today's
registry bytes, and any relocation of that legacy path needs its own control.
The reviewers' prerequisite relocation scenario does not establish a current
admission. Issued SQL is not repinned. Default expand-only admission already
rejects such structural Unicode. No older class is changed.

CD-M19-72 confirms the predecessor interpretation: landing stays in slot order;
every earlier non-empty row needs its landed binding before a later slot,
including G4/G3 before G7/G8/G11-c. The conservative refusal is unchanged and
no unregistered predecessor is skipped. This question is answered.

Regroup/self-retro: the author evaluation accepted at CD-M19-67 proved the suffix
repair; the first native candidate evaluation at ed99d2ca then left a material
obstacle to the same closed-identity outcome. The remaining gap belongs to this
class control, not the unchanged older classes. The first fix did not cover every
structural boundary or quoted defaults. The review evidence led to
one bounded repair using the existing lexical seam, consistent kind detection
and a small argument separator. Fully repinned counterexamples and real database
observations discriminate the causes: the next check required all four fully
repinned mutants to refuse while the unchanged control admitted, and those
observations now hold. Repeated lexical identity gaps → reuse the smallest
existing token boundary and prove it against database interpretation. Preserve
both FAIL reports and the same
three-cycle budget. Rules-common step 4 requires a fresh stabilized control read
before repaired DCO; stop NEEDS_READ, then obtain two new independent reviews.
No canonical verify, push, PR, queue, release or other worktree mutation ran.

Accepted repair continuation (CD-M19-72, 2026-11-02): the coordinator accepted
HEAD ed99d2ca and staged tree c4b85788a9a2ebeb80b31fb06fb38a2990a5c70d,
with cached-diff SHA e5cc00d13e25c1fcdbacf31689c83c57ba78ec9402537d4cf9e02d73eb91370f
and four paths. DCO commit 793930e5 retains that exact tree. ASCII structure
remains opt-in for native calls only. This is repair cycle one of three; both
prior FAIL reports and all five material cards remain in the same native
history. Fresh prepare must preserve them. No counted PASS or expiry exists at
this pre-review snapshot.

The coordinator's regroup line is binding for the next two independent reviews:
if either finds another static parse bypass, stop adding parser rules and report
NEEDS_OWNER with the facts. Do not spend the remaining cycles on another parser
repair. The proposed regroup is real PostgreSQL catalog proof as primary truth:
compare pg_proc identity, security attributes, search_path and ACL before and
after each forward against the slot lists in the required path, keeping static
checks simple as early refusal. That catalog mechanism is not implemented or
authorized by this record. Ask each reviewer, as advice only: "has the current
candidate reached the point where that catalog proof is cheaper than the
remaining parser risk?" Report both answers without treating advice as a blocker.

The final executable source and tests are byte-identical to the frozen repair
proof: 26 unchanged existing files, the native 167-case suite and the exact raw
147-case version all pass (28 executions, 2,694 cases). Only this task-record
prose changes after that proof; no test, fixture, package or parser is changed.
Policy/navigation and ast-grep are refreshed for this prose and the source-bound
tooling trailer is recomputed on the final tree. The previously measured real
pack remains applicable: all three tarballs and entries match main, delta 0 B.
No redundant test rerun or new repair cycle is inferred from the record update.

Self-retro: repeated static-reader bypasses → stop extending the parser if the
next review finds another, and return the catalog-proof tradeoff to the owner.
This line changes the allowed recovery route, not the admitted SQL or test floor.
Final verification and all external delivery remain reserved to the supervisor.

Required main integration after CD-M19-72: native prepare refused merge preflight
against main 4c7afd2590dc6998e22464153fca70a92eecfeb2. The integration-trailer control had
landed after the accepted repair. A forced merge is pending; its only conflict
was the publication catalogue's adjacent plan-row insertion. The union retains
both forward-class and integration-trailer rows, with every row and its order
from both parents preserved. All other inherited changes are main's exact bytes.
Native parser, registry, fixtures, caller changes and data-owner section remain
identical to the accepted repair. No parser rule or new static parse bypass was
introduced or discovered. The next-two-reviewer regroup line remains binding.

The CD-M19-72 repair was DCO-committed as 793930e5 at its exact accepted tree;
record/trailer commit 8f295e4b followed, with policy two obligations and zero
unanswered, clean status and passing gitleaks. That committed repair is cycle
one of three. Prepare stopped before appending its event, so the stored native
counter still says zero; the next successful prepare must record cycle one and
retain both FAIL reports and five material cards. No new reviewer has started,
no counted PASS/expiry exists, and the catalog-proof advice question is not yet
asked because the required clean committed candidate is blocked by this merge.

Main's session helper and gate test changed implementation/test bytes, and the
catalogue union changed a policy input. Both direct/shared and catalogue consumers
were recomputed; seventeen current files plus raw native147 were rerun through
focused admission. The gate file is main's
unchanged 45-case version; no existing test was edited. The ten PostgreSQL
existing-file results remain applicable because their source/dependencies and
SQL/package inputs are unchanged. Final selection evidence:

| File | Result | Evidence |
| --- | --- | --- |
| `scripts/reviewed-native-store-forward.test.ts` | PASS: 167 passed (167) | fresh: current merged tree |
| `tests/postgres/accountSupportUpgrade.test.ts` | PASS: 2 passed (2) | reused: accepted repair proof, unaffected source/dependencies |
| `tests/postgres/commerceManagedRail.test.ts` | PASS: 26 passed (26) | reused: accepted repair proof, unaffected source/dependencies |
| `tests/postgres/dunningAttemptReplay.test.ts` | PASS: 20 passed (20) | reused: accepted repair proof, unaffected source/dependencies |
| `tests/postgres/expandOnlyExpressions.test.ts` | PASS: 19 passed (19) | reused: accepted repair proof, unaffected source/dependencies |
| `tests/postgres/invoicingManagedCorrection.test.ts` | PASS: 26 passed (26) | reused: accepted repair proof, unaffected source/dependencies |
| `tests/postgres/reviewedBatchForwards.test.ts` | PASS: 106 passed (106) | reused: accepted repair proof, unaffected source/dependencies |
| `tests/postgres/reviewedPortableCreation.test.ts` | PASS: 20 passed (20) | reused: accepted repair proof, unaffected source/dependencies |
| `tests/postgres/starterGraduationCadence.test.ts` | PASS: 14 passed (14) | reused: accepted repair proof, unaffected source/dependencies |
| `tests/postgres/subscriptionManagedStock.test.ts` | PASS: 12 passed (12) | reused: accepted repair proof, unaffected source/dependencies |
| `tests/postgres/subscriptionRenewalLifecycle.test.ts` | PASS: 66 passed (66) | reused: accepted repair proof, unaffected source/dependencies |
| `scripts/agent-review-gate.test.ts` | PASS: 45 passed (45) | fresh: current merged tree |
| `scripts/agent-review-queue.test.ts` | PASS: 189 passed (189) | fresh: current merged tree |
| `scripts/agent-review-session.test.ts` | PASS: 98 passed (98) | fresh: current merged tree |
| `scripts/check-publishable-gap-enumeration.test.ts` | PASS: 5 passed (5) | fresh: current merged tree |
| `scripts/ci-test-scope.test.ts` | PASS: 58 passed (58) | fresh: current merged tree |
| `scripts/documentation-bundle.test.ts` | PASS: 20 passed (20) | fresh: current merged tree |
| `scripts/documentation-cli.test.ts` | PASS: 3 passed (3) | fresh: current merged tree |
| `scripts/oss-published-tree-check.test.ts` | PASS: 74 passed (74) | fresh: current merged tree |
| `scripts/packages/package-release.test.ts` | PASS: 18 passed (18) | fresh: current merged tree |
| `scripts/packages/set-release.test.ts` | PASS: 68 passed (68) | fresh: current merged tree |
| `scripts/public-ci-neutrality.test.ts` | PASS: 60 passed (60) | fresh: current merged tree |
| `scripts/qualified-migration-admission.test.ts` | PASS: 24 passed (24) | fresh: current merged tree |
| `scripts/reviewed-batch-forward.test.ts` | PASS: 691 passed (691) | fresh: current merged tree |
| `scripts/source-preview-release.test.ts` | PASS: 718 passed (718) | fresh: current merged tree |
| `scripts/source-release-preparation.test.ts` | PASS: 7 passed (7) | fresh: current merged tree |
| `scripts/verify-local.test.ts` | PASS: 14 passed (14) | fresh: current merged tree |
| `base-native-ed99d2ca` | PASS: 147 passed (147) | fresh: current merged tree |

The final line selection is 26 unchanged existing files plus native167 and raw147:
28 selections / 2,717 passing cases. The refresh ran eighteen executions / 2,406
cases; summed focused admission wait was 1506 s and summed execution time
was 774 s. Frozen
file hashes pass. Ast-grep, public typecheck and lint pass (zero errors, 132
warnings: the existing 33 repeated in three ignored baseline archives plus the
checkout). No lint rule or ignore changed. Normal policy on the pending tree
passes two obligations / zero unanswered. Diagnostic comparison against the
future main base also confirms both existing source-bound trailers still match.
Actual Core/Outbox/Platform pack evidence remains 0 B and byte-identical; main
changed no package, SQL or pack-build inputs. No fresh-pack claim is inferred.

The manual catalogue conflict means rules-common step 4's conflict-free/no-manual
integration exception does not apply. Source patch identity excluding task and
catalogue is preserved; full patch IDs differ with catalogue context. A refreshed
read packet presents this exact staged merge before its DCO. This asks only for
the necessary catalogue union, not for new parser behavior or recovery authority.
After acceptance, finish the merge DCO, recheck policy/clean status and prepare
the same native history before two new independent whole-candidate reviews.

Self-retro: an advanced control on main required catalogue integration after the
accepted repair → preserve both data rows and refresh only affected shared proof.
No new static parser work, canonical verify, push, PR, queue or other worktree
mutation was performed. Stop NEEDS_READ for the nonmechanical union; the next
static parse bypass, if reviewers find one, still requires NEEDS_OWNER.
