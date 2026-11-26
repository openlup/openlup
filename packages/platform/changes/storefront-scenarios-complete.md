- `@openlup/platform/storefront/testing`: `storefrontScenarios` gains `lost_response_edited_payload`, `reload_pending_attempt`, `decline_retry` and `paid_pending_activation`, and `runStorefrontScenario` gains an outcome driver with capability admission and ledger-effect checks, the `omit_action` and `other_policy` controls, declared auto-progress and `stopAt`, which resolves `{ kind: "stopped", stoppedAt, steps }` without a verdict. Verdicts may carry the new finding code `auto_progress_not_performed`.

Migration: `runStorefrontScenario` now resolves a union discriminated by `kind`, so code that read `verdict` straight from the result no longer typechecks. Narrow on `kind` first; without `stopAt` the result is always `"verdict"`.

```ts
// Before
const { verdict } = await runStorefrontScenario(options);

// After
const result = await runStorefrontScenario(options);
if (result.kind !== "verdict") throw new Error(`expected a verdict, got ${result.kind}`);
const { verdict } = result;
```
