### The starter's checkout and payment-status pages carry storefront anchors

The neutral starter's checkout form marks its nine buyer-detail controls with
`data-openlup-field` and its submit with `place_order`. The payment-status
page has one status line before its forms whose `data-openlup-state` is
`awaiting_payment`, `declined`, `awaiting_authority` or `paid`;
`retry_payment` marks only the retry offered after a refused attempt. Behaviour
and copy are unchanged.

Migration: Upgrade adds `examples/neutral-store/test/checkout-anchors.test.ts`
and `examples/neutral-store/browser/storefront-anchors.spec.ts`, and replaces
pristine copies of `examples/neutral-store/client/forms.ts`,
`examples/neutral-store/client/pages/checkout.ts`,
`examples/neutral-store/playwright.config.ts`,
`examples/neutral-store/playwright.database.config.ts` and
`examples/neutral-store/ownership.json`. A customised checkout page works
without anchors; add them from `storefrontAnchor`. No installed-policy step.
