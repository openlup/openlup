# Public CI diagnostic obligations

Status: fresh narrowed-tree measurement pending; this intermediate implementation
record claims no full-suite result. Tests retain raw failing exits.
Audience: contributors triaging development-preview public tests.

Decision and triage owner: OpenLup maintainer. Repair contributors are assigned
through the relevant follow-up scope; no named person's commitment is invented.

## Measurement scope

The independent `test-full` job selects all shipped root Vitest projects. The
`pgtap` job selects all shipped managed SQL tests against the committed baseline
and ordered forwards. Required-main coverage remains enforced separately.
The broad repair candidate's earlier counts are not measurements of this narrowed
tree. A fresh record will name every failing or aborted file, reason and incomplete
obligation before delivery, without an executable exception list or failure budget.

## Admission distinction

Historical assertion failures, collection errors and SQL aborts remain raw red
and are assigned an accountable triage owner. Selection alone does not mean every
assertion executed. Failed installation, start/replay/cleanup, missing dependencies,
zero discovery, incomplete evidence and unexplained changed failures block this
contribution. Required-admission success cannot be described as all tests passed.

See the [bounded implementation plan](public-ci-completeness.md) and
[contribution checks](../../../CONTRIBUTING.md#development-preview-checks).
