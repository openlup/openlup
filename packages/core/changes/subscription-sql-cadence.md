Align the current source starter and reader guidance with `MAX_CADENCE_DAYS`
(1..3660 whole days), removing the former starter database refusal above 90.
Applications continue to choose their offered cadences.

Migration: apply the matching platform package's complete native catalogue,
including `20261122190000_subscription_cadence_bound.sql`, before using longer
cadences. This change is unreleased. Checkout-command and saga-fallback replay
of stored cadence above 3660 can still quote before replay; that unreleased
development-data case remains a follow-up.
