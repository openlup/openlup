- Fixed a billing defect in the node-postgres renewal rail. In Platform 1.3.x, a v1 renewal snapshot built before an accepted bundle edit and first claimed after it could charge the pre-edit amount. In 1.4.0, version evidence that proves the snapshot stale causes a first claim to return `subscription_renewal_snapshot_stale`. Bare legacy claims without build-version evidence are admitted as before.

Migration:

- Follow the renewal checklist in the database upgrade guide. Pause and drain renewal and retry dispatch and template-edit acceptance before the forward. Run the read-only report and reconcile the listed work. Immediately before resuming dispatch, confirm that no row lists a reason other than `provider_state_open_after_cancellation`. Custom legacy callers claim through the shipped legacy adapter or build and claim under one subscription lock. Re-read and rebuild on `subscription_renewal_snapshot_stale`.
