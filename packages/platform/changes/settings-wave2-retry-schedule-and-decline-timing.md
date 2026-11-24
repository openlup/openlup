### Install subscription retry schedule and payment decline notice timing policies

Promoted `subscriptions.retrySchedule` (`subscription_retry_schedule`, default
`[24, 72, 168]` hours, strictly 3 positive integers `1..2147483647`) and
`payments.declineNoticeTiming` (`payment_decline_notice_timing`, default
`delayMinutes: 3` (`0..1440`) and `linkLifetimeHours: 24` (`1..168`)) from `cap`
to `installed` in the packaged settings catalogue, wired their SQL readers in
`openlup settings`, and exported experimental SQL-parity validation, install,
and read helpers from `@openlup/platform/subscriptions` and
`@openlup/platform/payments`.

Migration: Platform SQL migration
`20261126020000_settings_wave2_retry_schedule_and_decline_timing.sql` installs
strict JSONB validators and fail-closed `commerce_settings` readers for both
policies, updates 3-argument `public.subscription_retry_apply_failure(uuid,text,jsonb)`
to forward `public.subscription_retry_schedule_read()`, and updates 12-argument
`public.payment_provider_result_apply(text,uuid,uuid,text,timestamptz,text,text,text,text,text,text,jsonb)`
to fall back to `public.subscription_retry_schedule_read()` when `p_cadence` is
`NULL` (while preserving explicit `p_cadence` precedence) and to read
`public.payment_decline_notice_timing_read()` for one-time recoverable decline
notices and recovery link expiration.
