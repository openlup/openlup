- Native PostgreSQL provider settlement requires durable evidence for the active
  attempt with the matching received amount and currency. Verified late captures
  on cancelled or expired orders are retained for manual review. Exact replays
  of completed results remain valid.

Migration: Apply the ordered PostgreSQL catalogue through
`20261123149000_native_durable_capture_evidence.sql` and update the payment
runtime together. Custom adapters send the observed amount, currency and
`capturedAmountBasis: "provider_capture_v1"` in successful readbacks when
the amount comes from the provider's collected-money field. An absent basis
selects the 1.2.0 checks in worker, verify-now and checkout recovery for 1.x.
Strict readback validation is the 2.0 default. Native settlement continues
to require durable capture evidence. Existing checkout
compositions can use the native rail's `captureReviewRequired` attempt
projection or the reconciliation port's equivalent read.

Migration: Adopters who map invoice readback reasons should handle `provider_configured_amount_mismatch` with status `unknown` when configured money disagrees with the claim and the provider supplies no captured amount.
