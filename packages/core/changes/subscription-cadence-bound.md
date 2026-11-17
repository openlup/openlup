Export `MAX_CADENCE_DAYS = 3660` from the existing browser-shareable
`@openlup/core/subscription` contract for fresh platform cadence admission.
The ten-year whole-day limit avoids the timestamp and settlement integer
overflows admitted by the former PostgreSQL integer maximum, with lateness margin.
Applications continue to own offered cadences.

Migration: fresh quotes, drafts and editor results above 3660 days now refuse.
Historical transport, stored data and completed receipts keep their integer
representation. Completed editor, native draft and renewal receipts replay before
current limits; replay above 3660 is not guaranteed on checkout-command or
saga-fallback paths that quote before replay. No released data can contain such
values: no published version admitted cadence above 120, and PR4a's widening is
unreleased. Existing SQL and starter guards still refuse above 90 pending a
separate migration.
