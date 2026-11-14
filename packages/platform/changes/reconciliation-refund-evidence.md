Add the native PostgreSQL reconciliation port, atomic exact-attempt application,
attributed failure handoff, proof-backed absence reopen receipts and cumulative
refund evidence. Install the complete migration chain; absence auto-reopen stays
off, and immutable prepared dispatch receipts still require explicit due-reopen
consumption before later host execution.

Refunds preserve original settlement money, subscription service and paid-cycle
history. The native `commerce.order.refunded` event remains status-only;
financial customer messaging uses `commerce.order.refund_processed`, gated by
accepted same-currency evidence. Historical unattributed attempts and dunning
cases retain named refusal paths. Refund creation and provider activation are
outside this change.

A correlated failed webhook hands off dunning independently of its financial
result kind. If the direct result committed first, the handoff uses its original
attempt-bound failure receipt; duplicate delivery does not repeat money, retry
stages, recovery authority or notices.
