# Native invoice provider and owned history

Status: stabilized source candidate awaiting the public API read, 2026-11-01.
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
