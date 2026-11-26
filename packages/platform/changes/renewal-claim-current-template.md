- Fixed a billing defect in the node-postgres renewal rail. In Platform 1.3.x, a v1 renewal snapshot built before an accepted bundle edit and first claimed after it could charge the pre-edit amount. 1.4.0 refuses the stale snapshot (`subscription_renewal_snapshot_stale`), and the next renewal pass recovers on the accepted lines.

Migration:

- Follow the renewal checklist in the database upgrade guide. Pause and drain renewal and retry dispatch and template-edit acceptance before the forward. Run the read-only report, reconcile every listed item, and confirm an empty rerun immediately before resuming dispatch. Custom workers re-read and rebuild the snapshot on `subscription_renewal_snapshot_stale`.
