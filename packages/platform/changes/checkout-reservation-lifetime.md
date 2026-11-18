Next minor release: add optional `CheckoutReservationLifetimePolicy` to
`reservationPolicyFor` and `normalizedTtlMinutes` in the stable inventory subpath.
Positive integer bounds up to 5270400 minutes (ten years) must satisfy `minMinutes <= defaultMinutes <= maxMinutes`;
each call refuses invalid policy with `reservation_policy_invalid`. Omission
preserves the 1440–2160-minute clamp and 1440-minute fallback exactly.

Calculated expiry is persisted when a purchase reservation is created. Policy
changes do not rewrite stored expiry; matching replay retains the original
command expiry, reservation identity and current status. Native SQL still
requires finite future expiry for fresh holds, with its existing 30-minute
fallback for null. No SQL, starter composition or existing reservation changes.

Migration: no change is required. Before:
`reservationPolicyFor(input)` and `normalizedTtlMinutes(value)`. After:
`reservationPolicyFor(input, policy?)` and `normalizedTtlMinutes(value, policy?)`
with optional `CheckoutReservationLifetimePolicy`; existing calls keep the same
results. To configure, pass `{ minMinutes, maxMinutes, defaultMinutes }`, for
example `{ minMinutes: 1440, maxMinutes: 2160, defaultMinutes: 1440 }` for the
current behaviour.
