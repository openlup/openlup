If your legacy cart reminder job runs under its own database role, run this
grant as the database owner once after applying the reminder episode pin
migration. Replace `cart_runtime` with the role that runs the job.

```sql
GRANT EXECUTE ON FUNCTION public.commerce_enqueue_abandoned_cart_reminder_episodes(integer) TO cart_runtime;
```

The job reports `checkout_recovery_cart_runtime_grant_required` and supplies
the command for its role if the grant is missing. The built-in runtime role
already has the grant.
