# payment domain

Payment-control plane: intent/attempt/event lifecycle, provider-neutral method
refs, PSP webhook intake semantics, recovery-token redemption, and the
`PaymentExecutionPort` seam where PSP execution adapters plug in.
Provider-agnostic — local source of truth.

Terminal provider reconciliation is committed through the service-role
`commerce_payment_control_apply_reconciliation_result` boundary. It composes
the canonical payment-result transition, the existing subscription-owned
dunning decision, and reconciliation evidence in one database transaction;
provider readback and non-terminal evidence for both one-time and subscription
payments remain in the existing worker. Prepared attempts without a provider
ack stay indeterminate and never authorize dunning or a second charge merely
because execution threw. Automatic absence reopen remains subscription-only and
requires genuine provider-side absence proof: Stripe supports the guarded
intent-metadata search; Tpay/no-lookup attempts stay operator-manual.
Prepared claims have a bounded batch share, while the existing reconciliation
runs ledger rotates never/least-recently checked work so permanent ambiguous or
pending rows cannot starve finalized provider readback. The sequential worker
hard-caps each run at four attempts to fit the cron runtime when PSP calls use
their full timeout.

## Owns / does not own
- **Owns:** payment intent/attempt/event lifecycle, canonical
  `PaymentSession`, `PaymentExecutionPort` seam, provider-neutral method refs,
  PSP webhook/recovery contracts, hidden payment recovery redemption contracts.
- **Does not own:** PSP SDK calls (`server/infra/<provider>`), subscription
  retry/dunning policy, order fulfillment, invoicing.

## Stripe subscription recovery

The account recovery SetupIntent is a two-sided durable handshake, not payment
success. The browser receives only the short-lived `client_secret`; the signed
`setup_intent.succeeded` webhook persists the exact active subscription/case-bound
method ref, while owner-bound token redeem records customer authorization. Either
may arrive first. Only when both exist may subscription advance the existing
`retry_scheduled` cycle, and only a later payment-control success marks dunning
`recovered`. Generic redeem fails closed for expired `resume_subscription` because
the snapshot-aware resume RPC has no runtime caller.

## Public surface (import cross-domain ONLY these)
- `ports.ts` — `PaymentPort`, `PaymentExecutionPort`.
- `types.ts`, `paymentControlTypes.ts`, `methodRefs.ts` — sessions, method refs,
  attempt/intent/event statuses, `PaymentExecution*`.
- `recoveryContracts.ts` — hidden payment recovery redeem/resend contracts.
- `paymentFormContracts.ts` — `PaymentFormCopy`, `PaymentFormSettlement` and
  `RecoveryPaymentSetupFormCopy`, the words and outcomes the card payment UI in
  `src/checkout/adapters/stripe/` exchanges with its host.
- `paymentRecoveryClient.ts` — hidden customer-auth BFF client for recovery token redemption.
- `paymentControlTypes.ts`, `paymentStateMachine.ts` — compatibility shims to
  `@openlup/core/payment` for the neutral payment-control kernel.
- `providerAttemptIdempotency.ts` — openlup shim for the neutral
  `@openlup/core/payment` provider-attempt identity helper; it keeps the
  current `openlup:` namespace for byte-identical provider idempotency keys.
- `pspIntegrationPlan.ts`, `sandboxE2ESignoff.ts` — local PSP rollout/signoff
  evidence helpers.
- `stripePreviewPaymentProof.ts` — stricter Stripe-only accounting-preview
  payment proof contract. It validates the required hidden-preview payment
  evidence subset before later waves commit real `docs/evidence/stripe-sandbox-*`
  artifacts.

## Where the code lives
- Shared/frontend: `src/domains/payment/`
- Server (payment-control runtime ports, webhook/recovery handlers):
  `server/domains/payment/`.
- Provider infra: `server/infra/<stripe|tpay>/`.
- PSP execution adapters: `server/adapters/<stripe|tpay|noop_payment>/`.
- BFF/webhook routes: `server/bff/payment/webhooks/…`, exposed through
  `/api/bff/…`. There is no longer a separate legacy webhook tree.

Domain-boundary rules live in the maintainer canon `DOMAIN_ARCHITECTURE.md`,
which belongs to the private overlay and is not part of the published tree.

<!-- openlup-doc-impact {"unit":"domain-payment","digest":"sha256-48d85773d0a373f7294c4cded2a2a1eb6591bc2524a26f0aed66c3e7d6b54409","reason":"Comment-only delta. The payment status test and the payment ports name the status canon and the idempotency note by role instead of by a downstream document path. No payment status, port, idempotency rule, re-export or upgrade note described here changes."} -->

## Prepared-attempt package seam

The experimental [payments entry](../../../packages/platform/README.md#payments-prepared-attempts) contributes injected ordering and type-only adapter contracts. The reference facade remains unchanged; this source contribution does not activate a provider or establish durable-store parity.

The reference webhook handler now defaults to `require-evidence` for refunds: missing/null kind or required payment money/identity leaves the terminal result unapplied. Explicit full/partial evidence remains valid; a host may explicitly choose `legacy-assume-full`. The package ingress accepts snapshot, delta and full-reversal observations and preserves durable first-receipt time. Reference composition and its existing clock behavior stay unchanged until the later binding step.

## Repair and readback package seam

The reference verify BFF consumes `createCommercePaymentVerifyHandler` from the
payments package, retaining its responder and stored-owner validation before a
provider read. The status BFF maps the existing transient action carrier into
`PaymentRecoveryAction`, injects exactly its existing rail/handoff inventory,
and maps back to the unchanged response schema. The package checks the same
canonical attempt twice; it never accepts a browser outcome as payment truth.
The setup BFF wraps its existing host-owned callback in `PaymentRepairMethodPort`;
a ready result carries transient setup data only. Authentication, token/case
resolution, metadata, idempotency and redemption remain reference-owned.

A reference payment repair view follows in a separate change that settles its
customer-visible UI boundary. Verify never proves success; only stored paid
status does.
Native method setup is visibly unsupported unless the host supplies a collector
and confirmation implementation. This source composition establishes no new
profile route, provider activation or durable native method-setup capability.
