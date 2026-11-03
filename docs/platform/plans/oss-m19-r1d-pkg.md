# Native acquisition eligibility and admission

Status: local implementation and required local proof complete; the maintainer
accepted the APIs and recorded cost for one local DCO-signed commit. Development
preview. This continuation stops after that commit, before native prepare,
review, verification, submission or publication. Review waits for the assigned
integration base.

Outcome and smallest scope: add exact-first, bounded plus-alias eligibility and
transactional final acquisition admission beside the existing promotion and
native commerce ports. Keep purchaser identity separate from eligibility facts.
Reuse the selector, promotion reads, definition lock and lower draft writer.
Commercial values and semantic classification remain host configuration.

Exclusions: shared pricing-engine changes, scheduling, SQL migrations/DDL/grants/roles,
controls, renewal-term interfaces, starter composition, browser-spec edits,
provider access, deployment and publication. No such change was made here.

Authority: the assigned worker may implement and test this bounded package leaf
in its assigned worktree; the stream supervisor coordinates with the programme
lead. The maintainer read accepted the recorded forecast overshoot and authorized
one local DCO-signed commit with explicit host obligations. No merge or release
grant is exercised. The leaf has no merge. Scratch merges are diagnostic only
and never enter this leaf.

Code base: `e486bbf2d11939968960cb4ac924ce5e3d9e6063`, tree
`be4db84a182cf04d6fe84099f2e3ad1ece5282c5`. Instruction pin:
`7249a750addf64fea1da42fa87e77467794da09c`. Resumed main readback:
`2245d037d55dbe4e324e630da851402d9efccd1c`; the applicable agent,
contribution, documentation-maintenance and AI-accountability instructions were
byte-identical since the instruction pin. No freshness merge was made. The
frozen predecessor still matches. Only this task's changes were present at
resume. Memory observations reported 90% free pressure and no swap I/O.

Public additions in existing package entries:

- `./promotions`: `createPostgresQuoteCustomerEligibility` and
  `QuoteCustomerEligibilityResolution`. The factory supplies trusted internal
  `resolve(email)` evidence and `hasPaidSubscription(clientId)` facts.
- `./commerce/server/native-checkout`:
  `createPostgresAcquisitionCheckoutPersistence`,
  `NativeAcquisitionCheckoutPool` and `NativeAcquisitionCheckoutOptions`.

The factory owns an exclusive runtime connection and READ COMMITTED transaction.
It serializes the normalized existing native idempotency key before receipt
checks, holds existing definition row locks, compares current terms/capability
and paid-family evidence, calls the unchanged lower draft persistence and
commits on that connection. Matching replay retains native ownership and
changed-input checks. The host must pass only a quote produced on the server,
authorize the buyer and verify quote acceptance before calling this boundary.
The result of `resolve` must stay inside the server and never reach the browser.
A host mounting acquisition routing must route every acquisition caller through
the adapter; the mounting integration supplies its own no-bypass witness.
The lower factory remains persistence only.
The package-only tree mounts no checkout route; a staged AST caller inventory
checks that its sole native draft construction is inside this adapter. Future
starter route mounting requires its own integration/browser evidence.

Acceptance and sufficient evidence: real installed-package restricted PostgreSQL
must prove exact precedence and bounded escaped alias fallback; current paid
family facts without identity changes; named missing-capability/wrong-engine
refusal; changed equal-money second promises, revisions, omitted grants, pause
and stale grants refusing without durable effects; definition contention in both
directions through actual draft commit; native replay and changed-input refusal;
uppercase UUID matching; and stale-money whole-graph rollback. A separate
uncommitted dependency integration must positively settle the discounted first
purchase and activate its subscription and lifecycle. Existing commercial
engines, acceptance helpers, browser boundary and lower persistence remain.

Risk: an application can still bypass this opt-in transaction adapter using the
lower writer or SQL credentials. Host mounting and authorization are required.
Existing-definition locks do not add a schedule-insertion protocol. The complete
current promise is compared rather than only initial money or its revision.
Eligibility facts are not recognition, login, contact merge or access authority.

Proof plan and execution: every heavy stage and container goes through the shared
focused gate. Use distributed Node 24.21.0/npm 11.19.0, local locked tarballs, an
isolated selected-peer consumer, the installed packaged migration runner, all
installer bindings declared first, an own labelled/tmpfs container and host TCP
readiness. Runtime operations use the named non-superuser/non-bypass login;
installer-only fixture arrangement and observational reads are distinguished.

