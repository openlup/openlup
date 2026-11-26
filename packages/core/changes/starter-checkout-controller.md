### The starter's checkout page runs on the purchase-continuation controller

The managed checkout page takes its key, replay, resume and start-over from
`createPurchaseContinuation` through `shared/storefront-bindings.ts`. Three
buyer-facing changes: changed details while an earlier order may exist send
nothing, and the page shows `starter_checkout_changed` itself; a create whose
answer was lost is repeated once under the same key; the payment-status page
keeps the record of an expired order. "Start a different purchase" is offered
whenever an answer names the earlier order as not payable, or a refusal leaves
an order possible. After a refusal that wrote no order, such as
`starter_checkout_request_stale`, corrected details are still sent.

Migration: Upgrade adds
`examples/neutral-store/browser/checkout-controller.spec.ts` and replaces
pristine copies of `examples/neutral-store/client/forms.ts`,
`examples/neutral-store/client/purchase.ts`,
`examples/neutral-store/client/pages/checkout.ts`,
`examples/neutral-store/shared/limits.ts`,
`examples/neutral-store/shared/storefront-bindings.ts`,
`examples/neutral-store/test/checkout-continuation.test.ts`,
`examples/neutral-store/test/checkout-anchors.test.ts`,
`examples/neutral-store/test/storefront-bindings.test.ts`,
`examples/neutral-store/browser/journey.spec.ts`,
`examples/neutral-store/browser/lost-response.spec.ts`,
`examples/neutral-store/browser/checkout-expected-total.spec.ts`,
`examples/neutral-store/browser/storefront-anchors.spec.ts`,
`examples/neutral-store/playwright.config.ts`,
`examples/neutral-store/playwright.database.config.ts`,
`examples/neutral-store/ownership.json`,
`examples/neutral-store/README.md` and
`examples/neutral-store/docs/ownership.md`. A customised copy of
`examples/neutral-store/test/checkout-continuation.test.ts` conflicts and is
reconciled. Owned page copies keep working. No installed-policy step.
