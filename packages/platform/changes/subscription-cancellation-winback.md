- Add an explicitly selected native winback worker with subscription-wide send
  deduplication, configurable cancellation age and retention consent, failed-send
  retry and durable receipt recovery.

Migration: apply `20261106140000_subscriber_winback_policy.sql` through the
complete selected catalogue before composing `createPostgresSubscriptionWinback`.
Provide the existing delivery rail and localized account-link binding. Configure
`subscriber_winback_policy` explicitly; omitted fields retain consent required
and the inclusive 14-day / exclusive 120-day window. Account consent capture and
charge-confirmed reactivation remain host composition.