Nine real PostgreSQL cases pass on the final leaf within the focused suite
(18.95 s suite total, 11.61 s own file). Measured bodies: 9.93, 20.02, 31.69,
25.54, 40.10, 9.24, 129.74, 24.29 and 102.97 ms. None approaches 5 s; the existing 10 s case bound is sufficient, so no
explicit per-case timeout is needed. Shared setup/teardown bounds remain
600,000/45,000 ms. The prior nine-case run's maximum was 102.06 ms.
The initial full lint found one cross-module deep import introduced by module
co-location. It now uses the existing promotions entry; scoped lint confirms the
repair. The final mandatory full lint passes with zero errors. Whole-tree
typechecking found three new test-only capability generic errors; using the
existing request contract and explicit extension, without an as-never option
cast, closes them. The final five-project recheck has zero diagnostics. Paid-
family tests now directly include absent-terms semantic and saved-ID grants,
alongside ordinary returning admission without acquisition capability/policy.
The added replay race failed before the key-order repair and passes afterward,
including padded keys, a concurrent pause, fresh-factory/fresh-process replay
and uppercase purchaser IDs. All refusal witnesses retain full graph snapshots.

Final local checks on frozen production/test inputs:

- `npm run lint`: PASS, 0 errors / 33 existing warnings, 30.15 s; includes strict
  core/outbox/platform builds, file-wide-ignore guard and eight ast-grep rule tests.
- Built dist exports/boundaries, package boundaries, incumbent native persistence,
  promotions/acquisition regression and the nine installed PostgreSQL cases:
  27 files / 3,135 tests PASS, 18.95 s. Declarations were rebuilt first.
- `npm run oss:published-tree -- --typecheck`: all five projects PASS, zero
  unresolved edges and zero consumer diagnostics, 25.78 s.
- Final complete `scripts/*.test.ts`: 58 files, 53 PASS / 4 unchanged-base failures /
  1 existing external-configuration skip; 1,254 passing assertions, 16 identical
  inherited failures, 1 skip, 121.47 s. No new failure; exact comparison retained.
- Publication policy/documentation ownership and regenerated navigation PASS.
  Neutrality: 7,072 text / 57 binary inputs, 0 increases; UI gate zero hits.
- Focused ast-grep, staged/unstaged whitespace and canonical all-ref/staged
  gitleaks PASS. All-ref scan: 1,865 commits / 90.57 MB, 10.5 s, zero leaks.
- Final real pack: prepack strict build PASS, 5.92 s; API snapshot check PASS.
  All 3,052 packed file bytes, including rebuilt dist, matched the accepted read
  candidate before this host-obligation prose clarification.

These are local task checks, not native review, canonical verification or a
release/adoption receipt. The four inherited scanner failures are not waived.

Scanner baseline: all four previously failing files were executed on a detached,
clean unchanged base checkout. Exact failure messages and assertion identities
match the leaf; the scratch checkout was removed after retaining JSON evidence.
No leaf path changes their controls, registry or SQL.

| Scanner file | Unchanged-base result | Cause |
| --- | --- | --- |
| `scripts/qualified-migration-admission.test.ts` | 16 identical failed assertions, 8 pass | Existing native-store feature binding and slot inventories disagree. |
| `scripts/reviewed-batch-forward.test.ts` | Identical collection error | Same inventory reader refusal. |
| `scripts/reviewed-native-store-forward.test.ts` | Identical collection error | Same inventory reader refusal. |
| `scripts/source-preview-release.test.ts` | Identical collection error | Same inventory reader refusal. |

The named error is `reviewed native store feature path, order or inventory drifted`.
The affected feature/declared function counts are 5/4, 8/1 and 4/1. These inherited
control failures belong to the predecessor chain; this leaf does not repair or
waive them. One existing scanner suite requires external database configuration
and remains skipped under the repository's own condition.

The accepted read candidate's package measurement uses distributed Node
24.21.0/npm 11.19.0 and the actual `npm pack` prepack strict build, measured with
the canonical size policy. This commit continuation changes only README/task
prose relative to that candidate; it does not repeat the pack or runtime proofs.

| Measurement | Unchanged base | Final candidate | Delta |
| --- | ---: | ---: | ---: |
| Packed B | 2,478,838 | 2,483,829 | +4,991 |
| Code-class gzip B | 1,977,514 | 1,982,093 | +4,579 |
| Docs gzip B | 66,050 | 66,856 | +806 |
| Unpacked B | 11,664,002 | 11,683,727 | +19,725 |
| Files | 3,052 | 3,052 | 0 |

Upper forecasts were +7,000 packed B and +3,500 code B. Recorded code exceeds its forecast
by 1,079 B; packed is within forecast. Both inherited maxima pass, leaving 72,365
code B and 1,171 packed B. There is no packed crossing. Compared with the prior
shape, the final implementation saves 159 packed B and 63 code B after adding
the replay repair and documentation. All non-dist packed inputs matched the
accepted read candidate. Artifact SHA-256:
`259b2a7cc3d842a5b727fd97b4edf4000f0664c6593e4a6657b1d6728a15d719`.
The base, original feature, interim simplified and final artifacts/measurements
are retained in this task's ignored scratch evidence; the authoritative final
artifact is in `r1dpkg-final-checked-pack`. No clean delivery stamp
or native verification is claimed.

