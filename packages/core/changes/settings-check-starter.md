### Report the starter configuration to settings show and check

The target extraction includes the file binding in `owned/settings-host.ts`.
When that path is absent, include its creation under the existing settings
host upgrade step. When the path already exists, keep it and add the following
changes by hand, retaining your application bindings and using your selected
configuration. An owned file is never overwritten.

```diff
diff --git a/owned/settings-host.ts b/owned/settings-host.ts
index 00b9518e0..70966d23b 100644
--- a/owned/settings-host.ts
+++ b/owned/settings-host.ts
@@ -4,2 +4,3 @@ import type { SettingsAppBindings } from '@openlup/platform/operations/server';
 import { checkoutWavePolicy } from './acquisition-policy.ts';
+import { assertConfig } from '../shared/config.ts';
 import { configurations, selectConfiguration } from './store.config.ts';
@@ -12,4 +13,19 @@ export function createSettingsBindings({ db, configuration }: {
   }
+  const config = selectConfiguration(configuration);
   return {
-    stockSourceKey: `starter-demo:${selectConfiguration(configuration).id}`,
+    stockSourceKey: `starter-demo:${config.id}`,
+    file: {
+      configuration: config.id,
+      validate: () => assertConfig(config),
+      entries: {
+        'offer.freeShippingFromMinor': { value: config.offer.freeShippingFromMinor },
+        'offer.subscriptionDiscountBps': { value: config.offer.subscriptionDiscountBps },
+        'purchase.reservationMinutes': { value: config.purchase.reservationMinutes },
+        'subscriptionCreation.editWindowHours': { value: config.subscriptionCreation.editWindowHours },
+        'subscriptionOffers.deliveryCycles': { value: config.subscriptionOffers },
+        'subscriptions.lifecycleNoticeRetryBudget': { value: config.renewal.subscriptionCare.dispatch.maxAttempts },
+        inventory_renewal_protection: { value: config.inventory.renewalProtection, location: { file: 'owned/store.config.ts', symbol: 'inventory.renewalProtection' } },
+        checkout_recovery_reminders: { value: config.checkoutRecoveryReminders, location: { file: 'owned/store.config.ts', symbol: 'checkoutRecoveryReminders' } },
+      },
+    },
     readers: db ? {
```

After updating the installed packages, pass `check` to the settings script
documented in the extracted application’s `AGENTS.md`.
A binding without the new member still loads; check exits 2 and names the
addition above. A failure from `assertConfig` exits 1 and gives the startup
validation message. Existing startup refusals and policy installation steps
still apply; check opens no database connection.
