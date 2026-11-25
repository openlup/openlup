- Copied starter checkout pages must send the reviewed `expectedTotal` amount
  and currency on every fresh submit in either purchase mode. Keep the exact
  payload and command key when retrying an uncertain response. On a definitive
  `starter_expected_total_required` or `starter_quote_price_changed` refusal,
  retire the key, clear consent and fetch a new `offer.validate` review.
  After the buyer reconfirms the rendered review, use a new key even if the
  amount and currency are unchanged. Managed checkout pages handle these steps.
