### Discover and check the starter's owned settings

Update the installed OpenLup packages together. Include the target's
`owned/settings-host.ts` as a creation in the upgrade snapshot if that path
is absent. If the file exists, preserve it and merge the following additions by hand.

Ensure the upgraded application manifest declares `"zod": "4.6.6"` in
dependencies and update its lockfile. In `owned/settings-host.ts`, add the Zod
import after the `pg` type import, extend the settings type import, annotate
`entries`, and replace the existing filter as follows:

```diff
 import type { Pool } from 'pg';
+import { z } from 'zod';
-import type { SettingsAppBindings } from '@openlup/platform/operations/server';
+import type { SettingsAppBindings, SettingsFileEntry } from '@openlup/platform/operations/server';
-  const entries = {
+  const entries: Record<string, SettingsFileEntry> = {
-      entries: Object.fromEntries(Object.entries(entries).filter(([, entry]) => entry.value !== undefined)),
+      entries: Object.fromEntries(Object.entries(entries).filter(([, entry]) => entry.descriptor !== undefined || entry.value !== undefined)),
```

Copy the six `descriptor` members with their native Zod schemas from the target
starter's `file.entries` into the existing entries for
`offer.freeShippingFromMinor`, `offer.subscriptionDiscountBps`,
`purchase.reservationMinutes`, `subscriptionCreation.editWindowHours`,
`subscriptionOffers.deliveryCycles` and `subscriptions.lifecycleNoticeRetryBudget`.
Keep your value expressions, file locations and app-specific entries.
The filter keeps declarations with missing values and omits undefined
value-only reports.
If your binding has no `file` member yet, merge the target's
`file: { configuration, entries, validate }` section using your selected
configuration and existing startup assertion. Keep the installed policy
entries value-only and preserve your connected readers and stock source.

From the app root, pass these arguments to the settings script in `AGENTS.md`:

- `list --goal "free shipping"`
- `show offer.freeShippingFromMinor --json`
- `check --json`

Confirm that the list includes the key, show reports the expected file value and
check includes the six declarations. For a value reported without a descriptor,
add the matching descriptor as above and rerun. These reads require no database
connection.
