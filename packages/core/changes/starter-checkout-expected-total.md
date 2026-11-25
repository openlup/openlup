- Copied starter checkout pages must send the reviewed `expectedTotal` amount
  and currency on every fresh submit in either purchase mode. Keep the exact
  payload and command key when retrying an uncertain response. On a definitive
  `starter_expected_total_required` or `starter_quote_price_changed` refusal,
  clear consent and fetch a new `offer.validate` review. Keep the key: the
  refusal created no order, and a reconfirmed create under the same key cannot
  create a second one. A page that retires the key after such a refusal accepts
  that an earlier create still in flight under the old key can place a second
  order. Managed checkout pages handle these steps.
