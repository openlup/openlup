### Handle typed catalogue definition install refusals

`installCatalogDefinitions` and `withCatalogPublicationRules` now report named
domain refusals as `CatalogDefinitionInstallError` from the experimental
`@openlup/platform/catalog` entry. Check the class and use its `code`, `path`,
`observed`, `causeText`, `fix` and `recheck` fields. Migrate catches that inspect
SQLSTATE, driver messages, DETAIL, the former SQL `issue` or publication
diagnostics. The operational isolation error propagates with its original
driver shape. Success signatures and the SQL install authority stay the same.

The installer checks the declaration and manifest before rules verification.
A declaration refusal now always includes the typed `issue` on
`invalid_catalog_pack`, including former bare install-only refusals. Call
`catalogPackInstallIssues` on a bound pack for these findings before writing.
