### Versioned money payment preparation

`commerce_open_settlement_intent` and `payment_provider_intent_create` refuse fresh legacy payment entry for orders with a money version using `fiscal_confirmation_unenforceable` (`22023`). Existing matching requests still replay. Legacy validation and existing conflicts keep their original diagnostics. This includes an existing settlement or provider intent and a key already held by a settlement, provider receipt or provider transition.

Migration: Apply the native migration chain and install qualified versioned-money payment preparation before enabling versioned order issuance. If that route becomes unavailable, stop fresh issuance, keep payment readbacks available, and restore qualified preparation for existing payable orders.
