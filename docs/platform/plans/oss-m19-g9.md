# Native invoice provider and owned history

Status: integrated development-preview candidate; delivery remains gated by
current native evidence and final verification, 2026-11-02.
Development preview; no publication, hosted or fiscal qualification is claimed.

## Outcome, scope and authority

Supply the captured invoice provider, owned account invoice history and artifact
reads for P20, R09, T04-03, T04-04, T07-07, A05, A11, A12 and A100. The split is
provider/receipt execution, ownership-authorized history/tickets, and installed
artifact/restricted-role proof. The account-documents query seam is supplied;
starter route composition remains with its host. No named read is dropped.

The store-promotion supervisor resumed this task with the lead's ruling: existing
code retains behaviour and constructor identity; missing named native readers
and writers are new native code replacing an unbound portable seam. This
supersedes the first run's unchanged-promotion-only stop. The managed rail must
remain unchanged. The worker owns only this row in `codex/oss-m19-g9` and its
assigned worktree. Local implementation, focused proof and independent review
are authorized. Commit/DCO waits for the stabilized API read; two fresh reviews
then precede verification readiness. Canonical verify and landing wait for the
lead's selected slot and applicable delegated delivery authority. Publication,
release dispatch, hosted resources, cost, credentials, production, adopter code
and other rows are excluded.

SQL, routines, grants and migrations belong to the separate database-writing
stream. This worker uses existing runtime permissions only and reports any
missing capability rather than adding database objects or privileges. Root
`server/**`/`src/**` changes are restricted to listed identity-preserving import
rewrites; none were needed or made. No re-export facade grant is assumed.
Shared manifests, API/catalogue and documentation receive only this row's
additions, without reformatting or reordering existing material.

