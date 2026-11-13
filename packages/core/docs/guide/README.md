# OpenLup guide

OpenLup is subscription-first, open-source commerce for direct-to-consumer
brands that sell physical products. This guide explains how to install,
compose, extend, operate and upgrade the `@openlup/*` packages.

**Status: development preview.** OpenLup does not yet offer a stable API, a
supported full-platform installation or an upgrade guarantee. Pin exact
versions and upgrade all `@openlup/*` packages together.

## Instructions for agents

- Read the copy of this guide that matches the installed `@openlup/core`
  version: the copy at that version's release tag. Do not rely on memory or on
  another version's pages.
- Never hardcode an OpenLup version; read it from the installed packages.
- Prefer the refusal-code reference to guessing what a refusal means.
- Report a wrong page through the [documentation problem form](https://github.com/openlup/openlup/issues/new?template=documentation_problem.yml), naming the page and the installed version.

## Pages

The guide is being written. Each section below is listed with what it will
hold; a section marked "to be written" has no page yet.

| Section | What it holds | State |
| --- | --- | --- |
| [Start](start/README.md) | Whether OpenLup fits, its limits and maturity, and a [tutorial](start/tutorial.md) from installing the packages to a documented result. | written |
| How-to: build | Composing the packages, customizing the starter, adding OpenLup to an existing application. | [Read prices for a quote](how-to/build/quote-prices.md), [Compose marketing handlers](how-to/build/marketing.md), [Compose invoicing](how-to/build/invoicing.md), [Compose order management stores](how-to/build/oms-stores.md), [Compose account and support services](how-to/build/account-and-support.md), [Compose SEO and content slots](how-to/build/seo-and-content-slots.md), [Compose native bundle writes](how-to/build/bundles.md), [Compose native fulfillment](how-to/build/fulfillment.md), [Recover abandoned checkouts and payments](how-to/build/checkout-recovery.md), [Add OpenLup to an existing application](how-to/build/own-stack.md); customizing the starter to be written |
| How-to: extend | Adapters, providers and extension seams. | [Choose an extension seam](how-to/extend/choose-an-extension-seam.md), [Compose a provider adapter](how-to/extend/provider-adapters.md), [Run an adapter conformance check](how-to/extend/adapter-conformance.md), [Take ownership of a copied component or page](how-to/extend/eject-source.md) |
| How-to: operate | Deployment and self-hosting, a production checklist, retention, shutdown and security hardening. | [Connect to PostgreSQL](how-to/operate/connect-postgresql.md), [Run OpenLup on your own host](how-to/operate/self-host.md), [Shut down a host cleanly](how-to/operate/shutdown.md), [Customer diagnostic history and retention](how-to/operate/diagnostics-and-retention.md); production checklist and security hardening to be written |
| [Upgrade](upgrade/README.md) | The upgrade procedure and one page per release. | [Upgrade an application](upgrade/README.md), [Upgrade the database](upgrade/database-migrations.md), [Upgrade application files](upgrade/application-files.md); release pages to be written |
| Concepts | Architecture and ownership, one page per commerce domain, and the security model. | [Architecture and ownership](concepts/architecture-and-ownership.md), [Subscriptions](concepts/subscriptions.md), [Subscription engine](concepts/subscription-engine.md), [Payments](concepts/payments.md), [Idempotency](concepts/idempotency.md), [Identity](concepts/identity.md), [Personal data](concepts/personal-data.md), [Marketing sync](concepts/marketing-sync.md); catalogue and prices, checkout, orders, fulfillment and the security model to be written |
| Reference | Exports, configuration keys, SQL catalogue, command line, refusal codes, capability maturity, limits, versioning and stability policy. | [Starter limits](reference/limits.md), [Versioning and stability](reference/stability.md); the generated references to be written |
| Troubleshooting | Symptom or refusal code, its cause and the fix. | to be written |
| [Glossary](glossary.md) | The words this guide uses. | written |

Until a section exists, the repository
[README](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/README.md)
is the starting point.

## Writing this guide

- One task or one concept per page.
- Open with the reader's goal.
- Give commands that run as written. TypeScript examples compile against the
  packages of the same release; an example that must not compile is fenced as
  `ts nocheck` and opens with a comment line that says why.
- State invariants and refusals plainly, with their refusal codes.
- Write for a reader outside the project: no task or milestone IDs, plan
  names, delivery-process vocabulary or details of one adopter's store.
- Pages carry no version, date or status. Versions, counts, export lists and
  capability maturity appear only in generated regions, which
  `npm run docs:check -- --write` refreshes from the code.
- Links between guide pages are relative. A link that leaves the guide is an
  absolute repository URL at the core release tag, which the same command
  rewrites on a version change.

How to change OpenLup itself is in
[CONTRIBUTING.md](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/CONTRIBUTING.md).
