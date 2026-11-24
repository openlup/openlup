### Add callback entries and single-row installed policy readers

Added eight `callback` entries (`checkout.offerAdmission`, `shipping.rateResolver`,
`subscriptions.afterRenewal`, `subscriptions.editTermsAdmission`,
`subscriptions.lifecycleCommandAdmission`, `pricing.acquisitionFinancialPolicy`,
`subscriptions.sizedPortionProposal`, `bundles.compositionRules`) and three
`installed` policy entries (`subscription_minimum_base_units`,
`subscription_sized_intro_phase`, `shipping_flat_minor`) to the packaged settings
catalogue, with built-in SQL readers wired in `openlup settings`.
