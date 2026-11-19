Apply the reminder episode pin migration before using the updated producers.
A reminder episode keeps the timing it started with. Changes affect episodes
that create their first wave after the change.

Pending episodes with preexisting waves and no pin keep their current schedule
and can refuse an install with `checkout_recovery_schedule_change_blocked_open_episodes`.
Retry when the blocking orders close or their cart eligibility ends. Use
`READ COMMITTED` for changes and producers to avoid
`checkout_recovery_schedule_isolation_unsupported`.

On legacy profiles with a separately delegated cart producer, grant its
trusted runtime role EXECUTE on
`public.commerce_enqueue_abandoned_cart_reminder_episodes(integer)`. The
qualified service role receives the grant during migration.
