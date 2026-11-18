Unreleased; next minor. API classification: additive stable commerce/server
install/read helpers and commerce/contracts schedule type; additive optional
stage and widened reminder-hour inputs on existing communications contracts.
Native reminder producers read an installed `checkout_recovery_reminders`
schedule. Stage selects tone independently of hours. Absence preserves the
historical waves; old payloads render identically. Unknown stages follow each
handler's existing payload refusal. No new subpath or reminder planner is added.

Migration:

Apply `20261123140000_checkout_recovery_reminder_schedule.sql` through the native
migration runner before using the new helpers. Both producers retain their
signatures, security, search paths, owners and ACLs. The integer-only checkout
wrapper is unchanged. The new restricted SECURITY DEFINER validator pins
`search_path = pg_catalog, pg_temp`, qualifies its settings read, revokes PUBLIC
and conditionally revokes anon/authenticated and grants service_role EXECUTE.
Malformed JSON, extra/missing keys, blank revision, empty arrays, duplicate or
unknown stages, nonincreasing/nonpositive/noninteger hours or a missing final
`last` refuse with `checkout_recovery_reminder_schedule_invalid` before writes.
The maximum hour is 2147483647. The managed chain is unchanged.

Before (host-owned timing and legacy content):
```ts
const recovery = createPostgresCheckoutRecoveryWaves(runtimeDb, { profile: 'capture' });
const vars = { ...emailVars, reminderHours: 20 };
```

After (explicit install, then runtime read and stage-aware content):
```ts
import { installCheckoutRecoveryReminderSchedule, readCheckoutRecoveryReminderSchedule }
  from '@openlup/platform/commerce/server';
await installCheckoutRecoveryReminderSchedule(installationDb, { revision: 'store-1',
  abandonedCart: [{ stage: 'first', afterHours: 1 }, { stage: 'gentle', afterHours: 24 }, { stage: 'last', afterHours: 48 }],
  checkoutRecovery: [{ stage: 'first', afterHours: 1 }, { stage: 'last', afterHours: 48 }] });
const installed = await readCheckoutRecoveryReminderSchedule(runtimeDb);
const recovery = createPostgresCheckoutRecoveryWaves(runtimeDb,
  { profile: 'capture', checkoutSeconds: 72 * 3600 });
const vars = { ...emailVars, reminderHours: 48, stage: 'last' as const };
```

Reads never install. The TypeScript reader needs settings SELECT; enqueue uses
the restricted SQL validator without requiring settings SELECT. Custom runtime
roles must retain their existing producer and relation privileges.

Before (separate runtime producer grants):
```sql
GRANT EXECUTE ON FUNCTION public.commerce_enqueue_abandoned_cart_reminders(integer),
  public.commerce_enqueue_checkout_recovery_reminders(integer,jsonb,timestamptz) TO runtime_role;
```

After applying the migration, add exactly one grant:
```sql
GRANT EXECUTE ON FUNCTION public.commerce_checkout_recovery_reminder_schedule() TO runtime_role;
```

Qualified service-role bindings already receive it. Missing EXECUTE fails with
SQLSTATE `42501`, even with an absent setting; it never silently defaults.

Before (fixed SQL waves):
```sql
FOREACH wave IN ARRAY ARRAY[1,20] LOOP
```

After (strictly validated installed waves):
```sql
FOR entry IN SELECT value FROM jsonb_array_elements(
  public.commerce_checkout_recovery_reminder_schedule()->'checkoutRecovery') LOOP
```

Default dedup keys remain byte-identical. Custom waves derive keys by the same
hour spelling: `abandoned_<hours>h:<order-id>` and
`checkout_recovery:<hours>h:<order-id>`. Abandoned event types retain stage routes
1h/24h/72h. Legacy counter names count their corresponding stages. Final waves
retain the preceding-stage processed gate for abandoned carts and first-wave
confirmed-acceptance gate for checkout recovery; a lone `last` has no predecessor.
With an installed key, hours override legacy request offsets; absence retains
those offsets. Existing request-policy validation of legacy offsets (including
defaults) still applies. Checkout expiry, consent, payment activity and token deadlines
remain independent. Changing hours changes dedup identity and never rewrites
pending events or tokens; coordinate installation with in-flight reminders.

The source starter owns the schedule and installs only in its explicit install
step. Startup compares revision, stages and hours and refuses
`starter_installed_policy_drift` without writing. Existing starter applications
must add the owned input and install it deliberately.
