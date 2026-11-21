### Find the invalid subscription offer member

`settings check` now reports the member and rule alongside
`starter_subscription_offer_invalid`. In
`subscriptionOffers.<mode>.days`, check `days` under `classic` or
`sized` in your owned store configuration. Correct the value and rerun
`settings check`.

Upgrade replaces a pristine `shared/subscription-offer.ts`. If apply
reports that the managed file has local edits, preserve those edits
separately, restore the file from the installed starter version, and rerun
apply. Reconcile your edits with the replacement before startup. This
upgrade requires no installed-policy step.
