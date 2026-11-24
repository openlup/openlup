### Install method expiry warning and promotion claim hold policies

Added `installed` policy entries `payment_method_expiry_warning_days` (default
`30` days, `1..365`) and `promotion_claim_hold_hours` (default `24` hours,
`1..720`) to the packaged settings catalogue, wired their SQL readers in
`openlup settings`, and exported experimental SQL-parity validation, install,
and read helpers from `@openlup/platform/payments` and
`@openlup/platform/promotions`.

Migration: Platform SQL migration
`20261126010000_settings_wave1_method_expiry_and_claim_hold.sql` installs strict
JSONB validators and fail-closed `commerce_settings` readers for both policies,
and updates `public.subscription_method_health_read(uuid)` and
`public.commerce_create_promoted_order_draft_with_outbox(text,jsonb,jsonb,uuid)`
to read the installed thresholds with unchanged 30-day and 24-hour absence
fallbacks and fail-closed `22023` refusals on malformed rows.
