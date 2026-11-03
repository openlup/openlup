- Add the sandbox-only PostgreSQL payment simulator with durable active-attempt
  fencing and server-observation verification. Browser returns cannot pay an
  order. Captures after cancellation remain terminal operator-review truth;
  no order reopen, refund, real provider store or schedule-rule change is added.
  Requires the complete native chain through the sandbox-attempt forward.
- Preserve microseconds and canonical UTC timestamp identity across database
  sessions for simulator replay, its payment truth and native renewal snapshots.
  Invalid purchase timestamp facts continue to reject asynchronously.
