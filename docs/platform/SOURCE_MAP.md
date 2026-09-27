# Platform source map

Status: development-preview navigation, generated from the public ownership map.

Start with a responsibility below, then open its owner and the linked code.
Descriptions are authored routing purposes. File and symbol inventories are structural
navigation hints; neither establishes behavior, test results or profile availability.

[Documentation maintenance](DOCUMENTATION.md) owns regeneration and impact checks.
[Subscription workflows](SUBSCRIPTION_WORKFLOWS.md) drills into significant internal paths.

<!-- openlup-generated:start -->
## Domains

The domain list is read from the platform domain registry. Shared and server code
use one canonical domain owner unless a narrower workflow route applies.

| Domain | Responsibility | Owner | Source |
| --- | --- | --- | --- |
| accounting | Invoice contracts, canonical document amounts, jobs and delivery outcomes | [README](../../src/domains/accounting/README.md) | [shared](../../src/domains/accounting/) · [server](../../server/domains/accounting/) |
| address-canon | Canonical addresses and pure address normalization | [README](../../src/domains/address-canon/README.md) | [shared](../../src/domains/address-canon/) · [server](../../server/domains/address-canon/) |
| auth | Authentication, sessions, actor contracts and permission policy | [README](../../src/domains/auth/README.md) | [shared](../../src/domains/auth/) · [server](../../server/domains/auth/) |
| bundle | Bundle composition contracts and item selection rules | [README](../../src/domains/bundle/README.md) | [shared](../../src/domains/bundle/) · [server](../../server/domains/bundle/) |
| catalog | Canonical product catalogue contracts and storefront projections | [README](../../src/domains/catalog/README.md) | [shared](../../src/domains/catalog/) · [server](../../server/domains/catalog/) |
| channels | Sales channel contracts, policy and channel operations | [README](../../src/domains/channels/README.md) | [shared](../../src/domains/channels/) · [server](../../server/domains/channels/) |
| checkout | Checkout contracts, admission and purchase orchestration | [README](../../src/domains/checkout/README.md) | [shared](../../src/domains/checkout/) |
| clients | Client identity and shared client contracts | [README](../../src/domains/clients/README.md) | [shared](../../src/domains/clients/) · [server](../../server/domains/clients/) |
| commerce | Orders, commerce contracts and order management use cases | [README](../../src/domains/commerce/README.md) | [shared](../../src/domains/commerce/) · [server](../../server/domains/commerce/) |
| communications | Message contracts, outbox orchestration and delivery ports | [README](../../src/domains/communications/README.md) | [shared](../../src/domains/communications/) · [server](../../server/domains/communications/) |
| company-identity | Company identity and seller-facing shared contracts | [README](../../src/domains/company-identity/README.md) | [shared](../../src/domains/company-identity/) · [server](../../server/domains/company-identity/) |
| customers | Customer contracts, account data and customer use cases | [README](../../src/domains/customers/README.md) | [shared](../../src/domains/customers/) · [server](../../server/domains/customers/) |
| fulfillment | Physical fulfillment, shipment contracts and delivery evidence | [README](../../src/domains/fulfillment/README.md) | [shared](../../src/domains/fulfillment/) · [server](../../server/domains/fulfillment/) |
| inventory | Inventory contracts, stock policy and durable inventory operations | [README](../../src/domains/inventory/README.md) | [shared](../../src/domains/inventory/) · [server](../../server/domains/inventory/) |
| marketing | Marketing, prelaunch and research contracts and use cases | [README](../../src/domains/marketing/README.md) | [shared](../../src/domains/marketing/) · [server](../../server/domains/marketing/) |
| observability | Operational events and retained diagnostic contracts | [README](../../src/domains/observability/README.md) | [shared](../../src/domains/observability/) · [server](../../server/domains/observability/) |
| partners | Partner contracts and partner-facing domain rules | [README](../../src/domains/partners/README.md) | [shared](../../src/domains/partners/) · [server](../../server/domains/partners/) |
| payment | Payment status vocabulary, provider-neutral ports and money-path rules | [README](../../src/domains/payment/README.md) | [shared](../../src/domains/payment/) · [server](../../server/domains/payment/) |
| platform | Platform control, capabilities and operational contracts | [README](../../src/domains/platform/README.md) | [shared](../../src/domains/platform/) · [server](../../server/domains/platform/) |
| platform-runtime | Shared runtime contracts and runtime configuration seams | [README](../../src/domains/platform-runtime/README.md) | [shared](../../src/domains/platform-runtime/) · [server](../../server/domains/platform-runtime/) |
| pricing | Pricing contracts, calculations and price policy | [README](../../src/domains/pricing/README.md) | [shared](../../src/domains/pricing/) |
| promo | Promotion contracts and promotion eligibility rules | [README](../../src/domains/promo/README.md) | [shared](../../src/domains/promo/) |
| risk | Risk contracts and admission policy | [README](../../src/domains/risk/README.md) | [shared](../../src/domains/risk/) · [server](../../server/domains/risk/) |
| shipping | Shipping contracts, quotes and carrier-neutral rules | [README](../../src/domains/shipping/README.md) | [shared](../../src/domains/shipping/) · [server](../../server/domains/shipping/) |
| subscription | Subscription contracts, self-service policy and server orchestration | [README](../../src/domains/subscription/README.md) | [shared](../../src/domains/subscription/) · [server](../../server/domains/subscription/) |
| support | Support contracts and operator-facing use cases | [README](../../src/domains/support/README.md) | [shared](../../src/domains/support/) · [server](../../server/domains/support/) |

