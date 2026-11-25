- Native checkout now accepts a subscription quote whose derived price matches
  the effective catalogue base and policy. Generate a fresh server quote and
  retry if the pricing evidence changed.
- This fix adds no refusal code, export or setting. Quotes without
  derived-policy evidence keep the existing price lookup.

Migration: Apply `20261128000000_native_derived_subscription_price.sql` through
the selected native migration catalogue.
