# OpenLup

**Subscription-first, open-source commerce for physical products.**

Build recurring orders, payments and delivery cycles into your TypeScript
application. Your application owns its brand, catalogue, policies and
integrations; OpenLup supplies reusable commerce engines and contracts.

[Reader guide](packages/core/docs/guide/README.md) ·
[Start here](packages/core/docs/guide/start/README.md) ·
[Apache-2.0](LICENSE)

## Status: development preview

> **Development preview.** OpenLup has published npm packages and bounded local
> evaluation profiles. It does not yet offer a stable framework API, a supported
> full-platform installation or an upgrade guarantee. Source availability and a
> successful build do not establish production readiness.

## Is OpenLup for you?

Read the [overview](packages/core/docs/guide/start/README.md) for application ownership, package choices and next steps.

## Choose an evaluation path

Compare the [evaluation boundaries](packages/core/docs/guide/reference/limits.md#evaluation-boundaries) before selecting packages, the starter or a source reference.

### Use OpenLup in your application

From your application's root, look up the published package-set version:

```sh
npm view @openlup/core version
```

Replace `<version>` with that exact value:

```sh
npm install --save-exact @openlup/core@<version>
```

Use the same exact version for every `@openlup/*` package you install. See
[installation and application instructions](packages/core/docs/guide/start/README.md#install-the-packages).

### A small example

Calculate renewal-payment retry times with an application-supplied policy:

```ts
import { nextRetryAttemptAt } from "@openlup/core/subscription";

const failedAt = "2026-01-10T09:00:00.000Z";
const cadence = { backoffHours: [24, 72] };

nextRetryAttemptAt(failedAt, 1, cadence); // "2026-01-11T09:00:00.000Z"
nextRetryAttemptAt(failedAt, 2, cadence); // "2026-01-13T09:00:00.000Z"
nextRetryAttemptAt(failedAt, 3, cadence); // null: the retry budget is exhausted
```

This calculates a time; it does not schedule work, persist state or charge.
Continue with the [example explanation](packages/core/docs/guide/start/tutorial.md#calculate-a-retry-time)
and the [database tutorial](packages/core/docs/guide/start/tutorial.md).

## Packages and architecture

| Package | Responsibility | Export maturity |
| --- | --- | --- |
| [`@openlup/core`](packages/core/README.md) | Commerce contracts and pure engines | [Core table](packages/core/docs/guide/start/README.md#openlupcore) |
| [`@openlup/outbox`](packages/outbox/README.md) | Transactional enqueue and dispatch | [Outbox table](packages/core/docs/guide/start/README.md#openlupoutbox) |
| [`@openlup/platform`](packages/platform/README.md) | Server infrastructure and optional commerce services | [Platform table](packages/core/docs/guide/start/README.md#openlupplatform) |

Read [architecture and ownership](packages/core/docs/guide/concepts/architecture-and-ownership.md)
for package composition and application boundaries.

## Current limits and direction

Read [current limits](packages/core/docs/guide/reference/limits.md) and [versioning and stability](packages/core/docs/guide/reference/stability.md).

## Designed for development with AI agents

Start with your application's instructions and the [installed-version guide](packages/core/docs/guide/README.md#instructions-for-agents); platform contributors start with [AGENTS.md](AGENTS.md).

## Documentation and contribution

- [Reader guide](packages/core/docs/guide/README.md), [glossary](packages/core/docs/guide/glossary.md) and [upgrades](packages/core/docs/guide/upgrade/README.md).
- [Contributing](CONTRIBUTING.md), [maintainer documentation](docs/platform/README.md) and [source map](docs/platform/SOURCE_MAP.md).
- [Releases](https://github.com/openlup/openlup/releases) and [issue reports](https://github.com/openlup/openlup/issues).
- [Security reporting](SECURITY.md), [governance](.github/GOVERNANCE.md) and [Code of Conduct](CODE_OF_CONDUCT.md).

## License and openness

OpenLup is licensed under [Apache License 2.0](LICENSE). See the [tier policy](.github/TIER_POLICY.md) for the open-core commitment.
