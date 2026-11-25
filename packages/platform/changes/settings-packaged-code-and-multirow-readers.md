### Add packaged code settings and multi-row installed readers

Added five packaged `code` settings to the settings catalogue
(`checkout.resumeWindowMinutes`, `inventory.offerLowStockThreshold`,
`catalog.bundleAvailabilityPolicy`, `market.settlementProfile`,
`communications.terminalPayloadRetentionDays`) along with runtime numeric
validation for `resumeWindowMinutes` and `lowStockThreshold` options. Added
multi-row `installed` entries (`pricing.subscriptionPricePolicy`,
`communications.nativeDeliveryControls`) with aggregate SQL readers in
`openlup settings`.
