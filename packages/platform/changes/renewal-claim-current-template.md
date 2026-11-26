- Fixed a billing defect in the node-postgres renewal rail. In Platform 1.3.x, a v1 renewal snapshot built before an accepted bundle edit and first claimed after it could charge the pre-edit amount. 1.4.0 refuses the stale snapshot (`subscription_renewal_snapshot_stale`), and the next renewal pass recovers on the accepted lines.

Migration:

- Follow the renewal checklist in the database upgrade guide. Pause and drain renewal and retry dispatch and template-edit acceptance before the forward. Run the read-only report and reconcile the listed work. Immediately before resuming dispatch, confirm that no row lists a reason other than `provider_state_open_after_cancellation`. Custom workers re-read and rebuild the snapshot on `subscription_renewal_snapshot_stale`.
