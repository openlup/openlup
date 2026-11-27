# @openlup/platform

Headless subscription commerce platform for Node.js and PostgreSQL — compose checkout, payments, subscriptions, fulfillment, invoicing, promotions, catalog, identity, migrations, and HTTP/BFF dispatch in your own application. Imports never activate services or bind providers; your application owns composition, credentials, routes, and policy.

[![Node >=24](https://img.shields.io/badge/node-%3E%3D24-339933)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6)](https://www.typescriptlang.org)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/platform/LICENSE)
[![npm provenance](https://img.shields.io/badge/npm-provenance-CB3837)](https://www.npmjs.com/package/@openlup/platform)

[OpenLup Guide](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/core/docs/guide/README.md) ·
[Deep Module Reference](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/docs/platform/PLATFORM_PACKAGE_REFERENCE.md) ·
[Changelog](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/platform/CHANGELOG.md) ·
[Upgrade Guide](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/core/docs/guide/upgrade/README.md) ·
[Stability Policy](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/core/docs/guide/reference/stability.md#public-api) ·
[Agent Guide](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/platform/AGENTS.md)

## Which `@openlup/*` package do I need?

| Package | Role | Install when you need |
| --- | --- | --- |
| [`@openlup/core`](https://www.npmjs.com/package/@openlup/core) | Pure TypeScript kernels & contracts | I/O-free subscription, bundle, pricing, promo, fulfillment, readiness, and outbox contracts (required peer) |
| [`@openlup/outbox`](https://www.npmjs.com/package/@openlup/outbox) | Transactional PostgreSQL outbox rail | Transactional PostgreSQL event enqueue, at-least-once dispatch, lease-bound schedules, and handler composition |
| [`@openlup/platform`](https://www.npmjs.com/package/@openlup/platform) | Full Node.js & PostgreSQL commerce runtime | Headless checkout, payments, subscriptions, fulfillment, invoicing, promotions, catalog, identity, migrations, and HTTP/BFF server runtime |

## Install & Quickstart

Pin exact versions and install `@openlup/core` at the matching version. Node 24 or newer is required.

```sh
npm install --save-exact @openlup/core @openlup/platform
```

```ts
import { createScheduledJobRegistry } from "@openlup/platform/scheduler";

export const jobs = createScheduledJobRegistry([
  { id: "app-cleanup", schedule: "0 * * * *", run: async () => {} },
]);
```

This CI-compiled example declares a job registry without starting a host; bind a scheduler and implement the job before running it. The `openlup` CLI (`npx openlup --help`) exposes upgrade and diagnosis commands. Declaration maps connect `dist/` declarations to shipped `src/`; JavaScript source maps are not shipped. Read the [Agent Guide](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/platform/AGENTS.md) for subpath maturity and application ownership rules, or start with the [Self-Host Recipe](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/core/docs/guide/how-to/operate/self-host.md).

## Install the portable PostgreSQL schema

`@openlup/platform/migrations` exports `createPlatformPostgresMigrationRunner`, which runs the complete packaged PostgreSQL 16+ migration catalogue with canonical ledger paths, SHA-256 verification, and host-admission checks — no source checkout required. Install the optional `pg` peer in your application and call `status()`, `apply({ dryRun: true })`, or `apply()` explicitly.

```ts nocheck
// Fragment: the application supplies directUrl, its direct PostgreSQL connection string.
import { createPlatformPostgresMigrationRunner } from "@openlup/platform/migrations";

const migrations = createPlatformPostgresMigrationRunner({ connectionString: directUrl }, {
  installation: {
    generation: "qualified-admin", roleMode: "installer-managed",
    migrationLogin: "app_migrator", bootstrapLogin: "postgres",
    runtimeLogin: "app_runtime", restoreLogin: "app_restore",
  },
});
await migrations.apply();
const status = await migrations.status();
```

Provision your PostgreSQL 16+ host profile first (`qualified-admin` or `qualified-v2`, with `installer-managed` or `operator-provisioned` role mode). Passing an explicit `installation` is required; `legacy` histories cannot be switched in place. See [Database migrations](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/core/docs/guide/upgrade/database-migrations.md#select-the-complete-catalogue) for provisioning and upgrade rules. In a monorepo checkout, regenerate packaged SQL/catalog projections with `checkPlatformMigrationProjection(process.cwd(), true)` from `scripts/packages/platform-migration-projection.ts`.

## Package Surface Maturity

<!-- generated:maturity:platform -->
| Export | Role | Maturity |
| --- | --- | --- |
| `./account-support` | capability | stable |
| `./account-support/contracts` | capability | experimental |
| `./account-support/postgres` | capability | stable |
| `./account-support/read-contracts` | capability | experimental |
| `./accounting` | capability | experimental |
| `./accounting/contracts` | capability | experimental |
| `./accounting/testing` | capability | testing |
| `./adapter-kit` | rail | experimental |
| `./bff` | rail | stable |
| `./blob` | rail | stable |
| `./catalog` | capability | stable |
| `./catalog/contracts` | capability | stable |
| `./catalog/testing` | capability | testing |
| `./channels` | capability | stable |
| `./channels/contracts` | capability | stable |
| `./channels/server` | capability | stable |
| `./channels/testing` | capability | testing |
| `./commerce` | capability | stable |
| `./commerce/contracts` | capability | stable |
| `./commerce/server` | capability | stable |
| `./commerce/server/destinations` | capability | stable |
| `./commerce/server/native-checkout` | capability | stable |
| `./commerce/server/postgres` | capability | stable |
| `./communications` | capability | stable |
| `./communications/contracts` | capability | stable |
| `./communications/klaviyo` | capability | experimental |
| `./communications/testing` | capability | testing |
| `./company-identity` | capability | stable |
| `./company-identity/contracts` | capability | stable |
| `./company-identity/server` | capability | stable |
| `./composition` | rail | stable |
| `./data` | rail | stable |
| `./fulfillment` | capability | stable |
| `./fulfillment/contracts` | capability | stable |
| `./fulfillment/native` | capability | stable |
| `./fulfillment/testing` | capability | testing |
| `./http` | rail | stable |
| `./identity` | capability | stable |
| `./identity/contracts` | capability | experimental |
| `./inventory` | capability | stable |
| `./inventory/contracts` | capability | stable |
| `./invoicing` | capability | stable |
| `./invoicing/contracts` | capability | experimental |
| `./invoicing/postgres` | capability | stable |
| `./job-ledger` | rail | stable |
| `./kernel` | rail | stable |
| `./lifecycle` | rail | experimental |
| `./market-packs` | capability | stable |
| `./marketing` | capability | stable |
| `./marketing/contracts` | capability | stable |
| `./marketing/server` | capability | stable |
| `./marketing/server/postgres` | capability | stable |
| `./migrations` | rail | stable |
| `./observability` | rail | experimental |
| `./observability/contracts` | rail | experimental |
| `./observability/testing` | rail | testing |
| `./operations` | capability | stable |
| `./operations/contracts` | capability | stable |
| `./operations/server` | capability | stable |
| `./payments` | capability | stable |
| `./payments/contracts` | capability | stable |
| `./payments/testing` | capability | testing |
| `./portability` | rail | experimental |
| `./pricing` | capability | stable |
| `./pricing/browser` | capability | stable |
| `./pricing/contracts` | capability | stable |
| `./promotions` | capability | stable |
| `./promotions/contracts` | capability | experimental |
| `./risk` | capability | stable |
| `./risk/contracts` | capability | stable |
| `./risk/server` | capability | stable |
| `./scheduler` | rail | stable |
| `./shipping` | capability | stable |
| `./shipping/contracts` | capability | stable |
| `./shipping/testing` | capability | testing |
| `./storefront` | capability | experimental |
| `./storefront/testing` | capability | testing |
| `./subscriptions` | capability | stable |
| `./subscriptions/contracts` | capability | stable |
| `./tax` | capability | experimental |
| `./tax/contracts` | capability | experimental |

5 subpaths omitted because their names are provider-specific. Complete list: [package.json](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/platform/package.json) and [Subpath maturity](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/platform/AGENTS.md#subpath-maturity).
<!-- /generated:maturity:platform -->

Stable subpaths follow SemVer from `1.0.0`; experimental and testing exports are excluded. See the generated [maturity reference](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/core/docs/guide/reference/maturity.md) for per-symbol maturity.

## Deep Module Reference

Every domain module's detailed contracts, native PostgreSQL stores, refusal boundaries, and conformance proofs live in the [Platform Package Reference](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/docs/platform/PLATFORM_PACKAGE_REFERENCE.md):

| Domain | Subpaths | Reference |
| --- | --- | --- |
| HTTP, BFF, Scheduler, Blob & Composition | `./http`, `./bff`, `./scheduler`, `./blob`, `./data`, `./composition`, `./kernel` | [HTTP runtime](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/docs/platform/PLATFORM_PACKAGE_REFERENCE.md#http-runtime-and-security-contract), [Scheduled jobs](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/docs/platform/PLATFORM_PACKAGE_REFERENCE.md#scheduled-jobs), [Blob storage](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/docs/platform/PLATFORM_PACKAGE_REFERENCE.md#blob-storage) |
| Checkout & Commerce OMS | `./commerce`, `./commerce/contracts`, `./commerce/server`, `./commerce/server/postgres`, `./commerce/server/native-checkout` | [Commerce contracts](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/docs/platform/PLATFORM_PACKAGE_REFERENCE.md#commerce-contracts) |
| Subscriptions & Renewals | `./subscriptions`, `./subscriptions/contracts` | [Subscription contracts & renewal port](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/docs/platform/PLATFORM_PACKAGE_REFERENCE.md#subscription-contracts-and-renewal-port) |
| Payments & Opt-In Adapters | `./payments`, `./payments/contracts`, `./payments/testing` + opt-in adapters | [Payments prepared attempts](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/docs/platform/PLATFORM_PACKAGE_REFERENCE.md#payments-prepared-attempts) |
| Fulfillment, Shipping & Inventory | `./fulfillment`, `./fulfillment/native`, `./shipping`, `./inventory` | [Shipping](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/docs/platform/PLATFORM_PACKAGE_REFERENCE.md#shipping), [Inventory](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/docs/platform/PLATFORM_PACKAGE_REFERENCE.md#inventory), [Fulfillment](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/core/docs/guide/how-to/build/fulfillment.md) |
| Catalog, Pricing, Promotions & Tax | `./catalog`, `./pricing`, `./pricing/browser`, `./promotions`, `./tax`, `./market-packs` | [Catalog](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/docs/platform/PLATFORM_PACKAGE_REFERENCE.md#catalog), [Pricing](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/docs/platform/PLATFORM_PACKAGE_REFERENCE.md#pricing), [Promotions](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/docs/platform/PLATFORM_PACKAGE_REFERENCE.md#promotions), [Tax](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/docs/platform/PLATFORM_PACKAGE_REFERENCE.md#tax-calculation) |
| Invoicing, Identity & Communications | `./invoicing`, `./invoicing/postgres`, `./identity`, `./communications` | [Invoicing](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/docs/platform/PLATFORM_PACKAGE_REFERENCE.md#invoicing-contracts), [Identity](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/docs/platform/PLATFORM_PACKAGE_REFERENCE.md#identity-import-candidate), [Communications](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/docs/platform/PLATFORM_PACKAGE_REFERENCE.md#communications-import) |
| Account, Operations, Risk & Channels | `./account-support`, `./operations`, `./risk`, `./channels`, `./company-identity` | [Account & support](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/docs/platform/PLATFORM_PACKAGE_REFERENCE.md#account-and-support-contracts), [Operations](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/docs/platform/PLATFORM_PACKAGE_REFERENCE.md#operations-and-diagnostics), [Risk](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/docs/platform/PLATFORM_PACKAGE_REFERENCE.md#risk-controls), [Channels](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/docs/platform/PLATFORM_PACKAGE_REFERENCE.md#channels) |
| Lifecycle, Portability & Storefront | `./lifecycle`, `./portability`, `./storefront`, `./storefront/testing` | [Storefront continuation](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/docs/platform/PLATFORM_PACKAGE_REFERENCE.md#storefront-continuation-contracts), [Application file upgrades](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/core/docs/guide/upgrade/application-files.md) |

## Scheduled jobs

`./scheduler` provides transport-neutral `ScheduledJob` declarations, `createScheduledJobRegistry`, lease-aware runners, per-job PostgreSQL advisory locks, and constant-time `CRON_SECRET` bearer verification. The application binds a scheduler, implements effects, and owns host shutdown and external executor fencing. See [Scheduled jobs reference](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/docs/platform/PLATFORM_PACKAGE_REFERENCE.md#scheduled-jobs) for lock semantics and shutdown bounds.

## Provider wiring recipes

For transactional email, email provider setup, marketing automation and ecommerce events, start
with these offline examples from the application root. Save each complete
TypeScript block as a separate `.mts` file and run it with Node 24. The examples
use the installed package exports, synthetic data and injected HTTP only.

The captured delivery and protocol observation recipe is in
[Architecture and extensions](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/docs/platform/ARCHITECTURE_AND_EXTENSIONS.md#captured-delivery-and-protocol-observations);
it is not shipped in this package.

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

### Retained ecommerce events with a fake endpoint

This separate fixture qualifies only its injected endpoint, which simulates
deduplication by existing profile, metric and source identity. It creates no
profile, sends no live request and proves no provider account qualification.

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

For native PostgreSQL projection, outbox handlers, and operator reconciliation, see [Communications import](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/docs/platform/PLATFORM_PACKAGE_REFERENCE.md#communications-import).

## For AI Coding Agents

`@openlup/core` ships the offline `openlup-context` CLI and MCP server, which index `@openlup/platform`'s installed `AGENTS.md`, `README.md`, declarations, exports, and `CHANGELOG.md` alongside the reader guide:

```sh
./node_modules/.bin/openlup-context search "createNodeHttpRuntime"
```

```json
{
  "mcpServers": {
    "openlup-context": {
      "command": "./node_modules/.bin/openlup-context",
      "args": ["mcp"],
      "cwd": "/path/to/your-application"
    }
  }
}
```

See [Agent context lookup](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/core/README.md#agent-context-lookup) for CLI flags and MCP tool usage; your application's `AGENTS.md` governs.

## Upgrading & Compatibility

- **Release channel & provenance:** Published to npm on the `latest` dist-tag with OIDC provenance from annotated release tags (`openlup-platform-v<version>`).
- **Optional peers:** Install `pg` (and `@types/pg`) only when using PostgreSQL adapters or migrations, and `@aws-sdk/client-s3` only when using S3-compatible blob storage.
- **SemVer & open unions:** Stable subpaths follow the [stable API contract](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/core/docs/guide/reference/stability.md#public-api). Unions and literal sets are open — additions are minor, so consumers must keep a default branch for unknown values.
- **Upgrade the set together:** Pin exact versions and read [CHANGELOG.md](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/platform/CHANGELOG.md), the [Upgrade Guide](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/core/docs/guide/upgrade/README.md), and [Application-file upgrades](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/core/docs/guide/upgrade/application-files.md) before upgrading.