## Other responsibilities

| Surface | Purpose | Canonical owner | Selectors |
| --- | --- | --- | --- |
| repository | Repository entrypoints, build configuration and contributor setup | [CONTRIBUTING.md](../../CONTRIBUTING.md#development-preview-checks) | `*` |
| public-policy | Public contribution policy and community governance | [CONTRIBUTING.md](../../CONTRIBUTING.md#pull-requests) | `.github/**` |
| public-checks | Hosted execution ownership and the checks contributors must run | [CONTRIBUTING.md](../../CONTRIBUTING.md#development-preview-checks) | `.github/workflows/**` |
| documentation | Public documentation navigation and current writing guidance | [docs/platform/DOCUMENTATION.md](DOCUMENTATION.md#authoring) | `docs/**` |
| history | Dated public implementation plans, with no runtime authority | [docs/platform/DOCUMENTATION.md](DOCUMENTATION.md#authoring) | `docs/platform/plans/**` |
| configuration | Machine-readable platform configuration and contract inputs | [docs/platform/CANONICAL_CONTRACTS.md](CANONICAL_CONTRACTS.md#compatibility-posture) | `config/**` |
| ownership | Documentation ownership, publication inventory and generated projections | [docs/platform/DOCUMENTATION.md](DOCUMENTATION.md#ownership) | `config/doc-routing.json`; `config/openlup-publication-catalog.json`; `config/openlup-source-release-contract.json`; `scripts/documentation-routing.ts` |
| browser | Browser components, routes, clients and application composition | [docs/platform/ARCHITECTURE_AND_EXTENSIONS.md](ARCHITECTURE_AND_EXTENSIONS.md#runtime-boundaries) | `src/**` |
| server | Server composition, shared server utilities and use cases | [docs/platform/ARCHITECTURE_AND_EXTENSIONS.md](ARCHITECTURE_AND_EXTENSIONS.md#runtime-boundaries) | `server/**` |
| adapters | Provider translation at domain ports and capability refusals | [server/adapters/README.md](../../server/adapters/README.md) | `server/adapters/**` |
| infrastructure | Low-level clients, environment parsing and server infrastructure | [docs/platform/RUNTIME_AND_SELF_HOSTING.md](RUNTIME_AND_SELF_HOSTING.md#provider-and-host-boundaries) | `server/infra/**` |
| bff | Server HTTP composition and public interface boundaries | [docs/platform/RUNTIME_AND_SELF_HOSTING.md](RUNTIME_AND_SELF_HOSTING.md#runtime-model) | `server/bff/**`; `api/**` |
| reference | The bounded static and opt-in subscription evaluation profiles | [docs/platform/RUNTIME_AND_SELF_HOSTING.md](RUNTIME_AND_SELF_HOSTING.md#opt-in-disposable-subscription-reference) | `server/runtime/public-reference/**`; `src/public-reference/**`; `vite.public-reference.config.ts`; `scripts/oss-reference-*.ts` |
| data | Durable data, ordered migration history and compatibility lifecycle | [docs/platform/DATA_AND_MIGRATIONS.md](DATA_AND_MIGRATIONS.md#compatibility-lifecycle) | `db/**`; `supabase/**`; `src/integrations/**` |
| packages | Package API, exports, release-shape and consumer boundaries | [packages/core/README.md](../../packages/core/README.md) | `packages/**` |
| core | Portable neutral core kernels and their package verification | [packages/core/README.md](../../packages/core/README.md) | `packages/core/**` |
| subscription-kernel | Pure lifecycle, retry, cycle and deterministic-clock behavior | [packages/core/docs/SUBSCRIPTION_ENGINE.md](../../packages/core/docs/SUBSCRIPTION_ENGINE.md) | `packages/core/src/subscription/**` |
| tooling | Public tooling and the actual execution owner of each check | [CONTRIBUTING.md](../../CONTRIBUTING.md#development-preview-checks) | `scripts/**` |
| docs-impact | Documentation change impact and same-owner review enforcement | [docs/platform/DOCUMENTATION.md](DOCUMENTATION.md#impact) | `scripts/documentation-impact*.ts`; `scripts/documentation-git*.ts` |
| docs-export | Generated documentation navigation and the checked bundle consumer boundary | [docs/platform/DOCUMENTATION.md](DOCUMENTATION.md#exporting) | `scripts/documentation-bundle*.ts`; `scripts/documentation-navigation*.ts`; `.gitignore` |
| tests | Integration and browser test sources; execution requires their declared owner | [CONTRIBUTING.md](../../CONTRIBUTING.md#development-preview-checks) | `tests/**`; `src/test/**` |
| assets | Static public assets and their reference build consumption | [docs/platform/RUNTIME_AND_SELF_HOSTING.md](RUNTIME_AND_SELF_HOSTING.md#runtime-model) | `public/**` |
| operations | Deployment recipes and operational interface boundaries | [docs/platform/RUNTIME_AND_SELF_HOSTING.md](RUNTIME_AND_SELF_HOSTING.md#self-host-boundary) | `deploy/**`; `mcp/**` |
| subscription-renewal | Read the actual renewal invocation, preflight, attempt and charge path | [docs/platform/SUBSCRIPTION_WORKFLOWS.md](SUBSCRIPTION_WORKFLOWS.md#renew-one-cycle) | `server/bff/subscriptions/renewal-ticks.ts`; `server/domains/subscription/subscriptionRenewalInvocation.ts`; `server/domains/subscription/chargeSubscriptionCycleOffSession.ts` |
| subscription-recovery | Session, token ownership, expiry, revocation and replay in payment recovery | [docs/platform/SUBSCRIPTION_WORKFLOWS.md](SUBSCRIPTION_WORKFLOWS.md#recover-payment) | `server/domains/subscription/paymentRecoveryHandler.ts`; `server/domains/subscription/paymentRecoveryPorts.ts` |
| subscription-delivery | Renewal delivery admission and the durable replacement-confirmation boundary | [docs/platform/SUBSCRIPTION_WORKFLOWS.md](SUBSCRIPTION_WORKFLOWS.md#protect-delivery) | `server/domains/subscription/callSubscriptionDeliveryAlignmentAdmission.ts`; `server/adapters/subscriptionDeliveryAlignmentGateway.ts` |
| subscription-services | Available domain service entrypoints and their composition limitations | [docs/platform/SUBSCRIPTION_WORKFLOWS.md](SUBSCRIPTION_WORKFLOWS.md#available-domain-services) | `server/domains/subscription/checkoutActivationBridge.ts`; `server/domains/subscription/runAutomaticSubscriptionRenewal.ts` |
<!-- openlup-generated:end -->

## Drill down to a file

The checked documentation bundle's `sources.json` lists every selected public path,
publication class, structural role, canonical owner, content digest and syntactically
declared export names. It labels the origin of those descriptions. Read the owner's
invariants and tests before changing behavior; a file name is not a behavioral contract.
