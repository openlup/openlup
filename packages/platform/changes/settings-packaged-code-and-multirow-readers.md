### Add packaged code settings (D1-D3, A16, E12) and multi-row installed readers (B3, B5)

Added five packaged `code` settings to the settings catalogue
(`checkout.resumeWindowMinutes`, `inventory.offerLowStockThreshold`,
`catalog.bundleAvailabilityPolicy`, `market.settlementProfile`,
`communications.terminalPayloadRetentionDays`) along with runtime numeric
validation for `resumeWindowMinutes` and `lowStockThreshold` options. Added
multi-row `installed` entries (`pricing.subscriptionPricePolicy`,
`communications.nativeDeliveryControls`) with aggregate SQL readers in
`openlup settings`.
