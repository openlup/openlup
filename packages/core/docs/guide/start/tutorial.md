# Record a subscription cycle and process its event

Save a subscription cycle in PostgreSQL, process its paid event, and read back
the processed row and an application receipt.

## Prerequisites

Use Node.js 24, npm 11.19.0, Bash, and an empty directory. Supply a reachable,
empty, disposable PostgreSQL database through `OPENLUP_TUTORIAL_DATABASE_URL`.
Its login must be able to create tables and functions in `public`; the database
must provide `pg_catalog.pg_input_is_valid(text,text)`. These commands create
tables and functions and leave the result in that database.

Set `OPENLUP_TUTORIAL_DATABASE_URL` in your terminal to your connection string
before starting. Run the steps in order in that same terminal and directory.

## Steps

1. Initialize the application and install exact matching OpenLup packages,
   together with the PostgreSQL driver.

```sh tutorial
: "${OPENLUP_TUTORIAL_DATABASE_URL:?Set the connection string first}"
npm init -y
OPENLUP_VERSION="$(npm view @openlup/core version)"
npm install --save-exact "@openlup/core@$OPENLUP_VERSION" "@openlup/outbox@$OPENLUP_VERSION" pg
```

2. Write the application. It applies the SQL shipped with Outbox to the empty
   database, checks the declared schema objects, and saves the model and event
   together. The handler writes an application receipt keyed by event identity.

```sh tutorial
cat > tutorial.mjs <<'APP'
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { env } from 'node:process';
import pg from 'pg';
import { createInitialSubscriptionCheckoutModel, recordPaymentSuccess } from '@openlup/core/subscription';
import { buildSchemaObjectProbe } from '@openlup/core/readiness';
import { buildOutboxEnqueue, runOutboxDispatchWorker, uniqueRegistry } from '@openlup/outbox';
import { createPostgresOutboxStore, POSTGRES_OUTBOX_SCHEMA } from '@openlup/outbox/postgres';

function unwrap(result) {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}
const id = '00000000-0000-4000-8000-000000000001';
const initial = unwrap(createInitialSubscriptionCheckoutModel({
  subscriptionId: id, clientRef: 'tutorial-customer',
  template: {
    cadence_days: 14, currency: 'USD', region_code: 'EXAMPLE',
    edit_window_hours: 24, size_constraint: null,
    lines: [{ variant_id: 'example-item', qty: 1, sort_order: 1, is_addon: false }],
  },
  paymentMethodRef: 'example-method', paymentMethodKind: 'card', timezone: 'UTC',
  firstCycleAt: '2026-01-01T10:00:00.000Z', now: '2026-01-01T10:00:00.000Z',
  pricingSnapshot: { currency: 'USD', totalGrossMinor: 1000 }, idempotencyKey: 'tutorial-cycle',
}));
const paid = unwrap(recordPaymentSuccess({
  subscription: initial.subscription, cycle: initial.cycle,
  paidAt: '2026-01-01T10:00:00.000Z', recordedAt: '2026-01-01T10:00:00.000Z',
}));
const event = paid.events.find(event => event.eventType === 'subscription.cycle_paid');
assert.ok(event);
const pool = new pg.Pool({ connectionString: env.OPENLUP_TUTORIAL_DATABASE_URL,
  connectionTimeoutMillis: 5000, statement_timeout: 10000 });
try {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const require = createRequire(import.meta.url);
    const outboxRoot = dirname(require.resolve('@openlup/outbox/package.json'));
    await client.query(await readFile(join(outboxRoot, 'sql/0001_outbox.sql'), 'utf8'));
    for (const object of POSTGRES_OUTBOX_SCHEMA.objects) {
      const query = buildSchemaObjectProbe(object);
      const result = await client.query(query.text, query.values);
      assert.equal(result.rows[0]?.present, true, `Missing schema object: ${object.name}`);
    }
    await client.query('create table public.tutorial_cycles (id uuid primary key, model jsonb not null)');
    await client.query('create table public.tutorial_receipts (event_id uuid primary key)');
    await client.query('insert into public.tutorial_cycles values ($1, $2::jsonb)', [id, JSON.stringify(paid)]);
    const query = buildOutboxEnqueue({
      aggregateType: 'subscription', aggregateId: id, eventType: event.eventType,
      idempotencyKey: event.idempotencyKey, payload: event.payload,
    });
    await client.query(query.text, query.values);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally { client.release(); }
  console.log('Outbox schema objects: present');
  const registry = uniqueRegistry([{
    eventType: 'subscription.cycle_paid', timeoutMs: 1000,
    async handle(row) {
      await pool.query('insert into public.tutorial_receipts values ($1) on conflict do nothing', [row.id]);
      return { kind: 'processed' };
    },
  }]);
  const result = await runOutboxDispatchWorker({
    store: createPostgresOutboxStore(pool), registry,
    knownEventTypes: ['subscription.cycle_paid'],
    config: { batchSize: 1, maxAttempts: 8, visibilitySeconds: 300,
      backoffBaseSeconds: 60, backoffCapSeconds: 3600, snoozeSeconds: 300,
      maxSnoozes: 48, softBudgetMs: 15000 },
  });
  assert.equal(result.processed, 1);
  const { rows: [saved] } = await pool.query(`
    select c.model, e.status, count(r.event_id)::integer as receipts
    from public.tutorial_cycles c join public.outbox_events e on e.aggregate_id = c.id
    left join public.tutorial_receipts r on r.event_id = e.id
    group by c.id, e.id`);
  assert.equal(saved.model.cycle.status, 'paid');
  assert.equal(saved.model.subscription.nextCycleAt, '2026-01-15T10:00:00.000Z');
  assert.equal(saved.status, 'processed');
  assert.equal(saved.receipts, 1);
  console.log(`Subscription cycle: ${saved.model.cycle.status}`);
  console.log(`Next cycle: ${saved.model.subscription.nextCycleAt}`);
  console.log(`Outbox event: ${saved.status}`);
  console.log(`Application receipts: ${saved.receipts}`);
} finally { await pool.end(); }
APP
```

