# @openlup/platform for agents

## Purpose and kind

Kind: `rail`.

The package supplies runnable server infrastructure and optional commerce
capabilities. An application selects services and supplies ports, credentials,
policy, authorization and host composition. Imports do not activate services.
This is a development preview; inspect each exported subpath's maturity below.

## Installed context lookup

From the application root, invoke the installed local executable:

```sh
./node_modules/.bin/openlup-context search "subscription renewal"
```

This MVP indexes English documentation. Translate Polish or other natural-language
tasks into concise English domain terms, or search an exact public symbol;
freeform Polish queries may miss relevant guidance. `--code` scans a bounded
set of application source paths; `--package-code` scans installed package `src/`
files. Both are opt-in and may be incomplete; direct `rg` remains available.

Choose the next lookup from the evidence needed: read a known path or symbol
directly; use `openlup-context` when the package owner or seam is unclear; then
open its cited source. For work spanning packages, follow the relevant exports,
callers and tests until each required contract has a witness. A ranked hit is a
starting point, not proof that all related constraints were found.

Core supplies this Node-only executable. It reads installed local snapshots on
invocation and grants no application policy, tool permission or external-write
authority. The application's own instructions govern.

## Subpath maturity

| Export | Role | Maturity |
| --- | --- | --- |
| `./account-support` | capability | experimental |
| `./account-support/contracts` | capability | experimental |
| `./account-support/postgres` | capability | experimental |
| `./account-support/read-contracts` | capability | experimental |
| `./bff` | rail | experimental |
| `./blob` | rail | experimental |
| `./catalog` | capability | experimental |
| `./catalog/contracts` | capability | experimental |
| `./channels` | capability | experimental |
| `./channels/contracts` | capability | experimental |
| `./channels/server` | capability | experimental |
| `./commerce` | capability | experimental |
| `./commerce/contracts` | capability | experimental |
| `./commerce/server` | capability | experimental |
| `./commerce/server/destinations` | capability | experimental |
| `./commerce/server/native-checkout` | capability | experimental |
| `./commerce/server/postgres` | capability | experimental |
| `./communications` | capability | experimental |
| `./communications/contracts` | capability | experimental |
| `./communications/klaviyo` | capability | experimental |
| `./communications/resend` | capability | experimental |
| `./company-identity` | capability | experimental |
| `./company-identity/contracts` | capability | experimental |
| `./company-identity/server` | capability | experimental |
| `./composition` | rail | experimental |
| `./data` | rail | experimental |
| `./fulfillment` | capability | experimental |
| `./fulfillment/contracts` | capability | experimental |
| `./fulfillment/native` | capability | experimental |
| `./fulfillment/omnipack` | capability | experimental |
| `./http` | rail | experimental |
| `./identity` | capability | experimental |
| `./identity/contracts` | capability | experimental |
| `./inventory` | capability | experimental |
| `./inventory/contracts` | capability | experimental |
| `./invoicing` | capability | experimental |
| `./invoicing/contracts` | capability | experimental |
| `./invoicing/postgres` | capability | experimental |
| `./job-ledger` | rail | experimental |
| `./kernel` | rail | experimental |
| `./lifecycle` | rail | experimental |
| `./market-packs` | capability | experimental |
| `./marketing` | capability | experimental |
| `./marketing/contracts` | capability | experimental |
| `./marketing/server` | capability | experimental |
| `./marketing/server/postgres` | capability | experimental |
| `./migrations` | rail | experimental |
| `./operations` | capability | experimental |
| `./operations/contracts` | capability | experimental |
| `./operations/server` | capability | experimental |
| `./payments` | capability | experimental |
| `./payments/contracts` | capability | experimental |
| `./payments/stripe` | capability | experimental |
| `./payments/tpay` | capability | experimental |
| `./portability` | rail | experimental |
| `./pricing` | capability | experimental |
| `./pricing/browser` | capability | experimental |
| `./pricing/contracts` | capability | experimental |
| `./promotions` | capability | experimental |
| `./promotions/contracts` | capability | experimental |
| `./risk` | capability | experimental |
| `./risk/contracts` | capability | experimental |
| `./risk/server` | capability | experimental |
| `./scheduler` | rail | experimental |
| `./shipping` | capability | experimental |
| `./shipping/contracts` | capability | experimental |
| `./subscriptions` | capability | experimental |
| `./subscriptions/contracts` | capability | experimental |

