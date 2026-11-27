### Starter browser specs keep their first-request stubs installed

The starter's browser specs stub the first matching request through
`browser/route-stub.ts`, a route that stays installed and lets later requests
through, instead of an expiring `{ times }` route. Playwright can lose the
events of a request sent while an expiring route turns interception off, which
made a payment-status case time out intermittently. No product behaviour
changes.

Migration: Upgrade adds `examples/neutral-store/browser/route-stub.ts` and
replaces pristine copies of
`examples/neutral-store/browser/checkout-controller.spec.ts`,
`examples/neutral-store/browser/storefront-anchors.spec.ts`,
`examples/neutral-store/browser/native-operator.proof.ts` and
`examples/neutral-store/ownership.json`. A customised spec that still passes
`{ times }` keeps working. No installed-policy step.
