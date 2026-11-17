Bound fresh subscription quotes, order drafts and editor results to 1..3660
whole days (ten years), using the shared browser-shareable `MAX_CADENCE_DAYS`
export from `@openlup/core/subscription`. Adopters choose offered cadences in
owned configuration.

Checkout command/intent transport, resume, recovery and account reads, editor
contexts, retained renewal terms and frozen renewal snapshots keep PostgreSQL
integer representation bounds (1..2147483647). Editor and native draft
completed receipts replay before current limits; SQL ownership and fingerprint
checks still refuse changed payloads. Fresh edits also check the resulting
cadence when inherited from stored data. Classic historical price comparisons
use retained billing facts rather than submitting old cadences for a fresh quote.

Fresh native renewal snapshots and starter graduation above 3660 refuse with
`NativeRenewalCadenceError`, reason `cadence_limit_exceeded`, the observed value
and `maximumCadenceDays`; choose an executable cadence before starting a new
renewal. Historical frozen operations remain readable and replayable. Quantity,
revision and money bounds are unchanged.

Identity persistence admits fresh cadence before its writing RPC. Historical
completed retries authenticate a single read snapshot of the stored response and
the writer's canonical JSONB fingerprint, including the route-verified identity,
and refuse changed payloads without reopening the key. Fresh quote execution and unfinished resume writes
also admit cadence before dependencies; expired recreation checks both stored
cadences before provider I/O and returns `cadence_limit_exceeded`.

Fresh work is bounded at 1..3660 whole days. Replay of completed commands above
3660 is preserved on editor, native draft and renewal paths, but is not guaranteed
on the checkout-command and saga-fallback paths: checkout command execution
quotes before identity and draft replay, and `commercePaidOrderOrchestration`
re-quotes before draft replay when no quote is supplied. Those two paths remain
a follow-up. No published version admitted cadence above 120 days; PR4a's
widening is unreleased, so no released data can contain values above 3660.

Fresh subscription future-terms commands admit supplied cadence/plan days after
receipt replay and before host translation or native preview/apply dispatch,
so an out-of-range preview cannot persist a refusal receipt.

Migration: no SQL changes. Existing 90-day SQL guards and the starter's
`starter_database_cadence_limit` refusal above 90 remain pending a separate slice.
