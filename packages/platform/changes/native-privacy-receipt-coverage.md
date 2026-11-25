- Native erasure retries verify required contributor coverage before returning
  the original receipt. An uncovered receipt returns
  `PRIVACY_RECEIPT_COVERAGE_INCOMPLETE` with HTTP 503. Use
  `reconcilePostgresPrivacyErasure` from an owner session to record one
  verified contributor disposition with its approval. A foreign or conflicting
  binding returns `PRIVACY_RECONCILIATION_APPROVAL_UNVERIFIED`.

  Migration: Implement `findErasureReplay` on native privacy stores and
  forward it on the held transaction with `readRequiredContributorIds`.
  Update strict clients for the added coverage refusal and four governed facts.
  Apply the complete native catalogue and recapture older stores after upgrading
  within the same profile. Reopen native privacy traffic only after both parts
  and the per-store cutover.
