- `@openlup/platform/storefront/testing`: four more scenarios; `runStorefrontScenario` gains an outcome driver, the `omit_action` and `other_policy` controls, declared auto-progress and `stopAt`.

Migration: the result is now a union on `kind`; narrow before reading `verdict`.

```ts
const result = await runStorefrontScenario(options);
if (result.kind !== "verdict") throw new Error(result.kind);
const { verdict } = result;
```
