Apply the reminder episode pin migration before using the updated producers.
A pinned episode retains its starting timing. A changed schedule supplies
timing for episodes whose first wave is created after the change.

Older episodes with preexisting waves and no pin read the live schedule
and can block changes with `checkout_recovery_schedule_change_blocked_open_episodes`.
See **Install reminder stages and hours** for the blocker conditions and
when to retry. Use
`READ COMMITTED` for changes and producers to avoid
`checkout_recovery_schedule_isolation_unsupported`.

If your legacy cart reminder job runs under its own database role, grant that
role EXECUTE on `public.commerce_enqueue_abandoned_cart_reminder_episodes(integer)`
once after applying the migration. If the grant is missing, the job reports
`checkout_recovery_cart_runtime_grant_required` with the exact command to run.
The built-in runtime role already has the grant.
