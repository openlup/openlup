- Fixed a billing defect in the node-postgres renewal rail. In Platform 1.3.x, a v1 renewal snapshot built before an accepted bundle edit and first claimed after it could charge the pre-edit amount. 1.4.0 refuses the stale snapshot (`subscription_renewal_snapshot_stale`), and the next renewal pass recovers on the accepted lines.

Migration:

- Follow the renewal checklist in the database upgrade guide: drain renewal and retry dispatch before the forward, then run the read-only report. Custom workers re-read and rebuild the snapshot on `subscription_renewal_snapshot_stale`.
