- Fixed a native PostgreSQL renewal defect affecting Platform 1.3.0. An accepted subscription edit could leave a prebuilt snapshot eligible for first claim, allowing renewal at the previous amount. First claim now refuses stale snapshots, and the mounted renewal pass rebuilds the still-due occurrence from accepted terms.

Migration:

- Pause and drain renewal and retry dispatch before applying the bundled native PostgreSQL forward. Run the read-only report in the database upgrade guide and reconcile the reported operation IDs before resuming affected work.
- Custom workers receiving `22023` / `subscription_renewal_snapshot_stale` on first claim should re-read the due subscription and rebuild its snapshot. If preparation refuses an occupied operation as stale, use the report and upgrade guide to reconcile its existing obligation.
