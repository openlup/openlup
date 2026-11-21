### Fix starter return reason, retry minimum and settings schemas

Starter store configurations now use `damaged` instead of `damaged_item` for
return requests so database return creation accepts every configured reason.
`renewal.retryBackoffHours` now requires positive whole hours (`>= 1`) matching
native SQL validation and documents the separate fixed 24/72/168-hour provider
failure ladder (`subscriptions.retrySchedule`). `subscriptionOffers.deliveryCycles`
and `purchase.attemptLimits` now expose strict Zod schemas and updated effect
guidance in `owned/settings-host.ts`.

Upgrade replaces a pristine `shared/renewal-config.ts`. For customized
`owned/store.config.ts` or `owned/settings-host.ts`, replace `damaged_item`
with `damaged` and ensure every retry backoff hour is at least `1`. This
change requires no installed-policy step.
