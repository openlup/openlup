- `@openlup/platform/storefront/testing`: before each run, `clearClientState` (from `createPageHandle`) clears the client state `PageHandle`'s table lists for each path.

Migration: state a harness sets before `runStorefrontScenario` (cookies, local or session storage, IndexedDB, WebAuthn credentials) can be cleared; set it in the arrangement. A handle without `clearClientState` ends control scenarios `not_run` (`client_state_unisolated`). No earlier control-run verdict is comparable.
