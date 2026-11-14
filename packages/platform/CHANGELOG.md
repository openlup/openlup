# Changelog

Notable changes to this public-source workspace package are recorded here.
“Unreleased” means no npm version carries the change yet; immutable OpenLup
source previews may already ship some changes, and their release notes say
which. Declaration snapshots track candidate drift, not a stable API or
SemVer promise. This file keeps the current release and the two previous ones;
earlier releases are recorded verbatim in `packages/platform/CHANGELOG-HISTORY.md`
in the source repository.

## [Unreleased]

## [0.42.0]

- Publishable on the npm `latest` dist-tag as `0.42.0`, from tag
  `openlup-platform-v0.42.0`.

- Add explicit native payment-method collection, reusable-reference storage, lifecycle delivery and recorded health, with scoped repair and recovery authority that freezes at dispatch. Historical mirrors are never promoted to charging evidence automatically. Retry admission and dispatch freeze bind the exact provider-method row and lock its recovery token through commit. Retry selection and preparation respect quarantine; real renewal/provider history cannot fall back to sandbox compatibility. Completed sandbox attachments with current sandbox terms preserve their lane when only the initial paid checkout used another channel; recorded references, including inactive rows, still select strict authority. Reminder production reads bounded method facts under runtime privileges; spent repair authority does not block later automatic rungs, and active expiring methods remain eligible for renewal reminders.

Migration: install the complete selected native chain through `20261114110000_payment_method_refs.sql` before composing collection or recorded-method readers. For host-composed native subscriptions without recorded refs and with real-provider history, retry, recovery, reactivation, auto-resume and upcoming reminders refuse or remain ineligible until the host records refs with `payment_method_ref_upsert` from verified evidence. Original renewal charging retains its previous method and mandate evidence behavior when no recorded reference exists, even with real-provider history. Once any reference row exists, every reader uses strict recorded authority, regardless of its status or active state. Account-support health follows the lifecycle classification even without a reference. Explicit sandbox subscriptions retain their behavior. Existing labels and token rows are not backfilled; obtain a new authorized token when recovery context is absent, select a host-authenticated setup lane and preserve outstanding retry authority. Setup callers must retain one trimmed 8–180 character idempotency key; formerly accepted short or oversized keys now refuse before ownership lookup or provider I/O.

- Correlate initial-order provider history before selecting sandbox compatibility; account health and lifecycle admission select strict authority for that history even without a reference. Original renewal evidence reads preserve their previous behavior until a reference is recorded; recorded rows in any state prevent fallback in every reader. Setup requests trim the key and enforce its 8–180 character contract before ownership lookup or provider I/O.

- Add native durable provider attempts, immutable verified ingress, replay receipts and separate payment identities. Preparation commits before provider execution; acknowledgement finalizes the same row, and unresolved or superseded attribution refuses before settlement effects.
- Add PostgreSQL persistence, webhook and recovery evidence factories. Enable only the prepared durable store capability; method setup, absence reopening and cumulative refund retain their existing limits. Historical rows are never reconstructed automatically.
- Record correlated provider renewal failures as immutable attempt-bound retry receipts before financial truth ingestion. Reuse one settlement transition and retain native obligation scheduling; provider dunning case, notice, token handoff and real renewal binding await later composition.
- Record an expiry after a decline on the same renewal attempt as a replay-safe escalation, retaining the existing failure receipt, retry stage and schedule.

Migration: install the complete selected native chain through `20261114100000_payment_provider_attempt_store.sql` before composing the ports. Hosts provide recorded provider authority and verified adapters. A refund does not pause or cancel a subscription; offline evidence does not activate a provider or a hosted journey.

Unpaid-order cancellation terminalizes provider payment authority. Recoverable
one-time and initial-subscription declines include a live checkout recovery
token in the delayed payment-failed notice. Inline response-loss replay reads
the durable transition without fresh method or purchase context.

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

- Add explicit card provider composition over native PostgreSQL payment, method-reference, reconciliation and retry owners. Prepared requests commit before dispatch; uncertain/replayed requests never dispatch again. Customer, client, order and save-card inputs and redacted finalization facts pass through the neutral factory additively.
- Bind timestamped verified ingress, immutable failure rungs, attributed dunning, recorded method replacement and evidence-gated cumulative refunds. Preserve provider time separately from first receipt; untimestamped card provider readback remains ambiguous.
- Validate addressed recorded-method authority before renewal dispatch, keep untimestamped native source/return carriers absent, replay finalized SCA refusals through the durable refusal owner, and acknowledge exact-attempt refusals for superseded or unresolved success events using their durable attribution, including unresolved redelivery after finalization.
- Keep default sandbox bindings and existing managed exports. The native rail supports the two reference payment providers; a third provider needs the provider-profile refactor. The supplied portable composition selects card provider only; live activation and the second reference provider's portable composition remain separate.

Migration: Install the complete native catalogue through `20261114120000_payment_reconciliation_refund_evidence.sql`, then explicitly compose the payment rail and renewal webhook/lifecycle/retry ports together. Historical method refs require owner-authorized registration; no automatic backfill is supplied. No SQL migration is added.

Known limits for the complete set: The native rail supports the two reference payment providers; a third provider needs the provider-profile refactor. The second reference provider's portable composition and the provider-profile refactor are deferred to a later set. Provider qualification is limited to fake-client proof; no live provider qualification is claimed. The starter still selects sandbox payments by default.

## [0.41.0]

- Publishable on the npm `latest` dist-tag as `0.41.0`, from tag
  `openlup-platform-v0.41.0`.

- Add the experimental `payments/testing` subpath with the existing conformance runner and a provider-neutral scripted transport fake. Optional safety fixtures exercise capability/refusal parity, network ambiguity, signed webhook replay, invalid money, partial amounts and chargebacks without live access. Existing adapter behavior and imports remain unchanged.
- Reserve the measured platform artifact budget for the next payments implementation part; individual feature rows share these caps.
Migration: `runPaymentAdapterConformance` now takes `readonly PaymentAdapterTestSubject[]`. That named type is the previous subject with its `verification` fixtures plus an optional `safety` member, so existing callers compile and run unchanged and need no action.

## [0.40.0]

- Publishable on the npm `latest` dist-tag as `0.40.0`, from tag
  `openlup-platform-v0.40.0`.

- Add experimental neutral ecommerce-event contracts, retained paid-time source snapshots and explicit PostgreSQL projection through the existing outbox. Paid orders, nonfinancial refund status, checkout qualification and subscription lifecycle facts keep source identities separate from delivery attempts.
- Extend `@openlup/platform/communications/klaviyo` with separately qualified events using the account's existing pacing and cooldown. Provider acceptance remains distinct from ingestion; pending scope, historical import and stale authority refuse before HTTP.
- Ship offline wiring recipes for transactional delivery, marketing refusals and frozen event replay. Local fixtures do not qualify provider accounts or activate any route, job or flow.

Migration: apply the complete packaged migration chain before composing the new projection. Select the fixed live cutoff, account/environment and mapping explicitly; register actual privacy/retention policy and preserve pending duties during recovery. Existing installations do not export events automatically.

Require the complete declared scope set for the opt-in marketing adapter's consent-push capability, including profile write permission. Missing evidence remains verification-pending before provider HTTP. Preserve the existing transport outcome contract and clarify host retry, delivery and adapter-selection responsibilities.

- Stop shipping `AGENT_CONTEXT.md`. Use core's `openlup-context` and the reader guide shipped in `@openlup/core`.
