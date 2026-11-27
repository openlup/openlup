- `@openlup/platform/storefront/testing`: the runner clears cookies, local and session storage of the store's origin before each run through `clearClientState`, which `createPageHandle` provides.

Migration: a page handle without `clearClientState` now ends each scenario with a control run `not_run` (`client_state_unisolated`); use `createPageHandle` or add the member. Control-scenario verdicts from earlier versions, whose handles lacked it, are not comparable: run them again.
