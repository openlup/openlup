- `getOrCreateContinuationId` in `@openlup/platform/storefront` takes an optional per-call `storageFailure` policy and returns `ContinuationId | null`. By default it reads a newly minted record back once and returns `null`, so nothing may be sent, unless the record names the identity and fingerprint it just wrote; reuse and a write that throws read nothing back. `createPurchaseContinuation` keeps its statuses and still sends nothing when storage does not keep the record.

Migration: Hosts built from `main` that call `getOrCreateContinuationId` directly
now receive `ContinuationId | null`. Handle `null` by sending nothing and letting
the buyer try again once storage is available. To keep the earlier behaviour, which
continues with an identity its storage did not keep and can create a second order,
pass the deprecated `storageFailure: "continue_unpersisted"` and still narrow the
result, which includes `null` under every policy.
