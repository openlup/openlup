- Copied starter checkout pages must send the reviewed `expectedTotal` amount
  and currency on every fresh submit in either purchase mode. Keep the exact
  payload and command key when retrying an uncertain response. On a definitive
  `starter_expected_total_required` or `starter_quote_price_changed` refusal,
  clear consent and fetch a new `offer.validate` review. A custom page may
  retire the key after these refusals. The managed checkout page keeps its
  per-purchase key, because the refusal wrote nothing and a repeat under the
  same key cannot create a second order. Managed checkout pages handle these
  steps.
