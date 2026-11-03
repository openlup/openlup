# Shipping, promotion and absorption approvals

Status: staged preparation; maintainer read required before signing.

Outcome and scope: add exactly three function approvals and three data-statement
approvals to two unbound slots
of the reviewed native forward registry: one replacement and one creation in
G8, and one creation plus three absorption-policy statements in G11-c.
Preserve all existing entries, paths, ordering,
sealing state, bindings and the consent-purpose check. Update only the matching
production expectations, register this record and regenerate documentation
navigation. This change approves signatures and exact statements only; it adds no executable
migration or runtime behavior.

Purpose: one-off orders will carry net shipping through a later replacement of
the promoted order draft. A narrow definer helper will lock a promotion definition
so the restricted runtime can apply real promotions without editing definitions.
Renewals will carry their cycle snapshot shipping through a new registration
function; the earlier function remains and still refuses non-zero shipping.
Three later tables referencing customers had no absorption classification, so
the earlier lead-absorption routine refused every lead. Each will be classified
as blocking. This control only approves those statements; the SQL lands with
the account-consent row. These are intended later feature changes, not behavior
supplied by this record.

Authority and delivery: the assigned worker may edit, stage and run focused
checks in this task's dedicated worktree. The lead coordinates the predecessor
control and the maintainer read. No commit or DCO sign-off until explicitly told;
no submission, merge, release, publication, settings, credentials or adopter
change is authorized in this run. Native committed review and canonical
verification remain later gates. No package file changes; package delta is 0 B.

Code review/stack base: `d0d40d5249f2dd9b59a4a96180d7d25c3328f305`,
the DCO-signed predecessor directly above the original base. Fetched policy
revision remains `4d78e855cf8bbd57704f9503cd7bae28f96453a5`.
Use `OPENLUP_STACK_BASE=d0d40d5249f2dd9b59a4a96180d7d25c3328f305`
for subsequent policy and review. This worktree has no commit of its own.

Rebuild proof: saved the expanded staged patch, reset only this assigned
worktree to the predecessor, then applied the patch with `--index --3way`.
The registry and test applied cleanly. The sole conflict was adjacent catalog
rows; both predecessor and current task rows were retained. No semantic
resolution or change to the predecessor was needed.

Before/after hashes were measured before this evidence paragraph was appended.
The saved patches preserve that exact measured state. Commands on each patch:

```sh
for patch in .context/scratch/g8ctl-staged.patch .context/scratch/g8ctl-r2/post-stack.patch; do
  awk '/^\+/ && !/^\+\+\+/' "$patch" | shasum -a 256
  awk '/^-/ && !/^---/' "$patch" | shasum -a 256
  awk '/^[+-]/ && !/^(---|\+\+\+)/' "$patch" | shasum -a 256
done
```

Before and after added-line SHA-256 both equal
`fa50b4d5bba44e4d42805781da027f43a8a49f1b05b25e92104ed9dc6e4d1eaf`;
removed-line SHA-256 both equal
`fc46de4c50e13663a5dac2b4c6b117fe76c3681cd7aa97076721c92a7caae923`;
combined +/- line SHA-256 both equal
`6368f4ae4c82d570bae4fc7f2df36a7601ed62cb752c979baabd6370bf09fcec`.

Acceptance and proof: reproduce the issued renewal-claim preimage with the
repository's definition reader, then recompute the promoted-draft preimage from
the ordered origin/main native migrations. Both issued hashes must match.
Confirm the replacement is pre-class and unique across slots, both created names
are absent anywhere on origin/main, and both slots remain unbound. Compare the
registry structurally to prove exactly the three function and three statement
additions. Each statement must be ASCII, parse as one INSERT and preserve its
exact bytes and order. Prove all three tables exist on origin/main and have
no absorption-policy row there. Prove class validation accepts the statements
alongside the slot's existing purpose check and created functions. Execute the focused
suite and every unchanged registry reader test, ast-grep, public typecheck,
lint, policy/navigation regeneration and trusted main's full hosted admission
entrypoint in scratch. Scan the staged diff for neutral public wording and
confirm no package input changed.

Risk and smallest adequate solution: append closed data entries and exact
production assertions. Reuse the existing reader and refusal tests; add no
parser, exception, SQL body, new grant or control mechanism. Feature owners
retain SQL, restricted-runtime, shipping, promotion, replay and real-database
behavior proof. No path in the reference adopter's production composition changes.

Preimage evidence: the issued renewal-claim hash reproduced exactly as
`4814d98dbc9e6495af8d1d4d411a6a40d68cb5bcbd53aa41006bea6a34189af8`.
The promoted-draft replacement's last definition before G8 computes
`2dd59a4f2eb7603e2a1714a97ccfad3d078990cb8978a4db16c130ff9db43364`.
Both definitions precede the first class slot; no existing slot replaces the
promoted-draft signature. Both new names are absent on the fetched origin/main.
The command uses `nativeStoreFunctionDefinitions(bytes, [signature], true)`
on each Git migration blob in path order, retaining the last definition before
the target slot. Full commands and results accompany the private read packet.

Statement evidence: all three strings are single-line ASCII INSERTs, each
returned byte-identically as exactly one statement by `sqlStatements`. All
three tables have CREATE TABLE definitions on the fetched origin/main. The sole
absorption-policy DML seed contains no row for any of them. The existing class
reader accepts all three exact statements with the purpose check and three
created functions, while the slot stays unbound and the class unsealed.

Resumed candidate check evidence: every one of the 13 registry-reader files
was executed again on the expanded staged candidate: 2,035 cases passed, with
zero failures or skips. Other reader test sources remain byte-identical to the
predecessor; only the requested production expectations change. Ast-grep and
all five public typecheck projects and lint pass, with zero type diagnostics
and zero lint errors. Lint reports 33 warnings in unchanged files. No package input changed
(0 B). Full commands, counts and candidate identities accompany the private
read packet; historical first-run logs remain separate from the rerun.

Trusted main's full hosted admission entrypoint passes in isolated scratch
against the cumulative staged tree at its actual main fork, using real Git
objects/fetches and synthetic PR/receipt inputs. This establishes reader/control
compatibility, not actual hosted or native review evidence. The unlanded
predecessor must still reach actual main before real stacked-PR admission.
All changes remain staged and uncommitted.

Documentation impact: the compatibility posture and development-preview check
instructions remain correct. Only unbound function/statement inventory and exact production
expectations change; no executable migration, binding, runtime implementation,
test command or admission-grammar changes. Navigation regeneration makes no tracked change. Policy identifies two
commit-bound no-impact obligations; proposed trailers accompany the maintainer
read and remain pending the authorized commit.

Historical first-run retro: the first focused run exposed one missed production list assertion
(209 passes, one failure). The existing expectation was updated instead
of keeping a duplicate; the corrected run passes all 210 cases. The largest
focused admission wait was 393 seconds; the release-reader suite took about
381 seconds. No native review, repair cycle, verification stamp
or real receipt is claimed. Keep direct closed-list additions; no separate
process change is justified.

Resumed-run retro: the only integration conflict was adjacent catalog rows;
retaining both rows preserved equal +/- line hashes without semantic edits.
A waiting scratch launcher was stopped before its next test to unset the stack
pin only in test children, matching the canonical test command; no assertion
ran or failed during that correction. Parent policy and review keep the pin.
The largest resumed test-stage admission wait was 271 seconds. No new
control mechanism or relaxation was needed.
