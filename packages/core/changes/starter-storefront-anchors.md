### The starter's checkout and payment-status pages carry storefront anchors

The neutral starter's checkout form and payment-status page now carry the
markup anchors from `storefrontAnchor` in `@openlup/platform/storefront`, so a
storefront runner can fill the form and read the payment state without
store-specific code. Behaviour, copy and layout are unchanged.

- The checkout form's nine buyer-detail controls carry `data-openlup-field`:
  `first_name`, `last_name`, `email`, `phone`, `address_line1`,
  `address_line2`, `city`, `postal_code` and `terms_accepted`. Its submit
  button carries `data-openlup-action="place_order"`.
- The payment-status page has one status line (`p[role="status"]`) before the
  section that holds its forms. Its `data-openlup-state` is
  `awaiting_payment` on the payable view, `declined` for a refused attempt,
  `awaiting_authority` for a dispatched or indeterminate attempt and `paid` on
  the paid view; any other view names no state.
- `data-openlup-action="retry_payment"` is on the inline retry and on the
  pay-again form offered after a refused attempt, never on the first payment.
- `FieldSpec` in `client/forms.ts` gains an optional `anchor` and
  `ActionFormOptions` an optional `submitAnchor`, typed to `storefrontAnchor`
  members.

Migration: Upgrade adds `examples/neutral-store/test/checkout-anchors.test.ts`
and `examples/neutral-store/browser/storefront-anchors.spec.ts`, and replaces
pristine copies of `examples/neutral-store/client/forms.ts`,
`examples/neutral-store/client/pages/checkout.ts`,
`examples/neutral-store/playwright.config.ts`,
`examples/neutral-store/playwright.database.config.ts` and
`examples/neutral-store/ownership.json`. If apply reports that a managed file
has local edits, keep your edits separately, restore the file from the
installed starter version, rerun apply and reconcile your edits with the
replacement. A customised checkout page keeps working without anchors; to let
a storefront runner drive it, add the attributes with values read from
`storefrontAnchor`, never written by hand. This upgrade requires no
installed-policy step.
