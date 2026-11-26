- The native schema can retain an authorized renewal order's destination and delivery service. Fulfillment and privacy export verify the original document at the scope where it was issued. Later destination edits leave the retained order evidence intact.

  Retained order and shipment reads of a subscription-issued document return `documentPurpose: "subscription"` with `evidenceExpiresAt: null`.
  Use a `documentPurpose` property check to narrow `DestinationVerifiedReadV2` before using the expiry timestamp that checkout-issued documents keep, including those a renewal inherits.
