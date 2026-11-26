### Install commerce return reasons and shipping payment method preference policies

Promoted `commerce.returnReasons` (default `["damaged","wrong_item","not_as_described","pet_refused","changed_mind","other"]`,
1..64 unique codes matching `^[a-z][a-z0-9_]{1,63}$`) and
`shipping.paymentMethodPreferences` (default `["instant","card","transfer"]`,
1..32 unique codes matching `^[a-z][a-z0-9_]{1,63}$`) from `cap` to `installed`
in the packaged settings catalogue, wired their built-in SQL readers in
`openlup settings`, updated `CustomerPreferencePolicy` and
`createCustomerPreferenceSchemas` / `createPostgresCustomerPreferencePort` to
accept configured payment method codes while preserving read compatibility for
historical rows, and exported experimental SQL-parity validation, install, and
read helpers from `@openlup/platform/commerce` and `@openlup/platform/shipping`.

Migration: Platform SQL migration
`*_settings_wave3b_return_reasons_and_payment_preferences.sql` replaces the
closed enum `CHECK` constraints on `public.commerce_return_requests.reason_code`
and `public.customer_payment_preferences.method_kind` with anchored format
`CHECK` constraints (`^[a-z][a-z0-9_]{1,63}$`), installs strict JSONB validators
and fail-closed `commerce_settings` readers for both policies, updates
`public.commerce_return_request_create_owned(text,uuid,jsonb,text,text,uuid)` to
enforce `public.commerce_return_reasons_read()` on new inserts while preserving
reads and idempotent replays of historical rows, updates
`public.customer_preference_save(uuid,uuid,text,jsonb,timestamptz)` to enforce
`public.shipping_payment_method_preferences_read()` on payment preference writes
while preserving reads of historical rows, and revokes public execution while
granting `EXECUTE` on the helper functions to `service_role`.
