### Versioned money payment preparation

`commerce_open_settlement_intent` and `payment_provider_intent_create` refuse fresh legacy payment entry for orders with a money version using `fiscal_confirmation_unenforceable` (`22023`). Existing matching requests still replay. An opening key held by another order keeps the existing unique-constraint conflict for a payable request that would open a settlement. A provider-create key held by another request keeps the existing provider idempotency conflict.

Migration: Apply the native migration chain and install qualified versioned-money payment preparation before enabling versioned order issuance. If that route becomes unavailable, stop fresh issuance, keep payment readbacks available, and restore qualified preparation for existing payable orders.
