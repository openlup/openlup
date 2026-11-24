### Install operator slide max days and edit quote TTL policies

Promoted `account_support_operator_slide_max_days` (default `60` days, integer
`3..365`) and `subscription_edit_quote_ttl_minutes` (default `15` minutes,
integer `1..1440`) as `installed` entries in the packaged settings catalogue,
wired their SQL readers in `openlup settings`, added optional `quoteTtlMinutes`
(default `15`, validated integer `1..1440`) to `PackageEditorOptions` and
`SizedEditorOptions`, and exported experimental SQL-parity validation, install,
and read helpers from `@openlup/platform/account-support` and
`@openlup/platform/subscriptions`.

Migration: Platform SQL migration
`20261126030000_settings_wave3a_operator_slide_and_quote_ttl.sql` installs
strict JSONB validators and fail-closed `commerce_settings` readers for both
policies, updates
`public.customer_support_apply_subscription_action_v1(uuid,uuid,text,jsonb,integer,text,timestamptz)`
to read `public.account_support_operator_slide_max_days_read()`, updates
`public.customer_subscription_preview_bundle_as_actor(uuid,text,jsonb,jsonb,jsonb,integer,integer)`
and
`public.subscription_command_preview(uuid,uuid,text,uuid,text,jsonb,timestamptz)`
to read `public.subscription_edit_quote_ttl_minutes_read()` consistently for
both `quote_hash` and `expires_at` while failing closed on malformed policy rows,
and revokes public execution while granting `EXECUTE` on the helper functions to
`service_role`.
