# Maturity

Check a subpath's compatibility policy before using it. See [stability](stability.md)
for package policy definitions and release boundaries.

<!-- generated:compatibility-policies -->
| Maturity | Compatibility policy |
| --- | --- |
| `candidate` | `internal-candidate` |
| `experimental` | `internal-candidate` |
| `testing` | `testing-internal` |

[Compatibility policy mapping](https://github.com/openlup/openlup/blob/openlup-core-v0.40.0/packages/core/scripts/public-api-config.ts)
<!-- /generated:compatibility-policies -->

## `@openlup/core`

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

## `@openlup/outbox`

<!-- generated:maturity:outbox -->
| Export | Role | Maturity |
| --- | --- | --- |
| `.` | rail | experimental |
| `./postgres` | rail | experimental |
| `./testing` | testing | testing |
<!-- /generated:maturity:outbox -->

## `@openlup/platform`

<!-- generated:maturity:platform -->
| Export | Role | Maturity |
| --- | --- | --- |
| `./account-support` | capability | experimental |
| `./account-support/contracts` | capability | experimental |
| `./account-support/postgres` | capability | experimental |
| `./account-support/read-contracts` | capability | experimental |
| `./bff` | rail | experimental |
| `./blob` | rail | experimental |
| `./catalog` | capability | experimental |
| `./catalog/contracts` | capability | experimental |
| `./channels` | capability | experimental |
| `./channels/contracts` | capability | experimental |
| `./channels/server` | capability | experimental |
| `./commerce` | capability | experimental |
| `./commerce/contracts` | capability | experimental |
| `./commerce/server` | capability | experimental |
| `./commerce/server/destinations` | capability | experimental |
| `./commerce/server/native-checkout` | capability | experimental |
| `./commerce/server/postgres` | capability | experimental |
| `./communications` | capability | experimental |
| `./communications/contracts` | capability | experimental |
| `./communications/klaviyo` | capability | experimental |
| `./company-identity` | capability | experimental |
| `./company-identity/contracts` | capability | experimental |
| `./company-identity/server` | capability | experimental |
| `./composition` | rail | experimental |
| `./data` | rail | experimental |
| `./fulfillment` | capability | experimental |
| `./fulfillment/contracts` | capability | experimental |
| `./fulfillment/native` | capability | experimental |
| `./http` | rail | experimental |
| `./identity` | capability | experimental |
| `./identity/contracts` | capability | experimental |
| `./inventory` | capability | experimental |
| `./inventory/contracts` | capability | experimental |
| `./invoicing` | capability | experimental |
| `./invoicing/contracts` | capability | experimental |
| `./invoicing/postgres` | capability | experimental |
| `./job-ledger` | rail | experimental |
| `./kernel` | rail | experimental |
| `./lifecycle` | rail | experimental |
| `./market-packs` | capability | experimental |
| `./marketing` | capability | experimental |
| `./marketing/contracts` | capability | experimental |
| `./marketing/server` | capability | experimental |
| `./marketing/server/postgres` | capability | experimental |
| `./migrations` | rail | experimental |
| `./operations` | capability | experimental |
| `./operations/contracts` | capability | experimental |
| `./operations/server` | capability | experimental |
| `./payments` | capability | experimental |
| `./payments/contracts` | capability | experimental |
| `./payments/testing` | capability | experimental |
| `./portability` | rail | experimental |
| `./pricing` | capability | experimental |
| `./pricing/browser` | capability | experimental |
| `./pricing/contracts` | capability | experimental |
| `./promotions` | capability | experimental |
| `./promotions/contracts` | capability | experimental |
| `./risk` | capability | experimental |
| `./risk/contracts` | capability | experimental |
| `./risk/server` | capability | experimental |
| `./scheduler` | rail | experimental |
| `./shipping` | capability | experimental |
| `./shipping/contracts` | capability | experimental |
| `./subscriptions` | capability | experimental |
| `./subscriptions/contracts` | capability | experimental |

4 subpaths omitted because their names are provider-specific. Complete list: [package.json](https://github.com/openlup/openlup/blob/openlup-core-v0.40.0/packages/platform/package.json) and [Subpath maturity](https://github.com/openlup/openlup/blob/openlup-core-v0.40.0/packages/platform/AGENTS.md#subpath-maturity).
<!-- /generated:maturity:platform -->