The original brief used a stale code cap; the first correction established the
inherited code maximum 2,054,458 B and packed maximum 2,485,000 B. A later stop
at +4,642 code B was a forecast overshoot, not a cap crossing. The supervisor
explicitly instructed continuation and judgement of that cost at the API read.
That read accepted the recorded cost for the local DCO commit. Inherited scanner
failures remain recorded; the final integrated candidate must rerun the scanner
set at its assigned base.
No release gate, cap or forecast was edited here.

The requested size inspection ran from 20:39:12 to 20:54:16 UTC (15 min 4 s).
Co-locating the two additions with their existing owners removed six shipped
files and a barrel cycle. Reusing the existing scalar reader and offer-policy
constant saved 268 packed B and 155 code B before the replay repair. Narrower
term comparisons and active-only reads were rejected because they lose required
refusals; no new transaction/query dependency was justified. The key-order repair
reuses the native lock identity and normalized schema rather than a new protocol.
Final honest pack measurement includes that repair and owner documentation.

Positive dependency integration: an uncommitted scratch merge includes the
settlement privilege closer. Ten conflicts were resolved: unioned catalogue and
migration lists/projections, with base bytes retained for unrelated qualification
tests that were not executed or claimed. The merged selected-profile inventory
pin was stale and correctly refused. Its replacement was measured from the real
canonical live payload in scratch only, then the original fixture and default
projector were restored. The final installed runner passes apply/status with
that actual merged inventory; no fabricated digest or bypass is used.

The restricted runtime positively settles a 760-unit discounted order (240-unit
claim), redeems the claim exactly once, activates an active subscription with a
paid first cycle and one activation event, and replays without another event.
Result: 1/1 PASS, 11.64 s total / 10.75 s file, 51.47 ms case body. No settlement
refusal pin is carried by the leaf. An initial replay assertion incorrectly
expected its documented replay flag to remain false; only that scratch assertion
was corrected. Runtime payment/activation writes were unchanged. Read-only claim
event observation uses the fixture owner; all purchase, settlement, declaration
and activation operations use the restricted runtime without role switching.
No full qualification matrix, retained second-cycle/graduation interface or
browser journey is claimed by this bounded package proof.

The exact uncommitted merged patch/tree and normal-run JSON are retained in
ignored evidence. The scratch worktree and extracted source copies were moved
under this task's ignored scratch `node_modules` directory before lint, avoiding
linting disposable duplicate packages. No scratch merge entered this leaf.

Failed attempts and regroup: one PATH launch error consumed its allowed launch
retry. Two setup attempts refused an inside-checkout consumer and the wrong
no-peer isolation mode. The recorded rethink selected the existing selected-peer
isolation mode with a disposable external consumer and local locked tarballs.
Later fixture repairs honored column-level client INSERT privileges and the
inactive-by-default definition table; no refusal was relaxed. The replay
reproducer initially required the wrong direct blocker; it now observes the
retry backend's actual lock wait. The corrected pre-fix case fails replay and
the repaired case passes. A scratch test-file creation used an incorrect relative
path and selected no tests; it was corrected before runtime proof. No timeout/OOM
retry, native review cycle, session or receipt was created or reset. Initial build
gate wait was 369 s. Failed-attempt evidence remains in the same ignored directory.

Simplicity pre-check: one additive transaction adapter over the existing selector,
row lock and persistence is the smallest adequate alternative to a racy host
precheck. No second engine, quote store, phase table or new control was added.

Self-retro: separating modules added package bytes and a needless barrel cycle;
placing additions with their existing owners reduced both. The bounded inspection
also found a real replay race: acquire the existing key lock before checking a
receipt, and test a retry already waiting while an offer writer queues. Fixture
column-grant and activation-default assumptions caused earlier avoidable runs.
Forecast overshoot and inherited cap failure must remain distinct evidence.

<!-- openlup-task-doc-impact {"unit":"tests","doc":"CONTRIBUTING.md","anchor":"#development-preview-checks","digest":"sha256-9be7a9b8d33b372ca9efd117a5d31206f95263f6cfd440dec582dd19972bea59","reason":"The added installed PostgreSQL witnesses follow the existing isolated-consumer, restricted-role, transaction/replay and deterministic-fixture guidance. They add no test command, selection, control, privilege or global timeout. The recorded setup repairs and measured case times preserve that guidance. Inherited scanner failures are established on a clean unchanged base rather than waived or repaired here."} -->
