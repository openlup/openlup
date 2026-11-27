- `@openlup/platform/storefront/testing`: before each run, `clearClientState` (from `createPageHandle`) clears every browser-context cookie and the store origin's local and session storage (not from `about:blank`; Cache Storage and service workers excluded).

Migration: set harness cookies, such as a preview sign-in, in the arrangement, not before `runStorefrontScenario`. A handle without `clearClientState` ends control scenarios `not_run` (`client_state_unisolated`). No earlier control-run verdict is comparable.
