# Architecture and ownership

Use OpenLup's commerce engines while keeping your application's identity, policy
and integrations under your control. This page explains where to put application
code, which packages to compose, and which data belongs to each owner.

## Platform and application

OpenLup owns the packaged engine algorithms, their public contracts and their
platform data migrations. Your application owns its brand, presentation,
catalogue, local market rules, provider selection and business integrations.
The reference application shows one composition; it does not choose those things
for you.

Keep handlers, local policies, port implementations and host bindings in your
application. A port is a contract for an operation; an adapter implements that
contract for a particular provider or runtime. Supplying an adapter lets you
change an integration while preserving the engine's contract.

Import only declared public package exports. Keep the installed engine in its
package: an application agent must not independently patch, fork, vendor,
monkey-patch, shadow its imports or restore a copied engine. Application-owned
handlers and compatible adapters remain ordinary application code. An additional
writer competing for the same engine state is not an extension seam.

## Packages and dependencies

| Package | Responsibility | What your application supplies |
| --- | --- | --- |
| `@openlup/core` | Shared commerce contracts and I/O-free logic, including subscription and pricing engines, outbox envelopes and runtime ports. Its kernel exports read no environment, open no connections and start no process. | Data and policy inputs, port implementations and composition. |
| `@openlup/outbox` | Transactional outbox dispatch, handler registry composition, lease-bound schedules and a default PostgreSQL store. | Event handlers and their effects, producer transactions, a SQL executor, credentials, guards and schedule triggers. |
| `@openlup/platform` | Runnable server infrastructure: Node HTTP, backend-for-frontend dispatch, scheduling, blob storage, data gateways, migrations and bundle composition, plus optional commerce capabilities. | Selected services, runtime and provider bindings, credentials, authorization, policy and host entrypoints. |

Core is the **kernel**: shared contracts and pure logic. A **rail** supplies runtime
infrastructure used by capabilities; outbox and platform's server foundation are
rails. A **capability** owns a commerce responsibility and its processes, data
contract and local types. An **implementation** binds a port to a provider or
runtime. These responsibilities also apply to modules inside a package;
`@openlup/platform` contains both infrastructure and capability entries.

Dependencies point toward contracts and shared infrastructure:

- The kernel depends on no other `@openlup/*` package.
- Rails depend on the kernel.
- Capabilities use the kernel and rails through declared contracts and ports.
- Implementations depend on the contracts of the responsibility they implement.
  A capability does not depend on another capability's implementation or use cases.

Both outbox and platform declare core as a peer dependency. Application
composition connects them through public ports; neither package imports the
other. The application chooses the concrete bindings even when a package supplies
a generic composer. Importing a package does not start a host or activate a
provider.

For the package contracts, see the
[core agent guide](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/packages/core/AGENTS.md),
[outbox agent guide](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/packages/outbox/AGENTS.md)
and [platform agent guide](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/packages/platform/AGENTS.md).

## Runtime boundaries

Browser code uses portable types, validation, clients and pure logic. Server code
handles requests, runs use cases, makes authorization decisions and accesses
persistence through ports. Keep database connections and provider credentials on
the server.

Choose the entry for the runtime you are building. For example,
`@openlup/platform/commerce` exposes browser-safe schemas and helpers,
`@openlup/platform/commerce/contracts` exposes types, and
`@openlup/platform/commerce/server` holds Node-only handlers, stores and adapters.
`@openlup/platform/pricing/browser` supplies browser-safe quote primitives. A
package containing a browser entry can also contain server entries; do not infer
browser safety from the package name alone.

Domain policy talks to ports and neutral contracts. Infrastructure translates
provider protocols and payloads; adapters implement the selected provider or
runtime binding. Provider-specific payloads and raw status values stop at that
boundary. Durable state belongs to the data contract, rather than to a browser
client or a provider response.

The application owns environment selection, routing, authorization bindings,
connection lifetime and the decision to start services. The platform supplies
factories; your host supplies deployment values and invokes them.

## Data ownership

OpenLup owns its platform objects, migration history and documented data contracts.
The portable PostgreSQL catalogue places commerce tables, routines and the
migration ledger in `public`, actor identity helpers in `auth`, and private
acquisition storage in `acquisition_private`. These are platform objects to manage
through the packaged migration chain, not places for application extensions.

Keep adopter-specific tables and their migrations in your application's own
`app` schema. The platform never writes to `app`. Your application owns extension
compatibility and migration ordering. Connect extension data to platform data
through explicit foreign keys, ports or events; do not change platform rows based
on undocumented assumptions.

The platform's migration history and your application's extension history have
separate owners. Starting an application process is not a substitute for
coordinating migrations across running instances.
