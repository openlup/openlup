### Readiness with verified native orders

Price Setup and Publish can evaluate readiness with verified native one-time orders, including undiscounted orders with free shipping, and activated initial subscription orders with standalone acquisition terms under offer policy v2. Both require direct sandbox capture and matching checkout evidence. A claim-bearing refusal can clear when you complete an eligible pending activation or restore a valid, unambiguous acquisition schedule with the same source definition. Other hard refusals clear only after the blocking order ages past the inclusive 24-hour window.

Migration: Apply the native forward `20261128010000_catalog_order_checkout_protection.sql`.
