Unreleased; next minor. Add `RenewalStockProtectionPolicy` and typed install/read
helpers to the stable inventory subpath, with the type also in inventory/contracts.
Native ATP reads the installed `inventory_renewal_protection` commerce setting.
Absence preserves 14 days with revision `default`; malformed JSON, extra/missing
keys, blank revision or noninteger/out-of-range days refuse with
`inventory_renewal_protection_policy_invalid`. Request horizons must match installed
days; `native_stock_read_options_unsupported` remains the mismatch refusal.

Migration:

Apply the native forward `20261123130000_inventory_renewal_protection_policy.sql`
through the migration runner before composing the new helpers. The forward retains
ATP's signature, language, volatility, invoker security, search path, owner and ACL.
It adds an invoker validator with service-role EXECUTE. Existing custom runtime
roles need SELECT on `commerce_settings` and EXECUTE on
`inventory_renewal_protection_days()`; qualified service-role bindings already cover
these. No settings seed or subscription lifecycle rewrite is performed.

Before (host):
```ts
const input = { skus: ['ITEM'], horizonDays: 14, excludeOrderId: null };
await stock.readPort.read(input);
```

After (explicit installation, then runtime composition):
```ts
import { installRenewalStockProtectionPolicy, readRenewalStockProtectionPolicy }
  from '@openlup/platform/inventory';
// Install step only, on the host's write-capable connection:
await installRenewalStockProtectionPolicy(installationDb,
  { revision: 'store-1', renewalProtectionDays: 21 });
// Runtime only reads:
const policy = await readRenewalStockProtectionPolicy(runtimeDb);
await stock.readPort.read({ skus: ['ITEM'],
  horizonDays: policy.renewalProtectionDays, excludeOrderId: null });
```

Before (SQL horizon):
```sql
s.next_cycle_at <= p_as_of + interval '14 days'
```

After (installed horizon, validated once per ATP statement):
```sql
s.next_cycle_at <= p_as_of + make_interval(days => (SELECT days FROM policy))
-- policy materializes public.inventory_renewal_protection_days().
```

The source starter owns `inventory.renewalProtection` and installs it only through
its explicit installation step. Startup checks revision and days, refusing
`starter_installed_policy_drift` rather than writing. Existing applications must
add this owned input and install it deliberately. Unrelated raw editor settings
remain unchanged; the private package helper is not an adopter API.
