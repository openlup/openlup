# Configuration keys

Find configuration keys read by package source: names from the configuration inventory that occur in package source, excluding provider-specific names. The table includes ownership, category, required environments and whether a key is secret.

<!-- generated:configuration-keys -->
| Name | Owner | Category | Required in | Secret |
| --- | --- | --- | --- | --- |
| `BLOB_FS_BASE_URL` | platform | server-runtime | none | no |
| `BLOB_FS_ROOT` | platform | server-runtime | none | no |
| `BLOB_READ_WRITE_TOKEN` | platform | server-runtime | none | yes |
| `BLOB_S3_ACCESS_KEY_ID` | platform | server-runtime | none | no |
| `BLOB_S3_BASE_URL` | platform | server-runtime | none | no |
| `BLOB_S3_BUCKET` | platform | server-runtime | none | no |
| `BLOB_S3_ENDPOINT` | platform | server-runtime | none | no |
| `BLOB_S3_FORCE_PATH_STYLE` | platform | server-runtime | none | no |
| `BLOB_S3_REGION` | platform | server-runtime | none | no |
| `BLOB_S3_SECRET_ACCESS_KEY` | platform | server-runtime | none | yes |
| `COMMERCE_FISCAL_CATEGORY` | commerce | public-build | none | no |
| `COMMERCE_FISCAL_COUNTRY` | commerce | public-build | none | no |
| `COMMERCE_FISCAL_LEGAL_BASIS` | commerce | public-build | none | no |
| `COMMERCE_FISCAL_VAT_RATE_BPS` | commerce | public-build | none | no |
| `COMMERCE_MIN_PRODUCT_PAYABLE_MINOR` | commerce | public-build | none | no |
| `COMMERCE_SETTLEMENT_CURRENCY` | commerce | public-build | none | no |
| `COMMERCE_SETTLEMENT_REGION` | commerce | public-build | none | no |
| `OPERATOR_IDENTITY_AUDIENCE` | platform | server-runtime | none | no |
| `PLATFORM_BLOB` | platform | server-runtime | none | no |

4 package-read keys omitted because their names are provider-specific. Complete list: [configuration keys](https://github.com/openlup/openlup/blob/openlup-core-v0.41.0/config/environment-variables.json) and [platform API reports](https://github.com/openlup/openlup/blob/openlup-core-v0.41.0/packages/platform/api/).
<!-- /generated:configuration-keys -->