3. Run the application and inspect its result.

```sh tutorial
node tutorial.mjs
```
```text tutorial-expect
Outbox schema objects: present
Subscription cycle: paid
Next cycle: 2026-01-15T10:00:00.000Z
Outbox event: processed
Application receipts: 1
```

## What you have now

The database contains the paid subscription model, its processed outbox event,
and a receipt written by your handler. The producer saved the model and event
in the same transaction; the worker's database operations committed independently.

## Current limits

`recordPaymentSuccess` records a supplied payment fact; it does not collect
money. This application handles only `subscription.cycle_paid`; it does not
enqueue the model's other events. The receipt demonstrates a local database
effect, not delivery to an external system. Checking schema objects does not
establish function behavior, database permissions, or full application readiness.

These commands run the worker once. A storefront, payment collection, delivery,
scheduled execution, and runtime authorization need application bindings.
The separate store draft is distributed as source, not installed by these
packages. Installing the full platform schema also needs a provisioned host
profile; this tutorial installs only the shipped Outbox SQL. Rerunning the
application needs another empty database because its schema creation is
unconditional.

## Calculate a retry time

For a calculation that needs no database, import `nextRetryAttemptAt` from the
installed Core package and supply your application's retry policy:

```ts
import { nextRetryAttemptAt } from "@openlup/core/subscription";

const failedAt = "2026-01-10T09:00:00.000Z";
const cadence = { backoffHours: [24, 72] };

nextRetryAttemptAt(failedAt, 1, cadence); // "2026-01-11T09:00:00.000Z"
nextRetryAttemptAt(failedAt, 2, cadence); // "2026-01-13T09:00:00.000Z"
nextRetryAttemptAt(failedAt, 3, cadence); // null: the retry budget is exhausted
```

The attempt number selects an offset in `backoffHours`, measured from
`failedAt`; an attempt beyond that array returns `null`. This pure function
calculates a time without scheduling a job, persisting state or charging a
payment method. See the [subscription engine](../concepts/subscription-engine.md#the-retry-ladder-terminates)
for retry and lifecycle rules, and the
[architecture guide](../concepts/architecture-and-ownership.md) for host composition.

## Next steps

Read the [start overview](README.md), the [glossary](../glossary.md), and the
[upgrade procedure](../upgrade/README.md).
