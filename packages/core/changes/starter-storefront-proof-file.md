- The starter gains the optional owned file `owned/storefront-proof.json`
  (configuration, width and routes of its storefront proof) and the managed
  proof kit `browser/storefront-proof-kit.ts`. Sandbox simulate buttons carry
  `data-starter-sandbox-outcome` and post the new operations
  `checkout.paymentSimulate` and `checkout.recoverySimulate`; the
  `action: "simulate"` form of `checkout.payment` and `checkout.recovery`
  still works in this release and retires later.

Migration: Pristine managed starter files are replaced, and the kit,
`shared/action-path.ts` and `test/storefront-proof-kit.test.ts` are added; upgrade never creates
`owned/storefront-proof.json`, and a store without it is proven with the
shipped values. If apply reports local edits to a managed file, keep them
aside, restore the file from the installed starter version, rerun apply and
reconcile. A customized payment page keeps the decline proof only if its
sandbox buttons carry the marker. The kit refuses, with four parts, a proof
file it cannot read (`starter_storefront_proof_file_unreadable`, including a
dangling link), with more than one or an unknown configuration, with an
adapter module, or with a shape the package parser refuses; host start is
unaffected. No
installed-policy step.
