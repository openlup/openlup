For the next 1.x release. Adds an optional 3-rung `p_cadence` parameter
(`{"backoffHours":[h1,h2,h3]}`) to `public.payment_provider_result_apply`
(forward `20261124140000_native_provider_retry_cadence.sql`) and optional
`retryCadence?: { readonly backoffHours: readonly number[] }` to
`PostgresPaymentTruthOptions` (`createPostgresProviderPaymentControlPort`),
bringing provider-recorded renewal failure timing into parity with
`subscription_retry_apply_failure` while preserving default `[24, 72, 168]`
timing, immutable receipt replay, and the 3-rung (`retry_attempt >= 4`)
exhaustion invariant.

Migration: Apply `20261124140000_native_provider_retry_cadence.sql` before
passing `retryCadence` to `createPostgresProviderPaymentControlPort`. Existing
callers that omit `retryCadence` continue invoking the 11-argument overload with
default `[24, 72, 168]` hours.
