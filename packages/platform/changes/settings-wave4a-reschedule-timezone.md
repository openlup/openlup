### Install subscription reschedule time zone policy

Promoted `subscriptions.rescheduleTimeZone` (`subscription_reschedule_timezone`, default `"UTC"`) from `cap` to `installed`, added `rescheduleTimeZonePolicy` helpers and `postgresCommandStore` time-zone support.

Migration: Platform SQL migration updates the four reschedule functions (`SET search_path = pg_catalog, pg_temp`) and installs `subscription_reschedule_timezone_validate`/`_read`.
