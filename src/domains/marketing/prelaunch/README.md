# Marketing Prelaunch Domain

Status: active

`marketing/prelaunch` is a read-model and orchestration boundary for pre-purchase
campaign work: waitlist leads, tester-program participation, product-test
feedback summaries, launch-invite targeting, and conversion readiness.

It does not own canonical client identity, consent state, email delivery,
feedback persistence, tester lifecycle mutations, fulfillment, or commerce order
reviews. Those remain in `clients`, `communications`, `feedback`,
`tester-program`, `fulfillment`, and `commerce`.

⚠️ `feedback`, `tester-program`, and the tester/waitlist modules of `clients`
are withheld by the deployment overlay and are not part of the published tree;
that acquisition programme is ended and its code is being retired. This read
model is published, but a published tree resolves it against lead and survey
evidence only - tester participation and admission are not available
capabilities there.

Waitlist records remain leads, not customers. The read model may expose source
attribution, locale, consent snapshots, pet snapshots, feedback summaries, and a
conversion prefill candidate, but customer creation must happen in an explicit
conversion flow outside this read-only boundary.
