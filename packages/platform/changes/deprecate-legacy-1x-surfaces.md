For the next 1.x release. Adds JSDoc `@deprecated` notices to legacy 1.x
surfaces scheduled for removal or simplification in 2.0.0: the 11 experimental
payment reference-support exports under provider payment subpaths, the
7-generic `RenewalCyclePolicy` interface, `createFulfillmentCommandLedger`, and
the legacy hosted-bundle default in `DEFAULT_PLATFORM_BUNDLE`.

Migration: no runtime or type changes in 1.x. Existing 1.x replacements
(`PaymentAdapter` + `PaymentProviderRegistry`, `createDefaultRenewalCyclePolicy`,
`createPostgresFulfillmentDispatchStore`, explicit `PLATFORM_BUNDLE`, and
shared `{ pool }` / `SqlExecutor` factories) are already available in 1.x.
