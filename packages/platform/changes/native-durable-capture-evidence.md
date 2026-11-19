- Native PostgreSQL provider settlement requires durable evidence for the active
  attempt with the matching received amount and currency. Verified late captures
  on cancelled or expired orders are retained for manual review. Exact replays
  of completed results remain valid.

Migration: Apply the ordered PostgreSQL catalogue through
`20261123149000_native_durable_capture_evidence.sql` and update the payment
runtime together. Custom reconciliation callers send the observed amount,
currency and capture basis in the normalized readback. Existing checkout
compositions can use the native rail's `captureReviewRequired` attempt
projection or the reconciliation port's equivalent read.
