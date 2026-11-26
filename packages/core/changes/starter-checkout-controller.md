### The starter's checkout page runs on the purchase-continuation controller

The managed checkout page takes its key, replay, resume and start-over from
`createPurchaseContinuation` through `shared/storefront-bindings.ts`. Three
buyer-facing changes: changed details while an earlier order may exist send
nothing, and the page shows `starter_checkout_changed` itself; a create whose
answer was lost is repeated once under the same key; the payment-status page
keeps the record of an expired order. "Start a different purchase" is offered
whenever an answer names the earlier order as not payable.

Migration: Upgrade adds
`examples/neutral-store/browser/checkout-controller.spec.ts` and replaces
pristine copies of `examples/neutral-store/client/forms.ts`,
`examples/neutral-store/client/purchase.ts`,
`examples/neutral-store/client/pages/checkout.ts`,
`examples/neutral-store/shared/limits.ts` and
`examples/neutral-store/test/checkout-continuation.test.ts`; other managed
tests, specs and documents follow the starter. A customised copy of that test
conflicts and is reconciled. Owned page copies keep working. No
installed-policy step.
