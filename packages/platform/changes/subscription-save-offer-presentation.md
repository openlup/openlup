- Export the experimental `SubscriptionSaveOfferPresentation` type from
  `@openlup/platform/subscriptions/contracts`. A direct cancellation command
  can omit the survey and save offer and send a null reason.

- The native subscription command binding can prepare cancellation feedback
  after receipt lookup. This lets a starter discard stale feedback on a fresh
  cancellation and replay the original request after its settings change.
