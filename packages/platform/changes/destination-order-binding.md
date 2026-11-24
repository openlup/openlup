### Retain native order destination evidence

Native order and shipment reads use the original verified destination binding.
Privacy erasure clears sealed checkout pins. Checkout issuance remains dormant.

Migration: Apply `20261125130000_commerce_destination_v2_order_bindings.sql`.