This table is checked against `release-gates.json`. Any preview version may
change an export; read [the changelog](CHANGELOG.md) before upgrading.

## Wiring example

The following example compiles in CI and declares jobs without starting a host:

```ts
import { createScheduledJobRegistry } from "@openlup/platform/scheduler";

export const jobs = createScheduledJobRegistry([
  { id: "app-cleanup", schedule: "0 * * * *", run: async () => {} },
]);
```

The application binds a scheduler, implements effects and supplies leases where
required; see [scheduled jobs](README.md#scheduled-jobs).

## Provider wiring recipes

For transactional email, email provider setup, marketing automation and ecommerce events, start
with these offline examples from the application root. Save each complete
TypeScript block as a separate `.mts` file and run it with Node 24. The examples
use the installed package exports, synthetic data and injected HTTP only.

### Captured delivery and protocol observations

The capture records the envelope locally. The selected protocol adapter uses a
fake HTTP endpoint so the same example can check egress routing, signed callbacks
and read-only reconciliation without sending a real message.

```ts
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createInMemoryEmailTransport, guardEmailTransport } from "@openlup/platform/communications";
import { createResendTransport, createResendWebhookHandler, runResendDeliveryReconciliation } from "@openlup/platform/communications/resend";

const message = { from: "sender@example.invalid", to: "reader@example.invalid",
  subject: "Local notice", html: "<p>Local notice</p>", idempotencyKey: "notice:1" };
const capture = createInMemoryEmailTransport();
assert.equal((await guardEmailTransport(capture).send(message)).outcome.ok, true);
assert.deepEqual(capture.sent, [message]);

const methods: string[] = [];
const fakeHttp: typeof fetch = async (_url, init) => {
  methods.push(init?.method ?? "GET");
  return Response.json({ id: "message-1", last_event: "delivered", to: ["sink@example.invalid"] });
};
const sender = createResendTransport({
  environmentTagName: "host_env", fetch: fakeHttp,
  policy: intendedRecipient => ({ mode: "sandbox_sink", reason: "local_example",
    intendedRecipient, recipient: "sink@example.invalid",
    credential: "synthetic-not-a-real-key", environmentTag: "non_production" }),
});
assert.equal((await sender.send(message)).outcome.resendId, "message-1");

const observations: string[] = [];
const webhookSecret = "synthetic-not-an-endpoint-secret";
const webhook = createResendWebhookHandler({
  webhookSecret, environmentTagName: "host_env", now: () => 1000,
  port: { findSend: async () => ({ id: "send-1" }),
    applyObservation: async value => { observations.push(value.eventType); },
    recordAttempt: async () => {} },
});
const rawBody = JSON.stringify({ type: "email.delivered",
  data: { email_id: "message-1", tags: { host_env: "non_production" } } });
const signature = createHmac("sha256", webhookSecret)
  .update("hook-1.1000." + rawBody).digest("base64");
assert.equal((await webhook({ rawBody, headers: { webhookId: "hook-1",
  timestamp: "1000", signature: "v1," + signature } })).status, 200);
assert.equal((await webhook({ rawBody, headers: {} })).status, 401);

const result = await runResendDeliveryReconciliation({
  apiKey: "synthetic-not-a-real-key", fetch: fakeHttp,
  now: new Date(1000000).toISOString(), graceMinutes: 1, limit: 1,
  port: { findFrozenSends: async () => [{ id: "send-1", messageId: "message-1" }],
    recordPollAttempt: async () => {}, recordSendNotFound: async () => ({ abandoned: false }),
    applyPolledEvent: async value => { observations.push(value.eventType); } },
});
assert.equal(result.reconciled, 1);
assert.deepEqual(methods, ["POST", "GET"]);
assert.deepEqual(observations, ["email.delivered", "email.delivered"]);
console.log({ envelope: capture.sent[0], methods, observations });
```

For a real host, replace the fake endpoint with the selected transport, inject
the actual credential/routing policy and deadline, and bind the callback's
original bytes and headers. Supply a durable observation store and schedule the
GET-only reconciler. Its atomic writer must converge replayed observations.
Transport acceptance, capture and the synthetic delivered event above are
different facts; this example does not qualify a provider account.

For native PostgreSQL storage, the public communications entry exposes
`createPostgresDeliveryReconciliationPort`. Install the complete SQL chain,
construct it with the selected connection and binding, and call
`registerNetworkTarget` only after observed network acceptance with a real
message ID. Capture is not network evidence. Its `findByMessageId` and atomic
`applyObservation` compose the callback; its reconciliation methods retain
poll attempts and not-found state. Translate the closed protocol event names
(`email.sent`, `email.delivery_delayed`, `email.delivered`, `email.failed`,
`email.bounced`, `email.complained`) to native observation kinds (`sent`,
`delayed`, `delivered`, `failed`, `bounced`, `complained`) explicitly. Keep
callback observation keys stable, supply the host's attempt-observation policy,
and close the store when the owning host shuts down. Both paths write the same
observation ledger; neither initiates a replacement send.

### Unqualified marketing integration

A host issues an opaque subject reference backed by its current subject
registry. The type assertion below is the host's explicit TypeScript branding
boundary; it grants no authorization. Never derive that reference from an
email or treat a serialized branded string as trusted evidence.

```ts
import assert from "node:assert/strict";
import type { SyncRequest } from "@openlup/platform/communications/contracts";
import { createKlaviyoMarketingAdapter } from "@openlup/platform/communications/klaviyo";

const binding = { account: "synthetic", environment: "local",
  namespace: "example", mappingVersion: "1" };
const audience = { kind: "account-wide" } as const;
const subjectReference = "subject:example" as SyncRequest["subjectReference"];
const subject = { binding, subjectReference, generation: 1, erased: false,
  email: "reader@example.invalid", externalReference: "local:example",
  ownedFields: [], ownedProperties: [] };
const values = new Map<string, string>();
let httpCalls = 0, credentialReads = 0, writes = 0;
const adapter = createKlaviyoMarketingAdapter({
  binding, audience,
  subjectMapper: reference => reference === subjectReference ? subject : undefined,
  resolveCredential: () => { credentialReads++; return undefined; },
  authorizations: new Map(), localEvidence: new Map(),
  storage: {
    availability: { account: binding.account, environment: binding.environment,
      busy: false, quarantined: true },
    get: async key => values.get(key) ?? null,
    compareAndSwap: async (key, expected, next) => {
      writes++;
      if ((values.get(key) ?? null) !== expected) return false;
      values.set(key, next); return true;
    },
  },
  fetch: async () => { httpCalls++; throw new Error("Unexpected HTTP"); },
  // Deliberately omit verification: no account qualification is claimed.
});
const result = await adapter.consent.read({
  binding, audience, subjectReference, requestId: "read:example", generation: 1,
  deadlineMs: Date.now() + 60000, authorizationReference: "unissued:example",
  operation: "consent.read", payload: {},
});
assert.equal(adapter.capabilities.operations["consent.read"].state, "verification_pending");
assert.equal(result.kind, "refused");
if (result.kind === "refused") assert.equal(result.reason, "verification_pending");
assert.deepEqual({ httpCalls, credentialReads, writes },
  { httpCalls: 0, credentialReads: 0, writes: 0 });
console.log({ result, httpCalls, credentialReads, writes });
```

The Map is an offline fixture, not durable application storage. A real host
supplies current local authorization/consent evidence and exact-byte durable CAS,
shares one availability record per account/environment and starts quarantined
after restart. Quiesce old work, reconcile stored uncertainty, then reconstruct
the adapters. Account qualification binds actual scopes, mappings and safe
effects; copying verification flags from tests cannot establish it.
The newsletter compatibility port remains unsupported. See the
[canonical construction/recovery contract](https://github.com/openlup/openlup/blob/main/docs/platform/CANONICAL_CONTRACTS.md#opt-in-singleton-marketing-adapter)
at the source revision matching the installed package.

### Retained ecommerce events with a fake endpoint

This separate fixture qualifies only its injected endpoint, which simulates
deduplication by existing profile, metric and source identity. It creates no
profile, sends no live request and proves no provider account qualification.
The retained request carries integer JPY money and the currency owner's exponent
provenance; retries reuse those exact bytes. The current local authority check
still runs on every dispatch.

```ts
import assert from "node:assert/strict";
import type { EcommerceEventExportRequest } from "@openlup/platform/communications/contracts";
import { createKlaviyoMarketingAdapter } from "@openlup/platform/communications/klaviyo";
import { currencyExponent } from "@openlup/platform/market-packs";

const binding = Object.freeze({ account: "fake-account", environment: "local",
  namespace: "fake-events", mappingVersion: "ecommerce-v1" });
const subject = { binding, subjectReference: "subject:example", generation: 1,
  erased: false, id: "existing-profile-1", email: "reader@example.invalid",
  externalReference: "local:example", ownedFields: [], ownedProperties: [] };
const request = Object.freeze<EcommerceEventExportRequest>({
  binding, subjectReference: subject.subjectReference, profileId: subject.id,
  generation: subject.generation, authorityReference: "local-authority:example",
  classification: "live", currencyExponent: currencyExponent("JPY"),
  currencyExponentSource: "market-packs.currencyExponent:JPY",
  event: { schemaVersion: 1, sourceId: "paid:example", sourceType: "order.paid",
    occurredAt: "2026-01-01T00:00:30.000Z",
    subject: { clientId: "00000000-0000-4000-8000-000000000001" },
    data: { orderId: "00000000-0000-4000-8000-000000000002",
      settlementIntentId: "00000000-0000-4000-8000-000000000003",
      purchaseKind: "one_time", amountMinor: 1000, currency: "JPY",
      lines: [{ sku: "example-sku", quantity: 1, amountMinor: 1000 }] } },
});
assert.equal(request.currencyExponent, 0);
const retainedDuty = JSON.stringify(request);
let currentAuthority = true, attempts = 0;
let clock = Date.parse("2026-01-01T00:01:00.000Z");
const values = new Map<string, string>(), fakeEffects = new Set<string>();
const adapter = createKlaviyoMarketingAdapter({
  binding, audience: { kind: "account-wide" }, now: () => clock,
  subjectMapper: reference => reference === subject.subjectReference ? subject : undefined,
  resolveCredential: () => ({ binding, key: "synthetic-not-a-real-key" }),
  authorizations: new Map(), localEvidence: new Map(),
  storage: {
    // Fresh empty fake fixture only; a real restart requires quarantined recovery.
    availability: { account: binding.account, environment: binding.environment,
      busy: false, quarantined: false },
    get: async key => values.get(key) ?? null,
    compareAndSwap: async (key, expected, next) => {
      if ((values.get(key) ?? null) !== expected) return false;
      values.set(key, next); return true;
    },
  },
  events: {
    liveSinceMs: Date.parse("2026-01-01T00:00:00.000Z"),
    authorize: candidate => currentAuthority && JSON.stringify(candidate) === retainedDuty,
    // Evidence belongs exclusively to the fake endpoint below. Never copy to a live account.
    verification: { binding, revision: "2026-07-15", evidenceReference: "fake-endpoint-only",
      scopes: ["events:write"], sourceTypes: ["order.paid"],
      accountEffectsVerified: true, messageOwnershipVerified: true },
  },
  fetch: async (url, init) => {
    assert.equal(url, "https://a.klaviyo.com/api/events");
    assert.equal(init?.method, "POST");
    const { data: { attributes } } = JSON.parse(String(init?.body)) as {
      data: { attributes: { profile: { data: { id: string } };
        metric: { data: { attributes: { name: string } } }; unique_id: string;
        value: number; value_currency: string } } };
    assert.equal(attributes.value, 1000);
    assert.equal(attributes.value_currency, "JPY");
    attempts++;
    const identity = [attributes.profile.data.id,
      attributes.metric.data.attributes.name, attributes.unique_id];
    assert.deepEqual(identity, [subject.id, "Placed Order", request.event.sourceId]);
    fakeEffects.add(JSON.stringify(identity));
    return new Response(null, { status: 202 });
  },
});
assert.equal((await adapter.events.exportEvent(request)).kind, "accepted");
clock += 1000;
assert.equal((await adapter.events.exportEvent(request)).kind, "accepted");
assert.deepEqual({ attempts, fakeEffects: fakeEffects.size }, { attempts: 2, fakeEffects: 1 });
currentAuthority = false;
assert.deepEqual(await adapter.events.exportEvent(request), { kind: "refused", reason: "restricted" });
assert.equal(attempts, 2);
console.log({ attempts, fakeEffects: fakeEffects.size, acceptance: "not ingestion evidence" });
```

The Map and Set model only local fixture storage and fake endpoint effects.
A real host retains the exact projected duty, current authority and currency
provenance durably; shares account availability; and reconciles uncertainty before
clearing startup quarantine. Keep the live cutoff and mapping version fixed on
retry. HTTP acceptance does not prove ingestion, flow execution or message
delivery, and this fixture does not establish real receiver deduplication.

For the native PostgreSQL composition, install the complete migration chain and
use `createPostgresEcommerceEventProjection` from the public communications entry.
Supply one `binding`, immutable `liveSince`, `now`, local `resolveTarget`, and
`withTransaction` that commits or rolls back the entire callback on one database
connection. Supply `currency: { code, exponent, provenance }` from the host's
selected settlement profile and currency owner. Call `initialize` with the
approved new-fact cutoff, then `project(limit)` in a bounded postcommit job.
Do not call it as a new prerequisite of payment commit.

Bind `createPostgresEcommerceEventHandler` to the same binding/transaction owner,
the selected adapter's `events` port, clock and current `authorize` callback.
Register that handler in its own outbox invocation with only
`ECOMMERCE_EXPORT_EVENT_TYPE`; run commerce handlers in a separate invocation and
lease. The worker owns dispatch/claim retries; the projector owns source handoff.
Supply the selected finite platform vocabulary as `knownEventTypes`; known
unclaimed facts do not become handlers, and an unknown type still refuses.
The adapter's synchronous authority callback must also check the exact retained
duty and current subject immediately before HTTP. A missing target records a
visible refusal and cannot block unrelated subjects.

An unknown/dispatching receipt stays retained. Stop and quiesce the export lane,
inspect the privileged matching receipt/digest, obtain provider evidence, then
call `reconcilePostgresEcommerceEvent` with that exact digest, binding, evidence
reference and explicit resolution. An identical retry additionally requires
qualified deduplication and current authority; it preserves the original request.
The helper refuses live claims and mismatched evidence. Keep raw projections
and recovery snapshots out of logs. This operator action needs application-owned
authentication and never fabricates account qualification.


## Sources and declarations

Read the installed `src/`, exported `dist/` declarations and their declaration
maps before guessing a contract. The shipped SQL is applied only through the
explicit installation route in the [README](README.md#install-the-portable-postgresql-schema).
Repository links in context excerpts refer to the matching package release tag;
those repository files are not paths to create in the application.

## Readiness codes

Core's checker reports `OPENLUP_E_PORT_MISSING`, `OPENLUP_E_EVENT_UNHANDLED`,
`OPENLUP_E_EVENT_DUPLICATE`, `OPENLUP_E_SCHEDULE_UNBOUND`, `OPENLUP_E_SCHEMA_BEHIND`,
`OPENLUP_E_SET_MISMATCH` and `OPENLUP_E_ENV_MISSING`. Only a `ready` report admits
its exact selected candidate. Unknown observations refuse activation; metadata
alone does not establish SQL bodies, ACLs, provider recovery or hosted qualification.

## Using this package in an application

Use declared public exports. Do not edit `node_modules/@openlup/**`, patch,
fork, vendor, monkey-patch, shadow or restore a copied package engine
autonomously. Supply application-owned handlers, ports, configuration and policy
through documented seams. If a seam is missing, keep a local reproducer and
obtain authority before proposing it upstream; hold the dependent change or use
a compatible wrapper or rollback while preserving pending obligations.

Upgrade every `@openlup/*` package together, pin exact versions and read every
changelog's `Migration:` blocks. Apply the complete packaged migration chain
through the application's explicit installation route; never rewrite published
SQL. Optional peers and selected services need their own configuration, readiness
and application authorization. Installation does not activate a host or provider.

This guide describes the installed contract and grants no host/tool/external-write
authority. The application's own `AGENTS.md` governs. Inside the OpenLup monorepo,
the repository root `AGENTS.md` governs instead.
