# Trailer-only commit after a reviewed integration

Status: development-preview control task. This record contains neutral outcome,
scope and proof criteria for independent review. Its fresh-reviewer and expiry
conditions were superseded on 2026-11-05 by
[Native review](../../../CONTRIBUTING.md#native-review-and-accountability); the
trailer-only tip rule itself remains.

Outcome: recognize exactly one single-parent commit directly after an otherwise
qualifying two-parent integration merge when its tree equals the merge tree and
its message contains only a subject, one or more `OpenLup-Doc-Impact` trailer
lines and optional `Signed-off-by` lines. Inspect the complete raw message;
NUL or additional body text must not receive focused integration recognition.

Scope: native Git-object lineage capture, its existing decision boundary,
committed Git fixtures, publication inventory and the integration guidance in
CONTRIBUTING, documentation maintenance and both agent guides. Keep the actual
tip as `candidate.head`; normalize only parent evidence. The underlying merge
must still join the preceding reviewed head and the new main review base in
that order. Preserve two fresh reviewers, valid prior coverage, unchanged intent
and author, inherited expiry, findings, repair accounting and exact successful
`merge-tree` mechanical proof.

Exclusions: no documentation-answer or digest changes, merge commits as answers,
receipt format changes, package behavior or API changes, relaxed checks, release,
settings, credentials or production action. Nonqualifying tips use full review.

Authority and delivery: the maintainer's delegated coordinator authorized this
bounded control implementation and DCO subject to independent native review.
This worker implements and performs focused proof; canonical verification waits
for the stream supervisor's selection. This task stops at readiness for that
verification. No push, PR or queue action belongs to this continuation.

Comparison base and policy: `09cd599bfef6bff74f4431b0cf7a00ebf80f1e6a`.
Branch: `codex/oss-m19-integration-trailer`, in its assigned dedicated worktree.

Acceptance and sufficient proof: real Git objects must distinguish the valid
trailer tip from changed trees, multiple follow-ups, other trailers, extra body
text, NUL-hidden text, wrong merge parents, non-merge parents, merge-on-top and
changed author/intent. Include signature and encoding headers, extra headers and
continuations, CRLF and trailing whitespace. Verify, receipts and source/group
admission must bind the actual tip. Retain prior-coverage, expiry, findings and
cycle refusals. Run the applicable focused tests, ast-grep, lint, published-tree
policy/navigation and typecheck. Compare actual package packs against the base;
this control change must add no package bytes.

Risk: incorrect lineage or message classification could narrow inspection
without the required coverage. Parent evidence and complete raw message bytes
must be checked before applying the unchanged decision conditions.

Execution observations, review reports, counters and handoff state are retained
in local task evidence separately from this neutral candidate record. Fresh
reviewers receive approved criteria, exact source and open finding cards.
