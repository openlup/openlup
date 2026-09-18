# Customer diagnostic observations

The closed v1 contract connects purchase/auth/account browser observations to
server-owned diagnostic segments. It carries no raw forms or arbitrary metadata.
Browser outcomes and related request references remain browser-reported evidence.

The dedicated ingest acknowledges only committed persistence. Operator search and
history use bounded queries and atomic retained access audits. The additive
`overview` read is available only through the explicit
`customer-diagnostic-history.v2` contract: it groups the selected global window by
stored coverage version and action, counts distinct action IDs, and returns up to
three classified segment examples per bucket. It keeps source health, window
coverage, evidence presence, pagination, and rate applicability as separate
fields. `conflicting_terminal`, `observation_gap`, and `terminalWithoutStart` are
overview classifications, not customer outcomes. Operational coverage, activation
requirements and interpretation live only in
`docs/platform/RUNTIME_AND_SELF_HOSTING.md#retained-customer-diagnostic-paths`.
