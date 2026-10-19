export interface EmailHealthMetrics {
  attempted: number;
  sent: number;
  failed: number;
  delayed: number;
  /**
   * In-window rows that ended `status='failed'` — handler-final loss of a
   * customer notification (outbox discard / max-attempts). Distinct from
   * `failed` above, which also counts bounces/complaints/missed for the
   * ratio signal.
   */
  permanentFailures: number;
  /** `processing` rows whose last transition is older than the stuck threshold. */
  stuckProcessing: number;
  /** `planned`/`queued` rows past their `expected_send_at` but still not sent. */
  stuckScheduled: number;
}
