Export `MAX_CADENCE_DAYS = 3660` from the existing browser-shareable
`@openlup/core/subscription` contract for platform cadence DTOs. This whole-day
representation bound (ten years) avoids timestamp and settlement integer
overflows admitted by the former PostgreSQL integer maximum, with lateness margin.
Applications continue to own offered cadences.

Migration: platform DTOs and fresh editor requests above 3660 days now refuse.
Completed editor receipts retain replay before current limits. Existing SQL and
starter guards still refuse cadences above 90 pending a separate migration.
