# Is OpenLup for you?

Decide whether OpenLup fits the application you want to build.

## What OpenLup is and who it is for

OpenLup is open-source, subscription-first commerce for physical products. It is for TypeScript developers and commerce teams building replenishment, curated boxes or other recurring purchases who want to own their application. Your application owns its brand, storefront, catalogue, local policies and integrations; OpenLup supplies reusable engines and contracts.

## What it gives you

- **`@openlup/core`** supplies framework-independent TypeScript contracts and pure subscription and bundle logic. Its kernels perform no I/O; your application binds their ports.
- **`@openlup/outbox`** supplies transactional PostgreSQL enqueue, at-least-once dispatch, registry composition and lease-bound schedules. Your application supplies handlers, credentials and transaction ownership.
- **`@openlup/platform`** supplies server infrastructure and optional commerce services: HTTP dispatch, scheduling, storage, data gateways and PostgreSQL migrations. Your application selects services and supplies ports, policy, authorization and host composition; imports do not activate services.

## What it does not do yet

Expect explicit integration work. Compare the
[evaluation boundaries and current limits](../reference/limits.md#evaluation-boundaries)
and the [stability policy](../reference/stability.md) before choosing an
installation path.

## Install the packages

Follow [Adopt OpenLup from npm](adopt-from-npm.md) for package selection, exact
matching pins, installed-package instructions and application ownership.
To find the published package-set version:

```sh
npm view @openlup/core version
```

Use the toolchain declared by the selected release's package manifests.
Continue with the [tutorial](tutorial.md) for a runnable example.

## Maturity

### `@openlup/core`

<!-- generated:maturity:core -->
| Export | Role | Maturity |
| --- | --- | --- |
| `./bundle` | kernel | candidate |
| `./catalog` | kernel | candidate |
| `./company-identity` | kernel | experimental |
| `./fulfillment` | kernel | experimental |
| `./inventory` | kernel | candidate |
| `./marketing/research` | kernel | experimental |
| `./outbox` | kernel | experimental |
| `./partners` | kernel | experimental |
| `./payment` | kernel | experimental |
| `./platform-runtime` | kernel | experimental |
| `./pricing` | kernel | candidate |
| `./promo` | kernel | candidate |
| `./readiness` | kernel | experimental |
| `./risk` | kernel | candidate |
| `./shipping` | kernel | candidate |
| `./standard-schema` | kernel | experimental |
| `./subscription` | kernel | candidate |
| `./testing` | testing | testing |
<!-- /generated:maturity:core -->

### `@openlup/outbox`

<!-- generated:maturity:outbox -->
| Export | Role | Maturity |
| --- | --- | --- |
| `.` | rail | experimental |
| `./postgres` | rail | experimental |
| `./testing` | testing | testing |
<!-- /generated:maturity:outbox -->

### `@openlup/platform`

The platform package's subpaths and their maturity are listed in its
[agent guide](https://github.com/openlup/openlup/blob/openlup-core-v0.41.0/packages/platform/AGENTS.md#subpath-maturity).

## Next steps

- Follow the [tutorial](tutorial.md).
- Look up terms in the [glossary](../glossary.md).
- Read the [upgrade procedure](../upgrade/README.md).
