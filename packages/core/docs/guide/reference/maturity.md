# Maturity

Check a subpath's compatibility policy before using it. See [stability](stability.md)
for package policy definitions and release boundaries.

<!-- generated:compatibility-policies -->
| Maturity | Compatibility policy |
| --- | --- |
| `experimental` | `experimental` |
| `stable` | `stable` |
| `testing` | `testing` |

[Compatibility policy mapping](https://github.com/openlup/openlup/blob/openlup-core-v1.3.0/packages/core/scripts/public-api-config.ts)
<!-- /generated:compatibility-policies -->

## `@openlup/core`

<!-- generated:maturity:core -->
| Export | Role | Maturity |
| --- | --- | --- |
| `./bundle` | kernel | stable |
| `./catalog` | kernel | stable |
| `./company-identity` | kernel | experimental |
| `./fulfillment` | kernel | stable |
| `./inventory` | kernel | stable |
| `./marketing/research` | kernel | experimental |
| `./outbox` | kernel | stable |
| `./partners` | kernel | stable |
| `./payment` | kernel | stable |
| `./platform-runtime` | kernel | stable |
| `./pricing` | kernel | stable |
| `./promo` | kernel | stable |
| `./readiness` | kernel | stable |
| `./risk` | kernel | stable |
| `./shipping` | kernel | stable |
| `./standard-schema` | kernel | experimental |
| `./subscription` | kernel | stable |
| `./testing` | testing | testing |
<!-- /generated:maturity:core -->

## `@openlup/outbox`

<!-- generated:maturity:outbox -->
| Export | Role | Maturity |
| --- | --- | --- |
| `.` | rail | stable |
| `./postgres` | rail | stable |
| `./testing` | testing | testing |
<!-- /generated:maturity:outbox -->

## `@openlup/platform`

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
| `./subscriptions` | capability | stable |
| `./subscriptions/contracts` | capability | stable |
| `./tax` | capability | experimental |
| `./tax/contracts` | capability | experimental |

5 subpaths omitted because their names are provider-specific. Complete list: [package.json](https://github.com/openlup/openlup/blob/openlup-core-v1.3.0/packages/platform/package.json) and [Subpath maturity](https://github.com/openlup/openlup/blob/openlup-core-v1.3.0/packages/platform/AGENTS.md#subpath-maturity).
<!-- /generated:maturity:platform -->

