### Install subscription reschedule time zone policy

Promoted `subscriptions.rescheduleTimeZone` (default `"UTC"`, valid IANA time
zone name) from `cap` to `installed` in the packaged settings catalogue, wired
its SQL reader in `openlup settings`, updated save-offer reschedule target
calculation in `postgresCommandStore` to evaluate calendar days in the
configured time zone, and exported experimental SQL-parity validation, install,
and read helpers from `@openlup/platform/subscriptions`.

Migration: Platform SQL migration
`20261129130002_settings_wave4a_reschedule_timezone.sql` installs strict JSONB
validator `public.subscription_reschedule_timezone_validate(jsonb)` and
fail-closed `commerce_settings` reader
`public.subscription_reschedule_timezone_read()`, updates
`public.subscription_apply_lifecycle_action(uuid,text,uuid,text,jsonb,timestamptz,jsonb)`,
`public.subscription_command_preview(uuid,uuid,text,uuid,text,jsonb,timestamptz)`,
`public.subscription_command_apply(uuid,uuid,text,uuid,text,jsonb,timestamptz,jsonb)`,
and
`public.customer_support_apply_subscription_action_v1(uuid,uuid,text,jsonb,integer,text,timestamptz)`
to evaluate same-calendar-day reschedule comparisons in the configured IANA time
zone while preserving the `FOR UPDATE NOWAIT` lock-bypass condition and failing
closed on malformed policy rows, and revokes public execution while granting
`EXECUTE` on the helper functions to `service_role`.
