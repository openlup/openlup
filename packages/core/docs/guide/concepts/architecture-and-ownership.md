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

Application code needs neither a per-function ownership record nor an upstream
release. Historical origin in OpenLup does not freeze unpackaged application
source. One engine owner can serve several hosts when admission, fencing and
retirement preserve a single authority over state. Consume an exact authenticated
artifact and check the actual serving bindings; a dependency pin alone cannot
prove which implementation receives work.

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

Core's only runtime dependency is `zod`.

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
[core agent guide](https://github.com/openlup/openlup/blob/openlup-core-v0.40.0/packages/core/AGENTS.md),
[outbox agent guide](https://github.com/openlup/openlup/blob/openlup-core-v0.40.0/packages/outbox/AGENTS.md)
and [platform agent guide](https://github.com/openlup/openlup/blob/openlup-core-v0.40.0/packages/platform/AGENTS.md).

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

### Market and marketing composition

Market rules, directory lookup/cache and pure descriptors remain separate from
language, settlement currency, pricing region and fiscal jurisdiction. Supply
those inputs independently. Selecting a market recipe installs no route,
environment reader or translation runtime. Manual shipping does not require a
directory suggestion. During a store transfer, the host owns source quiescence,
deployment consistency and equivalent drain routing for its own endpoints.

Use `@openlup/platform/marketing` for browser-safe acquisition/prelaunch schemas,
analytics, SEO and legal/contact projections; `marketing/contracts` supplies
shared types. `marketing/server` contains Node-only acquisition handlers,
history/prelaunch/evidence factories and research handlers. PostgreSQL factories,
including `createPostgresPartnerAcquisitionPort`, are in
`marketing/server/postgres`. Browser entries load no server code or driver.
Supply the responder, authorization, storage, notification content, method/wire
validation, view selection, drain policy, routes and connection lifetime.
Imports activate no route, executor or schedule.

The partner port supplies no rich managed CRM transitions, customer conversion,
marketing opt-in or partner privacy export/erasure. An actor UUID passed to SQL
is not administrator authority; establish that authority before resolving the
port. Research uses core contracts and communications delivery contracts.

Analytics factories are instance-scoped. Supply step/event vocabulary, browser
and storage access, consent, `consentSignalNames`, container selection, sinks,
route manifests and sensitive fields. Missing consent signal bindings disable
consent commands and optional events while deployment attempts stay independent.
Local sink admission does not prove remote delivery or payment truth.

`createAnalyticsContextHandler` needs a responder, enable reader, store, bearer
reader, verified subject resolver, token mint/hash functions, cookie name and
`clientIdField`. Its ports are server-only. Withdrawal does not require identity;
enrollment uses a verified subject, and replacing a revoked context needs
explicit consent. Supply persistence and its authority: no default context SQL
is installed. Context failures do not gate commerce; `active` is only a local
context fact.

SEO helpers serialize JSON-LD, construct graphs and derive URL, hreflang and head
data. Supply identity, origin, locale, images, routes, document wording and
processor disclosures. They select no renderer or provider and mutate no document;
rendering and content policy remain application-owned.

`createMarketingPrivacyBindings` defaults off and selects a contributor only
with both acquisition and remote-erasure owner ports. If either owner is absent,
all marketing resources remain unavailable and unresolved without calling either.
`createMarketingPrivacyContributor` makes no preparation/assessment writes;
identity assesses every contributor before mutation. Failed fencing throws to
roll back the unit of work. Remote request acceptance records retention with an
reason that acceptance has not established completion; remote profile export stays unavailable.
Workers, operators, storage, remote execution and late-import orphan handling
remain yours. See [Personal data](personal-data.md#personal-data-coverage).

### Commerce, delivery and payments

The browser pricing entry exposes quote primitives and acquisition/shipping
terms validators without the Node pricing root. Commerce effect consumers need
the communications payload parser, transactional-email scaffold and outcome
mapper through typed bindings. These consumers and registries start no worker,
emitter or schedule. Supply locale, presentation and provider policy.

Replacement creation records no delivery arrival or subscription transition.
Private review media needs upload, private read/inspection, temporary storage
and transactional promotion seams; the generic blob port does not supply them
all. Hosted review feedback requires application-supplied managed routines.

Accounting-duty collection is an independent host-invoked binding. Selecting
fulfillment does not start or await it. The host owns collection scheduling,
identity, authorization, transport and transaction boundaries.

Compose payments through the bundle's optional named binder and
`createPaymentServices`, supplying a scoped truth port and cleanup. Missing schema
or capability refuses selection. No package discovers environment or drivers;
retain exclusive executor ownership for each runtime unit and supply scheduling
explicitly.
Status verification requests readback rather than marking payment paid. The
status reader checks stored ownership/current attempt and a second canonical
read. Supply rail handoff capabilities, callbacks, token handling and customer/
subscription authority. Method collection alone cannot charge or redeem an
obligation; native setup needs a supplied implementation. First durable ingress
receipts keep their original instant on replay, even if a later provider
observation supplies a later timestamp.

A reloaded basket total cannot authorize checkout navigation: require the fresh
signed quote and explicit matching terms acceptance. Basket edits clear those
terms and expectations. Read-only lifecycle observations grant no publication
or withdrawal authority. Minor-money formatting requires a known currency
exponent, including fallback rendering.

Shipping server handlers need explicit geographic/source/tax validation, country
defaults and conflict identity. Flat-rate administration additionally needs
schemas, authorization and a responder. Address persistence stays behind ports;
a package import supplies no map loader or pickup-search UI. Bundle availability
comes from the catalogue answer rather than browser-derived inventory.

Dispatch acknowledgement is not physical packing. A fulfillment partner's
`3pl` dispatch does not create an owned label. Only recorded status evidence
supplies local occurrence chronology; receiving an observation alone does not.
Supply authoritative inventory lines and frozen contact preparation. Stock
movement keys and fingerprints preserve replay identity, while cursor state
can still report coverage gaps.

### Admission and lifecycle ownership

Compose selected services into one readiness report with observed package and
adapter facts. Unknown inventory or probe state cannot activate a candidate;
an admitted identity or outbox candidate grants no communications authority.
Schema inventories establish presence, not ACL or function-body correctness.
The host must admit the actual route and schedule functions before listening.

[Identity](identity.md) owns email-trust, invitation and session behavior.
A host selects verified actor reads, live membership, separate human/machine
credentials, a deployment route policy and verifier readiness. External-token
relying parties own local sessions and refresh credentials; token expiry and
live membership remain separate authorities. Provider SDKs stay outside browser
contracts. [Personal data](personal-data.md) owns contributor coverage and
assessment before mutation.

For outbox, commit each claim or settlement before resolving the worker store
call; do not hold an encompassing transaction across handler effects. The host
supplies immediate worker invocation and lease-bound schedule triggers. See
[idempotency](idempotency.md#handler-effects-across-retries).

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

Activation commits service and the renewal-attachment duty together; header,
lines and method materialize in a separate atomic transaction. An incomplete
duty remains enumerable without pausing service. Method-health transitions
compare expected state and persist their evidence without rewriting service
state. Terminal renewal replay precedes due eligibility; cancelled subscriptions
refuse new work.
