### The starter's checkout transport and bookkeeping move to `shared/`

The neutral starter gains `shared/storefront-bindings.ts`, which binds
`createPurchaseContinuation` from `@openlup/platform/storefront` to the
starter's checkout actions. It keeps the existing tab record
(`neutral-store:checkout-continuation:v1:<configuration>`), uses the stored
continuation value as the `checkout.create` key, and classifies the starter's
answers. A record written by an earlier starter page is reused: call
`adoptFingerprint` before the first submit and the purchase continues under
the same key. The action transport `act` and `uncertainAction` move from
`client/api.ts` to `shared/transport.ts`; `client/api.ts` re-exports both, and
`act` takes an optional request deadline. The checkout page's create
bookkeeping moves into the new module. A store-owned client can import both
modules instead of rewriting the wire.

The managed pages are unchanged, with one correction: "no order under this
key" now counts as final strictly after the request timeout plus the late-create
bound, 1 ms later than before, matching the host's own strict stale rule.
Behaviour is otherwise unchanged.

Migration: Upgrade replaces pristine copies of `client/api.ts`,
`client/purchase.ts` and `test/checkout-continuation.test.ts`, and adds
`shared/transport.ts`, `shared/storefront-bindings.ts` and
`test/storefront-bindings.test.ts`. If apply reports that a managed file has
local edits, keep your edits separately, restore the file from the installed
starter version, rerun apply and reconcile your edits with the replacement. A
customised `client/api.ts` that still defines `act` itself keeps working. This
upgrade requires no installed-policy step.
