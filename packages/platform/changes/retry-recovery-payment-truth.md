- Apply retry recovery effects only after payment truth confirms an applied
  captured settlement. Captures retained for review keep their evidence without
  advancing the renewal counter, restoring stock or recording paid recovery.
- Return `payment_failed` for non-paid recovery readback; the retry driver reports
  a row error for reconciliation. Exact evidence redelivery remains idempotent;
  genuinely paid recovery and its stored receipts retain their behavior.

Migration: install `20261106060000_subscription_retry_recovery_truth.sql` before selecting the updated retry
adapter. Treat a non-paid recovery result as unresolved payment evidence and
inspect its payment-truth review record; do not synthesize settlement or retry a
charge from that result. Existing paid recovery receipts continue to replay.

Historical recovery receipts are checked against payment truth before replay.
Previously misapplied counter or stock changes require reconciliation; this
forward preserves those historical rows instead of reversing them automatically.
