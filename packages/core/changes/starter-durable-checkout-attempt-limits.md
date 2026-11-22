### Keep default checkout attempt limits across starter restarts

Apply the checkout attempt ledger forward before upgrading application files or
starting the updated native starter. Use one PostgreSQL database per store and
the same limits in every process serving it. Older hosts can run with the
additive schema. The updated host starts counting in PostgreSQL without
importing old in-memory counters.

Apply the application file upgrade to replace pristine managed checkout hosts
and tests. If it reports a conflict, reconcile your customized checkout files
with the target starter before retrying. Keep custom quota callbacks and bind
the default callback to the held checkout session before the draft transaction.

In your owned settings host, update only the `purchase.attemptLimits` effect
description from the target starter and keep your bindings. In your owned copy,
apply the checkout quota wording in each locale and keep your other text.
If startup reports that the ledger is missing, apply the forward and restart.
If it reports missing EXECUTE, restore the runtime role's routine grant and
restart. For a failed readiness check, check connectivity and the runtime
credentials before restarting.