Code base and current policy pin, re-fetched at handoff, are both
`bb0008481a11267ec6dbe3e7e531299777cddc19`. Current process owners are the
[agent guide](../AGENT_GUIDE.md),
[contribution rules](../../../CONTRIBUTING.md#instruction-freshness-and-handoffs)
and [AI contribution policy](../../../.github/AI_CONTRIBUTION_POLICY.md).

## Source check and implementation

Before the first edit, the matrix was confirmed: history/artifacts required host
binding; issue/renewal had an exported duty store and job but no captured provider
composition; invoice messages accepted a host account-documents URL. No matrix
correction was found. The initial stop was a scope interpretation, subsequently
replaced by the lead's implementation ruling; its evidence and zero consumed
native review cycles carry forward.

The new `@openlup/platform/invoicing/postgres` entry follows the existing
[package placement decision](../ARCHITECTURE_AND_EXTENSIONS.md#package-placement-decision-canonical).
It adds no package, dependency, driver discovery, scheduler or module graph edge.

- [Captured provider](../../../packages/platform/src/invoicing/postgres/captured.ts):
  explicit enabled/provider selection, full native identity and immutable-fact
  comparison, first-claim seller projection, parent/reason validation, and one
  append-only artifact observation per provider/create identity. Its receipt
  contains non-fiscal PDF bytes. A single insertion statement locks the duty and
  checks processing/preflight/lease state. Exact lookup precedes creation and
  recovery; concurrent calls and lost acknowledgement reuse the same receipt.
  Failed or incomplete lookup stays unknown. Remote void, fiscal clearance,
  arbitrary artifact persistence and non-PDF artifact kinds are unsupported.
- [Owned history](../../../packages/platform/src/invoicing/postgres/accountHistory.ts):
  joins authenticated `clients.principal_id` to `commerce_orders.client_id` in
  the document query. `accountRef` is a principal UUID, never a client UUID or
  an unauthenticated request-body claim. Output uses a safe field allowlist,
  stored currency, signed correction totals and parent document IDs. Pending and
  voided documents remain visible. Tickets repeat ownership, membership and
  eligibility checks. The host composes this port with the unchanged
  `createInvoiceAccess` membership gate before downloading bytes.

No existing implementation was moved or behaviour changed; no managed adapter,
root server/source, SQL, grant, migration or budget was edited. Existing native
store/job and account-access characterization witnesses remain unchanged.
Artifact-only ports require prior host authorization. These factories install no
route, real fiscal provider, email transport or jurisdictional policy.

## Acceptance and sufficient proof

Acceptance requires compiled public exports executed from an installed tarball,
real PostgreSQL through the qualified-v2 restricted runtime with success, refusal
and replay, unchanged affected witnesses green, export consumer registration,
measured package delta, API reading, two independent reviews and required final
verification/coverage. Local sandbox proof is not hosted/provider qualification.

The discriminating boundaries are full-identity receipt recovery without a second
capture, stored signed document lineage and ownership/membership before PDF I/O.
The main risk is confusing captured non-fiscal evidence with a real invoice or
letting an unowned order/document reach an artifact read.

Focused results on the stabilized implementation:

| Check | Evidence |
| --- | --- |
| Dependency installation | Node 24.21.0 / npm 11.19.0; lockfile unchanged |
| Strict package build | PASS via prelint/pretest builds |
| Structural scan and rule cases | PASS, including eight rule suites |
| `npm run lint` | PASS; zero errors, 33 warnings in unchanged files |
| `nativePostgres.test.ts` | 4/4 PASS, 260 ms; selected/disabled/foreign/error paths, replay, lost ACK, PDF validation, safe projection and membership |
| `invoicingCaptured.test.ts` | 1/1 PASS, 10.17 s final rerun; full qualified-v2 install/replay and physically installed tarball factories through NOSUPERUSER/NOBYPASSRLS runtime |
| PostgreSQL cases | Concurrent issue, exact replay, mismatched facts/key, unprepared no-write, durable readback, negative correction/parent lineage, foreign/client-ID refusal and owned/nonmember PDF tickets |
| Runtime permissions | Existing grants suffice; artifact-observation UPDATE and DELETE refuse with `42501`; no test-only grant |
| Published-tree typecheck | PASS; zero unresolved edges and zero consumer errors across all five projects |
| API snapshots | PASS, including the new subpath; existing snapshots unchanged |
| Package measurement | PASS: 2,102,771 → 2,114,848 packed bytes (+12,077); +45,799 unpacked bytes and +9 files; all existing caps pass |

The real pack measurement builds the assigned base from its Git archive and
packs both base and candidate with the pinned compiler/npm. Candidate code class:
1,820,387 bytes / 2,790 files; total: 9,855,301 unpacked bytes / 2,849 files.
No cap increase is proposed. Candidate tarball SHA-256:
`2923fe9a544220162be9f7192bd9d731ce1067476967d698cd8aa87eba66fbc6`.
This provisional dirty-candidate measurement does not replace canonical
clean-commit artifact proof. All measurement artifacts remain in task scratch.

No SQL dependency remains identified after executed proof. The provider uses the
existing SELECT/INSERT table grant, without calling the ungranted observation
RPC. Original store RPCs retain capture/facts/preflight/finalization/reversal.

## Documentation, history and remaining work

README, package reference and architecture describe the new selection, ownership,
lineage, refusals and non-fiscal limit. Catalog rows and the new API snapshot are
registered; navigation/context were regenerated. The policy checker accepts
package owner explanations, with two commit-bound no-impact trailers pending:

- `tests`: the new witness uses existing Node discovery, disposable PostgreSQL,
  qualified-v2 and restricted-runtime conventions; contribution-check guidance
  stays correct and no runner or fixture grant is added.
- `tooling`: only a driver-free subpath classification is added to the existing
  cold consumer; installation, execution and refusal rules are unchanged.

Final delta digests accompany the API read packet and must be included in the
first authorized commit. No policy PASS is claimed until those trailers exist.
The first policy attempt refused an untracked task record; staging fixed it.
Later catalogue sorting refusal was fixed by inserting only the new rows in
lexical positions. Strict build caught a widened format literal; typecheck caught
two missing paid-capture fixture fields. Both were repaired before the final
passing focused rerun. No mandatory gate was weakened or bypassed.

No commit/DCO, PR, counted review or canonical verify has run. Native repair
cycles consumed: zero; no review expiry clock has started. Remaining: required
API read, signed candidate with no-impact trailers, two fresh-context reviews,
full verification/coverage and the lead's landing slot. No stable-framework,
release, complete-store, live-provider or hosted result is claimed.

Simplicity pre-check for review: two structural-executor factories use the
existing append-only observation table and native store/claim protocol. Compose
through the existing account-access gate; no second ledger, artifact service,
new dependency, migration, scheduler or cross-module edge is needed.

Self-retro: the first resource request timed out after 542 s and its retry
admitted after 30 s; subsequent measured waits reached 273 s. Cheap strict checks
caught the literal and fixture defects before review. Removing a redundant
composition helper avoided a new module dependency while preserving membership
controls. Lesson: use existing composition and durable rails before adding seams.

Final staged whitespace check and staged gitleaks scan pass. A trailing blank
line found during final whitespace checking was removed and the real pack
measurement refreshed; implementation semantics and declarations did not change.

## Accepted API read and review candidate

The coordinator accepted the stabilized experimental public API packet for DCO
against base `bb0008481a11267ec6dbe3e7e531299777cddc19`, staged tree
`63c69be07e31358966be750c11ffef77c17a9d94` and cached-diff SHA-256
`a72a692b1530a47d8fdd14ff308abe5a5b281940524764a004ef50d26e10a013`.
The authorized condition adds only a restricted-runtime fiscal-clearance refusal
assertion to the existing PostgreSQL witness: clearance-required native facts,
an otherwise preflighted claim, `refused` / `blocked`, and zero observation writes.
The existing fixture accepts the facts flag; no new setup path, privilege or
production seam is introduced. All package inputs remain the accepted bytes, so
the measured package delta remains +12,077 packed bytes without a new pack.
The array-to-JSONB audit found no defect; SQL needs remain NONE.

The artifact is non-fiscal test output only and no fiscal claim is made. DCO
commit and two independent fresh-context native reviews are now authorized;
canonical verification and landing still await the lead's selected slot. Review
results and committed identities belong to the native session's ignored evidence,
so recording them does not alter the reviewed tree. The earlier pending-read and
uncommitted statuses above describe the packet handoff, before this acceptance.

The accepted condition passed in the real restricted-runtime PostgreSQL witness
(1/1, 9.46 s total). The structural scan, published-tree typecheck (zero unresolved
edges and consumer errors), lint (zero errors; 33 unchanged warnings), and staged
gitleaks all passed again. Policy regeneration changed no files; the signed
commit supplies the refreshed tests digest and unchanged tooling digest.
Self-retro for this continuation: the focused admission wait was 150 s. Reusing
the existing foreign-order fixture with clearance-required facts distinguished
the blocked path without new setup or permissions; no production repair was needed.

## Integration and focused proof round

The supervisor authorized a forced integration of current main
`38f60565d54fb7ec061f8e506b3c98a3c653a8bd` into the prior candidate
`1fdae5677a3aed6d7213253f816ce0055d11e8a0`. Current policy is read at that
main pin, separately from the original code base `bb0008481a11267ec6dbe3e7e531299777cddc19`.
Native prepare refused the pre-merge candidate because of conflicts. The
catalogue resolution inserts only this task's seven rows into main's exact
ordered catalogue. Main's package changelog is taken byte for byte; the captured
invoice note moves to the m19-g9-captured-invoices.md fragment
under the existing fragment convention, without a catalogue row. Automatic
cold-consumer and package-boundary merges preserve main plus exactly this task's
single entry, without reordering. This is manual integration, ordinary accounting.

A separate test-only commit replaces the installed-consumer witness's literal
environment access with the existing `node:process` environment import convention;
its environment values and runtime behaviour stay unchanged. No ratchet baseline,
control, SQL, grant, production behaviour or public API changes are authorized.
The artifact remains non-fiscal test output only; SQL needs remain NONE.

Required focused proof now includes neutrality, outcome projection, import-map,
package boundary, unchanged existing module-importing tests, cold-empty-cache and
normal-cache installed PostgreSQL witnesses, lint, strict typecheck, policy and a
fresh official-toolchain package measurement. Two fresh full reviews follow on
repair cycle 2 of 3. No canonical verification, push or pull request is authorized
in this round; the supervisor resumes delivery after the preceding landing.

Patch-ID evidence, excluding this task record: old-base-to-prior-candidate
`9bc4c6bcc1e5821314e911167dc830c00518adf4`; current-main-to-resolved-merge
`d61f81111daff391904ed10e845bf3ee65b5ae31`. They differ because the note moves
from the shared changelog into a fragment; no equal-patch or mechanical-integration
exemption is claimed. The inherited main migration has an end-of-file whitespace
warning against the old head; this task does not edit it, and its own delta is
checked against the new main instead.

Final current-main-to-candidate patch ID with the test-only environment fix,
excluding this task record: `bf20114cb1dbea41aebfc0b340c934d3ca571ae8`. The old-base patch ID above is
retained as historical evidence; the note move and environment import explain
the difference. Native source, API and constructor bytes remain unchanged from
the accepted implementation.

Focused results for this integration, on the official Node 24.21.0 / npm 11.19.0
toolchain: neutrality zero increases; projection/import-map 130/130; package
boundary 2,873/2,873; native provider unit 4/4; structural scan, lint and strict
published-tree typecheck PASS (zero errors/unresolved edges; 33 existing lint
warnings). The actual current-main assertion count is 130 rather than the older
123-case estimate. The installed consumer still packs only core, platform and
locked zod local tarballs. Empty offline cache and normal cache each pass the
full restricted-runtime PostgreSQL witness (15.33 s and 17.37 s total), with no
fixture grant or assertion change.

The following 34 existing import/caller test files ran unchanged from the merged
main, each separately, with PASS; PostgreSQL files use their own disposable
containers:

- `packages/platform/test/account-support/accountReadModels.test.ts`
- `packages/platform/test/account-support/invoiceAccess.test.ts`
- `packages/platform/test/account-support/portFit.test.ts`
- `packages/platform/test/invoicing/adapterConformance.test.ts`
- `packages/platform/test/invoicing/artifacts.test.ts`
- `packages/platform/test/invoicing/bindings.test.ts`
- `packages/platform/test/invoicing/canonicalLines.test.ts`
- `packages/platform/test/invoicing/continuity.test.ts`
- `packages/platform/test/invoicing/contracts.test.ts`
- `packages/platform/test/invoicing/delivery.test.ts`
- `packages/platform/test/invoicing/handoff.test.ts`
- `packages/platform/test/invoicing/issue.test.ts`
- `packages/platform/test/invoicing/paymentReadback.test.ts`
- `packages/platform/test/invoicing/portFit.test.ts`
- `packages/platform/test/invoicing/postgresStore.test.ts`
- `packages/platform/test/invoicing/readModel.test.ts`
- `packages/platform/test/invoicing/readback.test.ts`
- `packages/platform/test/invoicing/sellerRevision.test.ts`
- `packages/platform/test/invoicing/settlementSync.test.ts`
- the former documentation-impact suite
- `scripts/packages/platform-cold-consumer.test.ts`
- `scripts/packages/reference-delegation-consumer.test.ts`
- `server/domains/accounting/stripePayoutSettlementSync.test.ts`
- `server/runtime/public-reference/m09InvoicingBinding.test.ts`
- `tests/platform/catalog/m05Composition.test.ts`
- `tests/platform/channels/channelConsumer.test.ts`
- `tests/platform/inventory/inventoryConsumer.test.ts`
- `tests/postgres/invoicingContinuity.test.ts`
- `tests/postgres/invoicingDelivery.test.ts`
- `tests/postgres/invoicingManagedCorrection.test.ts`
- `tests/postgres/invoicingNativeConformance.test.ts`
- `tests/postgres/invoicingStoreContract.test.ts`
- `tests/postgres/nativeAccountReads.test.ts`
- `tests/postgres/partnerAcquisition.test.ts`

Fresh real platform pack: 2,358,480 packed bytes; 11,126,930 unpacked bytes;
2,949 files. Code class: 1,893,540 gzip bytes / 2,838 files. Docs class: 60,783
gzip bytes / 6 files. All current size budgets pass, without a budget change.
Tarball SHA-256: `aacacc63c863d0e768f3203ffc54d2cb30c91e636d76bc35e1ab2b0832ce7abc`.
This supersedes the old provisional pre-integration measurement above; final
clean-commit package proof and canonical verification retain their own gates.
Policy computes fresh tests/tooling no-impact trailers against the new base;
these belong on the single-parent test fix, not the merge commit. Review history
and repair counts remain append-only: cycle 1 contains the boundary-list repair;
this manual integration and test fix require fresh full review on cycle 2 of 3.

Self-retro: direct boundary, neutrality and empty-cache proof close the late
failure classes before another canonical run. Policy caught an inline reference
to the source-only fragment in this record; naming the fragment without a
catalogue-target path keeps the record accurate without adding a catalogue row.
No control, cap, SQL or production change was used to obtain passing proof.

## Final integration and delivery authority

The preceding preview landed during this round. Native prepare's common merge
preflight refused clean carry-over against current main
`e2461449849d3c6b0586a3c9043f550aa7ebabea`. A second forced merge, commit
`f6c3e473f2506d712def7274f31d28bcb45962eb`, needed no manual resolution;
its tree `15934e6563c32ef6ddb7e2be0401e0d4949de8ee` exactly equals Git's
predicted automatic merge tree. The patch IDs excluding this task record are
both `d7eeafcbed64e6673928b5b44e5f7217b2a6d825` before and after this merge.
The first merge's catalogue union and note move remain the only manual
resolutions. The environment import remains an isolated two-line test fix.

Current code/policy base is the full main SHA above. The supervisor now grants
canonical verification in the assigned slot, followed on success by branch push,
pull-request submission, native receipt posting and queueing. This supersedes the
prior round's stop-before-verification boundary. Main must still equal the merged
SHA before canonical verification; a later move is reported before another
manual repair cycle. Publication, release dispatch, production, settings, SQL,
privilege changes and other tasks remain excluded. The candidate requires two
fresh full reviews on cycle 2 of 3; the ordinary full route gives its own evidence
clock, with no inferred integration coverage or repair-budget reset.

Against the new main, neutrality again has zero increases; projection/import-map
passes 130/130; package boundary passes 2,873/2,873; the installed restricted-role
consumer passes once with a newly empty offline npm cache (14.03 s total).
Ast-grep, strict typecheck and lint pass; lint retains 33 unchanged warnings.
No platform package input or one of the 34 retained test files changed in the
new main. Their previous passing results and the normal-cache consumer result
stand. Documentation-impact tests were rerun because routing/catalogue inputs
changed: 101/101 pass. Policy regeneration reports four obligations, zero
unanswered; the existing test-fix commit's fresh tests/tooling trailers remain
applicable without another trailer-only commit.

The fresh second pack has the same SHA-256 and all measured bytes/files as the
first integration pack above. Against the lead's official main pack of 2,346,064
bytes (code class 1,882,746), the new totals mean +12,416 packed bytes and +10,794
code-class gzip bytes. No package or budget change came from the preview landing.
The early +12,077 provisional delta is historical and is superseded by this
official-toolchain result. Final clean-tree package proof and canonical verify
are still required; successful focused proof alone grants no hosted claim.

Self-retro: performing the second forced merge before reviewer launch lets one
fresh full review cover the entire final candidate, preserving the remaining
repair budget and exposing no unreviewed merge after its evidence clock starts.
