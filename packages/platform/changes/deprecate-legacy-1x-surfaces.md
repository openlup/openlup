For the next 1.x release. Adds JSDoc `@deprecated` notices to legacy 1.x
surfaces scheduled for removal or simplification in 2.0.0: the 11 experimental
payment reference-support exports under provider payment subpaths, the
7-generic `RenewalCyclePolicy` interface, `createFulfillmentCommandLedger`, and
the legacy hosted-bundle default in `DEFAULT_PLATFORM_BUNDLE`.

Defaulting Node hosts on `node-cron` bundles to `lockMode: "cluster"` is an
unscheduled candidate for 2.0.

Migration: no runtime or type changes in 1.x. Existing 1.x replacements
(`PaymentAdapter` / `PaymentProviderRegistry` from `@openlup/platform/payments/contracts`,
`createPaymentProviderRegistry` from `@openlup/platform/payments`,
`createDefaultRenewalCyclePolicy`, `createPostgresFulfillmentDispatchStore`,
and explicit `PLATFORM_BUNDLE`) are already available in 1.x.
