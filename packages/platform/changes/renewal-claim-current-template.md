- Fixed a renewal billing defect in the node-postgres renewal rail. In Platform 1.3.x, when a v1 renewal snapshot was built before an accepted bundle edit and first claimed after that edit, the renewal could charge the pre-edit amount. Platform 1.4.0 refuses the stale snapshot on first claim with `subscription_renewal_snapshot_stale`, and the next renewal pass recovers on the accepted lines and amount.

Migration:

- Pause and drain renewal and retry dispatch before applying the bundled native PostgreSQL forward. Run the read-only report in the database upgrade guide and reconcile the reported operation IDs before resuming affected work.
- Custom workers receiving `22023` / `subscription_renewal_snapshot_stale` on first claim should re-read the due subscription and rebuild its snapshot. If preparation refuses an occupied operation as stale, use the report and upgrade guide to reconcile its existing obligation.
