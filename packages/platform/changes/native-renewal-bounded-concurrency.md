For the next 1.x release. Adds an optional bounded `concurrency` option
(default `1`, max `16`) to `runRenewalBatchRows` and
`createNativeSubscriptionBinding` in `@openlup/platform/subscriptions` so hosts
can overlap provider RTT across normal due renewals within a batch while
preserving deterministic result ordering, per-row error isolation, `55P03`
busy omission, and monotonic cycle advancement.

Migration: No action required. Existing callers keep sequential `concurrency: 1`
execution by default. Passing `concurrency > 1` to
`createNativeSubscriptionBinding` requires a pool-backed executor and fails
closed with `subscription_renewal_concurrency_requires_pool` if given a single
`PoolClient`.
