# @openlup/outbox

Transactional PostgreSQL outbox rail providing atomic event enqueue, at-least-once dispatch, lease-bound scheduled jobs, and typed handler registry composition. Your application owns database transactions, credentials, drivers, and handler idempotency.

[![Node >=24](https://img.shields.io/badge/node-%3E%3D24-339933)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6)](https://www.typescriptlang.org)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/outbox/LICENSE)
[![npm provenance](https://img.shields.io/badge/npm-provenance-CB3837)](https://www.npmjs.com/package/@openlup/outbox)

[Outbox Guide](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/core/docs/guide/how-to/build/outbox.md) ·
[Changelog](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/outbox/CHANGELOG.md) ·
[Upgrade Guide](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/core/docs/guide/upgrade/README.md) ·
[Stability Policy](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/core/docs/guide/reference/stability.md#public-api) ·
[Agent Guide](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/outbox/AGENTS.md)

## Which `@openlup/*` package do I need?

| Package | Role | Install when you need |
| --- | --- | --- |
| [`@openlup/core`](https://www.npmjs.com/package/@openlup/core) | Pure TypeScript kernels & contracts | I/O-free subscription, bundle, pricing, promo, fulfillment, readiness, and outbox contracts (required peer) |
| [`@openlup/outbox`](https://www.npmjs.com/package/@openlup/outbox) | Transactional PostgreSQL outbox rail | Transactional PostgreSQL event enqueue, at-least-once dispatch, lease-bound schedules, and handler composition |
| [`@openlup/platform`](https://www.npmjs.com/package/@openlup/platform) | Full Node.js & PostgreSQL commerce runtime | Headless checkout, payments, subscriptions, fulfillment, invoicing, promotions, catalog, identity, migrations, and HTTP/BFF server runtime |

## Install & Quickstart

Pin exact versions and install `@openlup/core` at the matching version. Node 24 or newer is required.

```sh
npm install --save-exact @openlup/core @openlup/outbox
```

```ts
import { createPostgresOutboxStore } from "@openlup/outbox/postgres";
import type { SqlExecutor } from "@openlup/core/readiness";
export const bindStore = (executor: SqlExecutor) => createPostgresOutboxStore(executor);
```

This CI-compiled example binds a PostgreSQL outbox store; the supplied `executor` must commit each operation before resolving. Dispatch provides at-least-once delivery with claim/acknowledgement fencing, not a universal exactly-once guarantee — read [Idempotency across retries](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/core/docs/guide/concepts/idempotency.md#handler-effects-across-retries) and [Deliver events with the outbox](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/core/docs/guide/how-to/build/outbox.md) before production use.

Declaration maps connect `dist/` declarations to shipped `src/`; JavaScript source maps are not shipped. Read the [Agent Guide](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/outbox/AGENTS.md) for application ownership and extension boundaries.

## Package Surface Maturity

<!-- generated:maturity:outbox -->
| Export | Role | Maturity |
| --- | --- | --- |
| `.` | rail | stable |
| `./postgres` | rail | stable |
| `./testing` | testing | testing |
<!-- /generated:maturity:outbox -->

## PostgreSQL installation and transactions

[`sql/manifest.json`](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/outbox/sql/manifest.json) binds [`sql/0001_outbox.sql`](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/outbox/sql/0001_outbox.sql) to its public migration owner.

- **PostgreSQL 16+:** Required for the validated timestamp parser used by compaction. Claims retain six fractional timestamp digits.
- **Compaction & retention:** Prune defaults are 30 days for processed events and 90 days for discarded events, in batches of 500 (`src/postgres.ts`).
- **Configuration & diagnostics:** The parser and `validateScheduledConfig` live in [`src/config.ts`](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/outbox/src/config.ts); the optional diagnostics deadline in `src/worker.ts` is three seconds.
- **Runtime admission:** Follow [Admit and bind the candidate](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/core/docs/guide/how-to/build/outbox.md#admit-and-bind-the-candidate) and [PostgreSQL installation and transactions](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/core/docs/guide/how-to/build/outbox.md#postgresql-installation-and-transactions).

## Documentation & Guides

- [Deliver events with the outbox](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/core/docs/guide/how-to/build/outbox.md) — handler composition, schedules, readiness, and retention.
- [Idempotency](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/core/docs/guide/concepts/idempotency.md#handler-effects-across-retries) — deduplicating handler effects across retries.
- [Start and tutorial](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/core/docs/guide/start/README.md) — adopting OpenLup from npm.
- [Extension seams](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/core/docs/guide/how-to/extend/choose-an-extension-seam.md) — choosing ports, handlers, and adapters without patching package bytes.
- [Glossary](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/core/docs/guide/glossary.md) — shared domain terminology.

## For AI Coding Agents

`@openlup/core` ships the offline `openlup-context` CLI and MCP server, which index `@openlup/outbox`'s installed `AGENTS.md`, `README.md`, declarations, exports, and `CHANGELOG.md` alongside the reader guide:

```sh
./node_modules/.bin/openlup-context search "outbox PostgreSQL enqueue transaction"
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

- **Release channel & provenance:** Published to npm on the `latest` dist-tag with OIDC provenance from annotated release tags (`openlup-outbox-v<version>`).
- **SemVer & open unions:** Stable subpaths follow the [stable API contract](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/core/docs/guide/reference/stability.md#public-api). Unions and literal sets are open — additions are minor, so consumers must keep a default branch for unknown values.
- **Upgrade the set together:** Pin exact versions and read [CHANGELOG.md](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/outbox/CHANGELOG.md) and the [Upgrade Guide](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/core/docs/guide/upgrade/README.md) before upgrading. Use ports and composition; do not patch installed package bytes.
- **Contributor verification & artifact limits:** See [CONTRIBUTING.md](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/CONTRIBUTING.md#test-scope-and-diagnostics), the [outbox disposable PostgreSQL consumer proof](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/docs/platform/DEVELOPMENT_AND_RELEASE.md#outbox-disposable-postgresql-consumer-proof), and [package artifact limits](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/.github/VERSIONING_AND_EOL.md#package-artifact-limits).
