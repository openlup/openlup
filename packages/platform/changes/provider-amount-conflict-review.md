- Successful readbacks from `@openlup/platform/payments/tpay` and verified
  webhooks from `@openlup/platform/payments/stripe` require review when payment
  amounts conflict. Checkout recovery and verify-now return manual review, and
  native renewal waits for provider evidence.
  For a refused webhook, the 409 response and the host's operational-event
  recorder carry the conflicting amounts and currency. The native binding
  defaults to a no-op and the managed binding uses the configured recorder.
  The provider retains and redelivers the original event. OpenLup keeps no
  durable review record for a refused webhook, as in 1.2.0. Receipts completed
  under released versions acknowledge as before.
