# Commerce Core

`@openlup/core` is a framework-independent TypeScript workspace package of
subscription and bundle commerce kernels, not a separate library product.

> [!IMPORTANT]
> Version `0.<n>.0` is packed from source preview `openlup-source-preview/<n>`,
> staged with provenance and approved with 2FA, on the `preview` dist-tag only.
> `npm publish` from this directory is refused. No version implies a stable
> API or supported consumer path. Build, pack, and isolated-import checks are
> package smoke evidence only.

## Package Surface Maturity

Every current export is an internal candidate, experimental kernel, or testing
surface. Its declaration snapshot is a reviewable drift proof, not a public API
promise.

| Export | Role | Maturity | Package smoke |
| --- | --- | --- | --- |
| `./bundle` | kernel | candidate | `smoke/subscriptionBundleStandalone.test.ts` |
| `./catalog` | kernel | candidate | `smoke/catalogStandalone.test.ts` |
| `./checkout` | kernel | experimental | `smoke/checkoutStandalone.test.ts` |
| `./company-identity` | kernel | experimental | `smoke/companyIdentityStandalone.test.ts` |
| `./fulfillment` | kernel | experimental | `smoke/fulfillmentStandalone.test.ts` |
| `./inventory` | kernel | candidate | `smoke/inventoryStandalone.test.ts` |
| `./marketing/research` | kernel | experimental | `smoke/marketingResearchStandalone.test.ts` |
| `./partners` | kernel | experimental | `smoke/partnersStandalone.test.ts` |
| `./payment` | kernel | experimental | `smoke/paymentStandalone.test.ts` |
| `./platform-runtime` | kernel | experimental | `smoke/platformRuntimeStandalone.test.ts` |
| `./pricing` | kernel | candidate | `smoke/pricingStandalone.test.ts` |
| `./promo` | kernel | candidate | `smoke/promoStandalone.test.ts` |
| `./risk` | kernel | candidate | `smoke/riskStandalone.test.ts` |
| `./shipping` | kernel | candidate | `smoke/shippingStandalone.test.ts` |
| `./subscription` | kernel | candidate | `smoke/subscriptionBundleStandalone.test.ts` |
| `./testing` | testing | testing | `smoke/testingStandalone.test.ts` |

`release-gates.json` records four distinct evidence classes:

- `packageSmokeEvidence`: required hermetic build/import/pack/publish-refusal
  proof for this package;
- `conformanceEvidence`: required only when a declared port/adapter seam needs
  a framework-free suite;
- `dogfoodEvidence`: first-party integration seams, not independent adoption;
- `externalConsumerEvidence`: not yet evaluated; a first-party packed consumer
  remains package smoke, not external adoption.

## Local verification

From this package directory:

```sh
npm ci
npm run ci
```

Focused proofs are `npm run api:check`, `npm run release:check`, and
`npm run test:consumer`. The root test script skips this suite. A `preview`
install is evaluation, not a supported install.

## Kernel Documentation

- [`docs/SUBSCRIPTION_ENGINE.md`](docs/SUBSCRIPTION_ENGINE.md) — what the
  `./subscription` kernel owns, its deterministic-clock contract, the
  late-payment cycle-shift rule and its monotonic clamp, and how a host
  application consumes it.
