- Fence provider-command initiation against both native and operator parcel cancellation with a shared/exclusive transactional advisory gate. Exclude cancelled parcels before the claim limit and recheck after locking, preserving queued records and live-parcel ordering, replay and submission during address changes.

Migration:

Install the complete selected native prefix through `20261110155000_fulfillment_parcel_status_fence.sql`, including its operator-transaction predecessor. Both cancellations take the dedicated parcel gate exclusively; enqueue, claim and submission share it. Enqueue retains its original parcel lock; claim and submission add none. Cancelled parcels refuse enqueue/submission with the existing command-fence conflict, and claim skips them. Function headers, owner and ACL remain unchanged. The locks cover ledger transitions, not the provider call; cancellation keeps its existing in-flight-effect guards. Outcome recording and provider behavior are unchanged.

The two cancellation routines and provider-command enqueue, claim and submission require READ COMMITTED isolation.
