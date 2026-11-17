Bound subscription cadence DTOs and fresh editor requests to 1..3660 whole days
(ten years), using the shared browser-shareable `MAX_CADENCE_DAYS` export from
`@openlup/core/subscription`. The former PostgreSQL integer maximum
admitted cadences that overflow timestamp and settlement integer arithmetic;
the finite bound leaves lateness margin and covers annual and multi-year plans.
Adopters continue to choose offered cadences in owned configuration.

Completed editor receipts replay before current limits, admission and pricing;
changed requests still conflict. Quantity, revision and money bounds are unchanged.

Migration: no SQL changes. Existing 90-day SQL guards and the starter's
`starter_database_cadence_limit` refusal above 90 remain pending a separate slice.
