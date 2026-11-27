- `@openlup/platform/storefront/testing`: before each run, `clearClientState` (from `createPageHandle`) resets the browser context for a new buyer; `PageHandle`'s table says what each path clears.

Migration: state a harness sets before `runStorefrontScenario` (cookies, local storage, IndexedDB, WebAuthn credentials) is cleared; set it in the arrangement. A handle without `clearClientState` ends control scenarios `not_run` (`client_state_unisolated`). No earlier control-run verdict is comparable.
