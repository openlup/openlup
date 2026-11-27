- Native privacy reconciliation refuses invalid contributor dispositions with `PRIVACY_RECONCILIATION_APPROVAL_UNVERIFIED`. Erasure replay continues to report incomplete coverage until the owner successfully reconciles the missing contributor.

Migration: `unverifiedPrivacyReconciliationApproval()` gains an optional
`reason` parameter, so existing calls compile and behave as before. Before:
`unverifiedPrivacyReconciliationApproval(): PrivacyRefusal`. After:
`unverifiedPrivacyReconciliationApproval(reason?: "binding" | "disposition"): PrivacyRefusal`.
Omitting `reason` keeps the approval-binding refusal. Pass `"disposition"` when
a contributor's reconciliation disposition cannot be verified; the refusal keeps
the same code and carries disposition-specific recovery facts.
