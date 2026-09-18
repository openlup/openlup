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
