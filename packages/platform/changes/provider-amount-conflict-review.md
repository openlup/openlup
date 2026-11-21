Successful readbacks from `@openlup/platform/payments/tpay` and verified
webhooks from `@openlup/platform/payments/stripe` require review when payment
amounts conflict. Checkout recovery and verify-now return manual review, and
native renewal waits for provider evidence. Managed invoice preflight blocks
issuance when a successful readback reports conflicting amounts.

- Version 1.2.0 settled a `payment_intent.succeeded` webhook on the requested
  `amount` when it differed from `amount_received`. Version 1.3.0 routes those
  successes to review.
- On the native rail, receipts completed under released versions are
  acknowledged as before. The managed binding has no completed-receipt lookup.
  Redelivery of a conflicting success returns 409 and changes no payment state.
- Evidence is available in the 409 response and the original event the provider
  retains and redelivers. The host's operational-event recorder also receives
  the evidence. The native binding defaults to a no-op and the managed binding
  uses the configured recorder. OpenLup keeps no durable review record for a
  refused webhook.
