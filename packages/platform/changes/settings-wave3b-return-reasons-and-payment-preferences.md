### Install return reasons and payment method preference policies

Promoted `commerce.returnReasons` and `shipping.paymentMethodPreferences` from `cap` to `installed`, added `returnReasonsPolicy` and `paymentMethodPreferencesPolicy` helpers, and extended `CustomerPreferencePolicy` for custom codes.

Migration: Platform SQL migration replaces closed enum `CHECK` constraints with anchored format checks (`^[a-z][a-z0-9_]{1,63}$`), installs `*_validate`/`_read` helpers (`SET search_path = pg_catalog, pg_temp`), and enforces active lists in `commerce_return_request_create_owned` and `customer_preference_save` while preserving historical reads.
