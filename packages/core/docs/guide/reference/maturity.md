# Maturity

Check a subpath's compatibility policy before using it. See [stability](stability.md)
for package policy definitions and release boundaries.

A stable subpath can contain symbols tagged `@experimental` or `@deprecated`. The
stable promise does not cover an `@experimental` symbol, and a `@deprecated` symbol
is scheduled for removal. Each package section lists these symbols after its subpath table.

<!-- generated:compatibility-policies -->
| Maturity | Compatibility policy |
| --- | --- |
| `experimental` | `experimental` |
| `stable` | `stable` |
| `testing` | `testing` |

[Compatibility policy mapping](https://github.com/openlup/openlup/blob/openlup-core-v1.3.0/packages/core/scripts/public-api-config.ts)
<!-- /generated:compatibility-policies -->

## Reading the symbol tables

A symbol listed here differs from the maturity of its subpath, or is deprecated.
Every other symbol of a subpath has that subpath's maturity. A symbol that a subpath
re-exports from another `@openlup` package is listed only under the package that
declares it. A tag on a re-export statement applies to every name the statement
exports, unless the declaration carries a tag of its own. A tag on a member of an
interface or class does not change the symbol that contains it.

`openlup-context search` reports the same facts for a symbol: `maturity` is the
declared maturity, and `deprecated` is true for a deprecated symbol. A hit has no
`maturity` when the lookup did not find the declaration inside the installed package,
or when no subpath maturity is known and no `@experimental` tag applies. In either
case, read the declaration.

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

Symbols whose maturity differs from their subpath, or that are deprecated:

<!-- generated:maturity-symbols:core -->
| Export | Symbol | Maturity | Deprecated |
| --- | --- | --- | --- |
| `./catalog` | `CATALOG_CANONICAL_UNITS` | experimental | no |
| `./catalog` | `CATALOG_QUANTITY_UNITS` | experimental | no |
| `./catalog` | `CatalogAcceptanceV2` | experimental | no |
| `./catalog` | `CatalogAcceptedReferenceV2` | experimental | no |
| `./catalog` | `CatalogAdmissionEvidence` | experimental | no |
| `./catalog` | `CatalogAdmissionHead` | experimental | no |
| `./catalog` | `CatalogAdmissionLegacyReview` | experimental | no |
| `./catalog` | `CatalogAdmissionLine` | experimental | no |
| `./catalog` | `CatalogCanonicalUnit` | experimental | no |
| `./catalog` | `CatalogQuantity` | experimental | no |
| `./catalog` | `CatalogQuantityCode` | experimental | no |
| `./catalog` | `CatalogQuantityDimension` | experimental | no |
| `./catalog` | `CatalogQuantityError` | experimental | no |
| `./catalog` | `CatalogQuantityUnit` | experimental | no |
| `./catalog` | `CatalogSubscriptionProfileIssue` | experimental | no |
| `./catalog` | `CatalogSubscriptionProfileRef` | experimental | no |
| `./catalog` | `CatalogSubscriptionProfileV1` | experimental | no |
| `./catalog` | `CatalogUnitFactor` | experimental | no |
| `./catalog` | `InstalledCatalogSubscriptionProfile` | experimental | no |
| `./catalog` | `canonicalCatalogSubscriptionProfileJson` | experimental | no |
| `./catalog` | `canonicalizeCatalogQuantity` | experimental | no |
| `./catalog` | `compareCatalogQuantities` | experimental | no |
| `./catalog` | `convertCatalogQuantity` | experimental | no |
| `./catalog` | `parseCatalogQuantity` | experimental | no |
| `./catalog` | `validateCatalogSubscriptionProfile` | experimental | no |
| `./catalog` | `validateCatalogUnitFactor` | experimental | no |
| `./fulfillment` | `stepLabelKey` | stable | yes |
| `./fulfillment` | `timelineLabelForStep` | stable | yes |
| `./payment` | `PaymentMethodCaptureHandoff` | stable | yes |
| `./pricing` | `CatalogueMoneyV2Allocation` | experimental | no |
| `./pricing` | `CatalogueMoneyV2Basis` | experimental | no |
| `./pricing` | `CatalogueMoneyV2ComponentRef` | experimental | no |
| `./pricing` | `CatalogueMoneyV2Error` | experimental | no |
| `./pricing` | `CatalogueMoneyV2ErrorCode` | experimental | no |
| `./pricing` | `CatalogueMoneyV2Input` | experimental | no |
| `./pricing` | `CatalogueMoneyV2Plan` | experimental | no |
| `./pricing` | `CatalogueMoneyV2Position` | experimental | no |
| `./pricing` | `CatalogueMoneyV2Result` | experimental | no |
| `./pricing` | `CatalogueMoneyV2State` | experimental | no |
| `./pricing` | `CatalogueMoneyV2Tax` | experimental | no |
| `./pricing` | `CommerceMoneyBodyV2` | experimental | no |
| `./pricing` | `allocateCatalogueDiscountedGrossTotals` | experimental | no |
| `./pricing` | `calculateCatalogueMoneyV2` | experimental | no |
| `./pricing` | `cataloguePositionNetFromGross` | experimental | no |
| `./pricing` | `isCatalogueMoneyV2RateDecimal` | experimental | no |
| `./pricing` | `planCatalogueMoneyV2` | experimental | no |
| `./readiness` | `CatalogRegistryObservation` | experimental | no |
| `./subscription` | `CadenceChoiceV1` | experimental | no |
| `./subscription` | `parseCadenceChoiceV1` | experimental | no |
<!-- /generated:maturity-symbols:core -->

## `@openlup/outbox`

<!-- generated:maturity:outbox -->
| Export | Role | Maturity |
| --- | --- | --- |
| `.` | rail | stable |
| `./postgres` | rail | stable |
| `./testing` | testing | testing |
<!-- /generated:maturity:outbox -->

Symbols whose maturity differs from their subpath, or that are deprecated:

<!-- generated:maturity-symbols:outbox -->
No symbol of this package differs from its subpath's maturity or is deprecated.

4 symbols are not listed because their declarations are not in this package's API reports.
<!-- /generated:maturity-symbols:outbox -->

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
| `./storefront` | capability | experimental |
| `./subscriptions` | capability | stable |
| `./subscriptions/contracts` | capability | stable |
| `./tax` | capability | experimental |
| `./tax/contracts` | capability | experimental |

5 subpaths omitted because their names are provider-specific. Complete list: [package.json](https://github.com/openlup/openlup/blob/openlup-core-v1.3.0/packages/platform/package.json) and [Subpath maturity](https://github.com/openlup/openlup/blob/openlup-core-v1.3.0/packages/platform/AGENTS.md#subpath-maturity).
<!-- /generated:maturity:platform -->

Symbols whose maturity differs from their subpath, or that are deprecated:

<!-- generated:maturity-symbols:platform -->
| Export | Symbol | Maturity | Deprecated |
| --- | --- | --- | --- |
| `./account-support` | `AccountSupportOperatorSlideMaxDaysPolicy` | experimental | no |
| `./account-support` | `DEFAULT_ACCOUNT_SUPPORT_OPERATOR_SLIDE_MAX_DAYS` | experimental | no |
| `./account-support` | `installAccountSupportOperatorSlideMaxDaysPolicy` | experimental | no |
| `./account-support` | `readAccountSupportOperatorSlideMaxDaysOverride` | experimental | no |
| `./account-support` | `readAccountSupportOperatorSlideMaxDaysPolicy` | experimental | no |
| `./account-support` | `validateAccountSupportOperatorSlideMaxDays` | experimental | no |
| `./accounting/testing` | `ScriptedAccountingOutcome` | experimental | no |
| `./catalog` | `AttributeDefinition` | experimental | no |
| `./catalog` | `CATALOG_CONFORMANCE_RULES` | experimental | no |
| `./catalog` | `CatalogActivationReadinessInput` | experimental | no |
| `./catalog` | `CatalogActivationReadinessItem` | experimental | no |
| `./catalog` | `CatalogActivationReadinessResult` | experimental | no |
| `./catalog` | `CatalogAdmissionInput` | experimental | no |
| `./catalog` | `CatalogAdmissionPort` | experimental | no |
| `./catalog` | `CatalogAttributeInput` | experimental | no |
| `./catalog` | `CatalogAttributeProjectionPreparation` | experimental | no |
| `./catalog` | `CatalogAttributeProjectionRow` | experimental | no |
| `./catalog` | `CatalogAttributeProjectionValue` | experimental | no |
| `./catalog` | `CatalogAttributeReference` | experimental | no |
| `./catalog` | `CatalogAttributeReferencePort` | experimental | no |
| `./catalog` | `CatalogAttributeReferenceResolution` | experimental | no |
| `./catalog` | `CatalogAttributeScalarType` | experimental | no |
| `./catalog` | `CatalogAttributeScalarValue` | experimental | no |
| `./catalog` | `CatalogAttributeValidation` | experimental | no |
| `./catalog` | `CatalogAttributeValue` | experimental | no |
| `./catalog` | `CatalogAttributeValueType` | experimental | no |
| `./catalog` | `CatalogAxisDefinition` | experimental | no |
| `./catalog` | `CatalogCandidateComparison` | experimental | no |
| `./catalog` | `CatalogCandidateDeps` | experimental | no |
| `./catalog` | `CatalogCandidateError` | experimental | no |
| `./catalog` | `CatalogCandidateIssue` | experimental | no |
| `./catalog` | `CatalogCandidatePreview` | experimental | no |
| `./catalog` | `CatalogCandidatePublicationDeps` | experimental | no |
| `./catalog` | `CatalogCandidateQuery` | experimental | no |
| `./catalog` | `CatalogCombinationChangeV2` | experimental | no |
| `./catalog` | `CatalogCombinationCode` | experimental | no |
| `./catalog` | `CatalogCombinationError` | experimental | no |
| `./catalog` | `CatalogCombinationIdentityV2` | experimental | no |
| `./catalog` | `CatalogConformanceCode` | experimental | no |
| `./catalog` | `CatalogConformanceRule` | experimental | no |
| `./catalog` | `CatalogDefinitionInstallError` | experimental | no |
| `./catalog` | `CatalogDefinitionInstallReceipt` | experimental | no |
| `./catalog` | `CatalogDefinitionIssue` | experimental | no |
| `./catalog` | `CatalogDiscoveryEvidence` | experimental | no |
| `./catalog` | `CatalogDiscoveryRefusal` | experimental | no |
| `./catalog` | `CatalogDraftClaimV3` | experimental | no |
| `./catalog` | `CatalogDraftCommandV2` | experimental | no |
| `./catalog` | `CatalogDraftCommandV3` | experimental | no |
| `./catalog` | `CatalogDraftCommandV4` | experimental | no |
| `./catalog` | `CatalogDraftMediaClaimV3` | experimental | no |
| `./catalog` | `CatalogDraftMembershipV3` | experimental | no |
| `./catalog` | `CatalogDraftPayloadV2` | experimental | no |
| `./catalog` | `CatalogDraftPayloadV3` | experimental | no |
| `./catalog` | `CatalogDraftPayloadV4` | experimental | no |
| `./catalog` | `CatalogDraftPriceOperationV2` | experimental | no |
| `./catalog` | `CatalogDraftProvenanceV3` | experimental | no |
| `./catalog` | `CatalogDraftPublicationInputsV3` | experimental | no |
| `./catalog` | `CatalogDraftPublicationOperationV3` | experimental | no |
| `./catalog` | `CatalogDraftPublicationSkuV3` | experimental | no |
| `./catalog` | `CatalogDraftPublicationStoredApplyResult` | experimental | no |
| `./catalog` | `CatalogDraftPublicationStoredCommand` | experimental | no |
| `./catalog` | `CatalogDraftPublicationStoredPayload` | experimental | no |
| `./catalog` | `CatalogDraftPublicationStoredRecord` | experimental | no |
| `./catalog` | `CatalogDraftSharedContentV3` | experimental | no |
| `./catalog` | `CatalogDraftStoredApplyResult` | experimental | no |
| `./catalog` | `CatalogDraftStoredCommand` | experimental | no |
| `./catalog` | `CatalogDraftStoredPayload` | experimental | no |
| `./catalog` | `CatalogDraftStoredRecord` | experimental | no |
| `./catalog` | `CatalogFullPublicationV3` | experimental | no |
| `./catalog` | `CatalogInstalledReadiness` | experimental | no |
| `./catalog` | `CatalogLifecycleDraftPage` | experimental | no |
| `./catalog` | `CatalogLifecycleDraftStorePort` | experimental | no |
| `./catalog` | `CatalogMembershipCursor` | experimental | no |
| `./catalog` | `CatalogMembershipItem` | experimental | no |
| `./catalog` | `CatalogMembershipPageInput` | experimental | no |
| `./catalog` | `CatalogMembershipPageResult` | experimental | no |
| `./catalog` | `CatalogPackDraft` | experimental | no |
| `./catalog` | `CatalogPackInput` | experimental | no |
| `./catalog` | `CatalogPackManifest` | experimental | no |
| `./catalog` | `CatalogProductInput` | experimental | no |
| `./catalog` | `CatalogProductSkuInput` | experimental | no |
| `./catalog` | `CatalogProductTypeInput` | experimental | no |
| `./catalog` | `CatalogPublicationCommand` | experimental | no |
| `./catalog` | `CatalogPublicationCommandResult` | experimental | no |
| `./catalog` | `CatalogPublicationDecisionReceipt` | experimental | no |
| `./catalog` | `CatalogPublicationFacts` | experimental | no |
| `./catalog` | `CatalogPublicationJson` | experimental | no |
| `./catalog` | `CatalogPublicationManifestV2` | experimental | no |
| `./catalog` | `CatalogPublicationManifestV3` | experimental | no |
| `./catalog` | `CatalogPublicationReceiptV3` | experimental | no |
| `./catalog` | `CatalogPublicationRulesModule` | experimental | no |
| `./catalog` | `CatalogPublicationRulesPack` | experimental | no |
| `./catalog` | `CatalogPublishedProductV3` | experimental | no |
| `./catalog` | `CatalogPublishedSkuV3` | experimental | no |
| `./catalog` | `CatalogReleaseDraftError` | experimental | no |
| `./catalog` | `CatalogRetainedCombinationV2` | experimental | no |
| `./catalog` | `CatalogRulesContext` | experimental | no |
| `./catalog` | `CatalogSkuRevisionRef` | experimental | no |
| `./catalog` | `CatalogStorefrontPageInput` | experimental | no |
| `./catalog` | `CatalogStorefrontPageResult` | experimental | no |
| `./catalog` | `CatalogStorefrontPrice` | experimental | no |
| `./catalog` | `CatalogStorefrontProduct` | experimental | no |
| `./catalog` | `CatalogStorefrontSku` | experimental | no |
| `./catalog` | `CatalogTypeDefinitionV2` | experimental | no |
| `./catalog` | `CatalogVariantOptionInput` | experimental | no |
| `./catalog` | `PostgresCatalogPublicationCommandsDeps` | experimental | no |
| `./catalog` | `PublicationDraftRecord` | experimental | no |
| `./catalog` | `PublishedCatalogOfferPage` | experimental | no |
| `./catalog` | `RulesIdentifier` | experimental | no |
| `./catalog` | `RulesProduct` | experimental | no |
| `./catalog` | `RulesSku` | experimental | no |
| `./catalog` | `assertCatalogAcceptanceV2` | experimental | no |
| `./catalog` | `assertCatalogAcceptedReferenceV2` | experimental | no |
| `./catalog` | `backfillCatalogNetContent` | experimental | no |
| `./catalog` | `buildCatalogReleaseDraftV3` | experimental | no |
| `./catalog` | `canonicalizeCatalogCombinationV2` | experimental | no |
| `./catalog` | `catalogAcceptanceV2Schema` | experimental | no |
| `./catalog` | `catalogAcceptedReferenceV2Schema` | experimental | no |
| `./catalog` | `catalogAttributesReadyForPublication` | experimental | no |
| `./catalog` | `catalogDefinitionDigest` | experimental | no |
| `./catalog` | `catalogDraftCommandV2Schema` | experimental | no |
| `./catalog` | `catalogDraftCommandV3Schema` | experimental | no |
| `./catalog` | `catalogDraftCommandV4Schema` | experimental | no |
| `./catalog` | `catalogDraftPayloadV2Schema` | experimental | no |
| `./catalog` | `catalogDraftPayloadV3Schema` | experimental | no |
| `./catalog` | `catalogDraftPayloadV4Schema` | experimental | no |
| `./catalog` | `catalogDraftPriceOperationV2Schema` | experimental | no |
| `./catalog` | `catalogDraftProvenanceV3Schema` | experimental | no |
| `./catalog` | `catalogDraftPublicationInputsV3Schema` | experimental | no |
| `./catalog` | `catalogDraftPublicationOperationV3Schema` | experimental | no |
| `./catalog` | `catalogDraftPublicationStoredApplyResultSchema` | experimental | no |
| `./catalog` | `catalogDraftPublicationStoredCommandSchema` | experimental | no |
| `./catalog` | `catalogDraftPublicationStoredPayloadSchema` | experimental | no |
| `./catalog` | `catalogDraftPublicationStoredRecordSchema` | experimental | no |
| `./catalog` | `catalogDraftSharedContentV3Schema` | experimental | no |
| `./catalog` | `catalogDraftStoredApplyResultSchema` | experimental | no |
| `./catalog` | `catalogDraftStoredCommandSchema` | experimental | no |
| `./catalog` | `catalogDraftStoredPayloadSchema` | experimental | no |
| `./catalog` | `catalogDraftStoredRecordSchema` | experimental | no |
| `./catalog` | `catalogInternalGtin` | experimental | no |
| `./catalog` | `catalogPackInstallIssues` | experimental | no |
| `./catalog` | `catalogPackIssues` | experimental | no |
| `./catalog` | `catalogPackManifest` | experimental | no |
| `./catalog` | `catalogProductInputSchema` | experimental | no |
| `./catalog` | `catalogProductTypeIssues` | experimental | no |
| `./catalog` | `catalogProductTypeRefIssues` | experimental | no |
| `./catalog` | `catalogVariantOptions` | experimental | no |
| `./catalog` | `classifyCatalogCombinationConflictV2` | experimental | no |
| `./catalog` | `createCatalogCandidateService` | experimental | no |
| `./catalog` | `createCatalogCandidateServiceWithPublication` | experimental | no |
| `./catalog` | `createCatalogDefinitionWriteGuard` | experimental | no |
| `./catalog` | `createCatalogDraftHandlerV2` | experimental | no |
| `./catalog` | `createCatalogDraftHandlerV3` | experimental | no |
| `./catalog` | `createCatalogDraftHandlerV4` | experimental | no |
| `./catalog` | `createPostgresCatalogAdmission` | experimental | no |
| `./catalog` | `createPostgresCatalogDraftStoreV2` | experimental | no |
| `./catalog` | `createPostgresCatalogDraftStoreV3` | experimental | no |
| `./catalog` | `createPostgresCatalogDraftStoreV4` | experimental | no |
| `./catalog` | `createPostgresCatalogPublicationCommands` | experimental | no |
| `./catalog` | `createPostgresCatalogPublicationReads` | experimental | no |
| `./catalog` | `defineCatalogPack` | experimental | no |
| `./catalog` | `draftsFor` | experimental | no |
| `./catalog` | `extractCatalogDraftPublicationInputs` | experimental | no |
| `./catalog` | `installCatalogDefinitions` | experimental | no |
| `./catalog` | `loadCatalogRules` | experimental | no |
| `./catalog` | `observeCatalogDefinitionReadiness` | experimental | no |
| `./catalog` | `prepareCatalogAttributeProjection` | experimental | no |
| `./catalog` | `projectPublishedCatalogOfferPage` | experimental | no |
| `./catalog` | `readInstalledCatalogSubscriptionProfile` | experimental | no |
| `./catalog` | `readPostgresCatalogActivationReadiness` | experimental | no |
| `./catalog` | `readPostgresCatalogMembershipPage` | experimental | no |
| `./catalog` | `readPostgresCatalogStorefrontPage` | experimental | no |
| `./catalog` | `resolveCatalogDraftProvenance` | experimental | no |
| `./catalog` | `validateCatalogAttributes` | experimental | no |
| `./catalog` | `validateCatalogCombinationChangesV2` | experimental | no |
| `./catalog` | `validateCatalogDraftV2` | experimental | no |
| `./catalog` | `withCatalogPublicationRules` | experimental | no |
| `./catalog/contracts` | `AttributeDefinition` | experimental | no |
| `./catalog/contracts` | `CatalogAdmissionInput` | experimental | no |
| `./catalog/contracts` | `CatalogAdmissionPort` | experimental | no |
| `./catalog/contracts` | `CatalogAttributeScalarType` | experimental | no |
| `./catalog/contracts` | `CatalogAttributeScalarValue` | experimental | no |
| `./catalog/contracts` | `CatalogAttributeValue` | experimental | no |
| `./catalog/contracts` | `CatalogAttributeValueType` | experimental | no |
| `./catalog/contracts` | `CatalogAxisDefinition` | experimental | no |
| `./catalog/contracts` | `CatalogCandidateComparison` | experimental | no |
| `./catalog/contracts` | `CatalogCandidateIssue` | experimental | no |
| `./catalog/contracts` | `CatalogCandidatePreview` | experimental | no |
| `./catalog/contracts` | `CatalogCandidateQuery` | experimental | no |
| `./catalog/contracts` | `CatalogCombinationChangeV2` | experimental | no |
| `./catalog/contracts` | `CatalogCombinationCode` | experimental | no |
| `./catalog/contracts` | `CatalogCombinationIdentityV2` | experimental | no |
| `./catalog/contracts` | `CatalogConformanceCode` | experimental | no |
| `./catalog/contracts` | `CatalogConformanceRule` | experimental | no |
| `./catalog/contracts` | `CatalogDefinitionInstallReceipt` | experimental | no |
| `./catalog/contracts` | `CatalogDefinitionIssue` | experimental | no |
| `./catalog/contracts` | `CatalogDraftClaimV3` | experimental | no |
| `./catalog/contracts` | `CatalogDraftCommandV2` | experimental | no |
| `./catalog/contracts` | `CatalogDraftCommandV3` | experimental | no |
| `./catalog/contracts` | `CatalogDraftMediaClaimV3` | experimental | no |
| `./catalog/contracts` | `CatalogDraftMembershipV3` | experimental | no |
| `./catalog/contracts` | `CatalogDraftPayloadV2` | experimental | no |
| `./catalog/contracts` | `CatalogDraftPayloadV3` | experimental | no |
| `./catalog/contracts` | `CatalogDraftPriceOperationV2` | experimental | no |
| `./catalog/contracts` | `CatalogDraftProvenanceV3` | experimental | no |
| `./catalog/contracts` | `CatalogDraftPublicationInputsV3` | experimental | no |
| `./catalog/contracts` | `CatalogDraftPublicationOperationV3` | experimental | no |
| `./catalog/contracts` | `CatalogDraftPublicationSkuV3` | experimental | no |
| `./catalog/contracts` | `CatalogDraftPublicationStoredApplyResult` | experimental | no |
| `./catalog/contracts` | `CatalogDraftPublicationStoredCommand` | experimental | no |
| `./catalog/contracts` | `CatalogDraftPublicationStoredPayload` | experimental | no |
| `./catalog/contracts` | `CatalogDraftPublicationStoredRecord` | experimental | no |
| `./catalog/contracts` | `CatalogDraftSharedContentV3` | experimental | no |
| `./catalog/contracts` | `CatalogDraftStoredApplyResult` | experimental | no |
| `./catalog/contracts` | `CatalogDraftStoredCommand` | experimental | no |
| `./catalog/contracts` | `CatalogDraftStoredPayload` | experimental | no |
| `./catalog/contracts` | `CatalogDraftStoredRecord` | experimental | no |
| `./catalog/contracts` | `CatalogPackDraft` | experimental | no |
| `./catalog/contracts` | `CatalogPackInput` | experimental | no |
| `./catalog/contracts` | `CatalogProductTypeInput` | experimental | no |
| `./catalog/contracts` | `CatalogPublicationFacts` | experimental | no |
| `./catalog/contracts` | `CatalogPublicationJson` | experimental | no |
| `./catalog/contracts` | `CatalogRetainedCombinationV2` | experimental | no |
| `./catalog/contracts` | `CatalogTypeDefinitionV2` | experimental | no |
| `./catalog/contracts` | `defineCatalogPack` | experimental | no |
| `./catalog/contracts` | `draftsFor` | experimental | no |
| `./catalog/testing` | `CatalogConformanceFinding` | experimental | no |
| `./catalog/testing` | `CatalogConformanceReport` | experimental | no |
| `./catalog/testing` | `CatalogConformanceSubject` | experimental | no |
| `./catalog/testing` | `CatalogRefusalFixture` | experimental | no |
| `./catalog/testing` | `buildCatalogOwnerQuote` | experimental | no |
| `./catalog/testing` | `runCatalogExtensionConformance` | experimental | no |
| `./channels/testing` | `ScriptedChannelOutcome` | experimental | no |
| `./commerce` | `CheckoutCommandV2` | experimental | no |
| `./commerce` | `DestinationAddressV2` | experimental | no |
| `./commerce` | `OrderMoneyV2` | experimental | no |
| `./commerce` | `PaidOrderMoneyV2` | experimental | no |
| `./commerce/contracts` | `CheckoutCommandV2` | experimental | no |
| `./commerce/contracts` | `DestinationAddressV2` | experimental | no |
| `./commerce/contracts` | `OrderMoneyV2` | experimental | no |
| `./commerce/contracts` | `PaidOrderMoneyV2` | experimental | no |
| `./commerce/server` | `CommerceMoneyLimitsQueryExecutor` | experimental | no |
| `./commerce/server` | `CommerceMoneyLimitsV2` | experimental | no |
| `./commerce/server` | `CommerceQuotePortV2` | experimental | no |
| `./commerce/server` | `CommerceQuoteV2Request` | experimental | no |
| `./commerce/server` | `DbBackedCommerceQuotePortV2Deps` | experimental | no |
| `./commerce/server` | `InstallLimitsInput` | experimental | no |
| `./commerce/server` | `InstallLimitsResult` | experimental | no |
| `./commerce/server` | `LimitsInspectionResult` | experimental | no |
| `./commerce/server` | `LimitsReadResult` | experimental | no |
| `./commerce/server` | `LimitsTuple` | experimental | no |
| `./commerce/server` | `QuoteOutcome` | experimental | no |
| `./commerce/server` | `QuoteOwnerContext` | experimental | no |
| `./commerce/server` | `bindCommerceMoneyLimitsV2Reader` | experimental | no |
| `./commerce/server` | `catalogAdmissionRefusal` | experimental | no |
| `./commerce/server` | `createDbBackedCommerceQuotePortV2` | experimental | no |
| `./commerce/server` | `describeCommerceMoneyLimitsV2Setting` | experimental | no |
| `./commerce/server` | `inspectCommerceMoneyLimitsV2` | experimental | no |
| `./commerce/server` | `installCommerceMoneyLimitsV2` | experimental | no |
| `./commerce/server` | `readCheckoutRecoveryReminderObservation` | experimental | no |
| `./commerce/server/destinations` | `DestinationBindingV2` | experimental | no |
| `./commerce/server/destinations` | `DestinationContextV2` | experimental | no |
| `./commerce/server/destinations` | `DestinationIssueResultV2` | experimental | no |
| `./commerce/server/destinations` | `DestinationPortV2` | experimental | no |
| `./commerce/server/destinations` | `DestinationSelectionV2` | experimental | no |
| `./commerce/server/destinations` | `DestinationServicePinV2` | experimental | no |
| `./commerce/server/destinations` | `DestinationVerifiedReadV2` | experimental | no |
| `./commerce/server/destinations` | `createCheckoutCommandV2Schema` | experimental | no |
| `./commerce/server/destinations` | `createPostgresDestinationPortV2` | experimental | no |
| `./commerce/server/destinations` | `destinationV2Capabilities` | experimental | no |
| `./communications/testing` | `runCommunicationsAdapterConformance` | experimental | no |
| `./fulfillment` | `createFulfillmentCommandLedger` | stable | yes |
| `./fulfillment/testing` | `runFulfillmentAdapterConformance` | experimental | no |
| `./identity` | `createDestinationDocumentPrivacyContributor` | experimental | no |
| `./identity` | `createDestinationReceiptPrivacyContributor` | experimental | no |
| `./identity` | `createTaxCalculationPrivacyContributor` | experimental | no |
| `./inventory` | `RenewalStockProtectionPreviewConnection` | experimental | no |
| `./inventory` | `describeRenewalStockProtectionSetting` | experimental | no |
| `./inventory` | `previewRenewalStockProtection` | experimental | no |
| `./inventory` | `readRenewalStockProtectionOverride` | experimental | no |
| `./kernel` | `DEFAULT_PLATFORM_BUNDLE` | stable | yes |
| `./migrations` | `applyPlatformCheckoutOwnerGrant` | experimental | no |
| `./observability/testing` | `ScriptedTelemetryOutcome` | experimental | no |
| `./operations` | `SettingDescriptor` | experimental | no |
| `./operations` | `SettingRefusal` | experimental | no |
| `./operations/contracts` | `SettingDescriptor` | experimental | no |
| `./operations/contracts` | `SettingRefusal` | experimental | no |
| `./operations/server` | `SettingPreviewer` | experimental | no |
| `./operations/server` | `SettingReader` | experimental | no |
| `./operations/server` | `SettingsAppBindings` | experimental | no |
| `./operations/server` | `SettingsFileEntry` | experimental | no |
| `./operations/server` | `runSettingsCommand` | experimental | no |
| `./operations/server` | `settingDescriptorSchema` | experimental | no |
| `./operations/server` | `settingRefusalSchema` | experimental | no |
| `./operations/server` | `settingsToolOutputSchema` | experimental | no |
| `./payments` | `DEFAULT_PAYMENT_DECLINE_LINK_LIFETIME_HOURS` | experimental | no |
| `./payments` | `DEFAULT_PAYMENT_DECLINE_NOTICE_DELAY_MINUTES` | experimental | no |
| `./payments` | `DEFAULT_PAYMENT_METHOD_EXPIRY_WARNING_DAYS` | experimental | no |
| `./payments` | `PaymentDeclineNoticeTimingPolicy` | experimental | no |
| `./payments` | `PaymentMethodExpiryWarningDaysPolicy` | experimental | no |
| `./payments` | `installPaymentDeclineNoticeTimingPolicy` | experimental | no |
| `./payments` | `installPaymentMethodExpiryWarningDaysPolicy` | experimental | no |
| `./payments` | `readPaymentDeclineNoticeTimingOverride` | experimental | no |
| `./payments` | `readPaymentDeclineNoticeTimingPolicy` | experimental | no |
| `./payments` | `readPaymentMethodExpiryWarningDaysOverride` | experimental | no |
| `./payments` | `readPaymentMethodExpiryWarningDaysPolicy` | experimental | no |
| `./payments` | `validatePaymentDeclineNoticeTiming` | experimental | no |
| `./payments` | `validatePaymentMethodExpiryWarningDays` | experimental | no |
| `./payments/testing` | `runPaymentAdapterConformance` | experimental | no |
| `./pricing` | `CATALOG_PRICE_SETUP_HARD_REFUSALS` | experimental | no |
| `./pricing` | `CATALOG_PRICE_SETUP_MAX_MINOR` | experimental | no |
| `./pricing` | `CatalogPriceSetupApplyResult` | experimental | no |
| `./pricing` | `CatalogPriceSetupCommand` | experimental | no |
| `./pricing` | `CatalogPriceSetupEntry` | experimental | no |
| `./pricing` | `CatalogPriceSetupHandlerDeps` | experimental | no |
| `./pricing` | `CatalogPriceSetupPreview` | experimental | no |
| `./pricing` | `CatalogPriceSetupPreviewQuery` | experimental | no |
| `./pricing` | `CatalogPriceSetupQueryExecutor` | experimental | no |
| `./pricing` | `CatalogPriceSetupReadback` | experimental | no |
| `./pricing` | `CatalogPriceSetupReadiness` | experimental | no |
| `./pricing` | `CatalogPriceSetupReceipt` | experimental | no |
| `./pricing` | `CatalogPriceSetupRefusal` | experimental | no |
| `./pricing` | `CatalogPriceSetupStorePort` | experimental | no |
| `./pricing` | `CatalogPriceSetupSubscription` | experimental | no |
| `./pricing` | `CommerceQuoteMoneyV2` | experimental | no |
| `./pricing` | `CommerceQuoteMoneyV2Plan` | experimental | no |
| `./pricing` | `CommerceQuoteMoneyV2Refusal` | experimental | no |
| `./pricing` | `CommerceQuoteV2` | experimental | no |
| `./pricing` | `ComposeCommerceQuoteMoneyV2Input` | experimental | no |
| `./pricing` | `DeliveryBucketV2` | experimental | no |
| `./pricing` | `DiscountAllocationV2` | experimental | no |
| `./pricing` | `FeeLineV2` | experimental | no |
| `./pricing` | `MoneyLineV2` | experimental | no |
| `./pricing` | `PlanCommerceQuoteMoneyV2Input` | experimental | no |
| `./pricing` | `TaxPositionV2` | experimental | no |
| `./pricing` | `canonicalCatalogPriceSetupCommand` | experimental | no |
| `./pricing` | `catalogPriceSetupApplyResultSchema` | experimental | no |
| `./pricing` | `catalogPriceSetupCommandSchema` | experimental | no |
| `./pricing` | `catalogPriceSetupExpectedSchema` | experimental | no |
| `./pricing` | `catalogPriceSetupPreviewQuerySchema` | experimental | no |
| `./pricing` | `catalogPriceSetupPreviewResultSchema` | experimental | no |
| `./pricing` | `catalogPriceSetupPreviewSchema` | experimental | no |
| `./pricing` | `catalogPriceSetupReceiptSchema` | experimental | no |
| `./pricing` | `catalogPriceSetupRefusal` | experimental | no |
| `./pricing` | `catalogPriceSetupRefusalSchema` | experimental | no |
| `./pricing` | `commerceQuoteV2Schema` | experimental | no |
| `./pricing` | `composeCommerceQuoteMoneyV2` | experimental | no |
| `./pricing` | `createCatalogPriceSetupHandler` | experimental | no |
| `./pricing` | `createPostgresCatalogPriceSetupStore` | experimental | no |
| `./pricing` | `planCommerceQuoteMoneyV2` | experimental | no |
| `./pricing` | `quoteDigest` | experimental | no |
| `./pricing/contracts` | `CatalogPriceSetupApplyResult` | experimental | no |
| `./pricing/contracts` | `CatalogPriceSetupCommand` | experimental | no |
| `./pricing/contracts` | `CatalogPriceSetupEntry` | experimental | no |
| `./pricing/contracts` | `CatalogPriceSetupPreview` | experimental | no |
| `./pricing/contracts` | `CatalogPriceSetupPreviewQuery` | experimental | no |
| `./pricing/contracts` | `CatalogPriceSetupReadiness` | experimental | no |
| `./pricing/contracts` | `CatalogPriceSetupReceipt` | experimental | no |
| `./pricing/contracts` | `CatalogPriceSetupRefusal` | experimental | no |
| `./pricing/contracts` | `CatalogPriceSetupSubscription` | experimental | no |
| `./pricing/contracts` | `CommerceQuoteMoneyV2` | experimental | no |
| `./pricing/contracts` | `CommerceQuoteV2` | experimental | no |
| `./pricing/contracts` | `DeliveryBucketV2` | experimental | no |
| `./pricing/contracts` | `DiscountAllocationV2` | experimental | no |
| `./pricing/contracts` | `FeeLineV2` | experimental | no |
| `./pricing/contracts` | `MoneyLineV2` | experimental | no |
| `./pricing/contracts` | `TaxPositionV2` | experimental | no |
| `./promotions` | `DEFAULT_PROMOTION_CLAIM_HOLD_HOURS` | experimental | no |
| `./promotions` | `PromotionClaimHoldHoursPolicy` | experimental | no |
| `./promotions` | `QuoteAcceptancePresentationV2` | experimental | no |
| `./promotions` | `QuoteAcceptanceRefusalV2` | experimental | no |
| `./promotions` | `QuoteAcceptanceScopeV2` | experimental | no |
| `./promotions` | `QuoteAcceptanceTokenV2` | experimental | no |
| `./promotions` | `installPromotionClaimHoldHoursPolicy` | experimental | no |
| `./promotions` | `issueQuoteAcceptanceTokenV2` | experimental | no |
| `./promotions` | `readPromotionClaimHoldHoursOverride` | experimental | no |
| `./promotions` | `readPromotionClaimHoldHoursPolicy` | experimental | no |
| `./promotions` | `validatePromotionClaimHoldHours` | experimental | no |
| `./promotions` | `verifyQuoteAcceptanceTokenV2` | experimental | no |
| `./shipping` | `AddressPolicyV1` | experimental | no |
| `./shipping` | `validateDestinationAddressV2` | experimental | no |
| `./shipping/testing` | `runShippingRateAdapterConformance` | experimental | no |
| `./subscriptions` | `CatalogProfileCadenceInput` | experimental | no |
| `./subscriptions` | `CatalogProfileCadenceResult` | experimental | no |
| `./subscriptions` | `DEFAULT_SUBSCRIPTION_EDIT_QUOTE_TTL_MINUTES` | experimental | no |
| `./subscriptions` | `DEFAULT_SUBSCRIPTION_RETRY_BACKOFF_HOURS` | experimental | no |
| `./subscriptions` | `RenewalCyclePolicy` | stable | yes |
| `./subscriptions` | `StockWaitAdminPage` | experimental | no |
| `./subscriptions` | `StockWaitOperatorSummary` | experimental | no |
| `./subscriptions` | `StockWaitReadNotice` | experimental | no |
| `./subscriptions` | `StockWaitReadProjection` | experimental | no |
| `./subscriptions` | `StockWaitReadState` | experimental | no |
| `./subscriptions` | `SubscriptionEditQuoteTtlMinutesPolicy` | experimental | no |
| `./subscriptions` | `SubscriptionRetrySchedulePolicy` | experimental | no |
| `./subscriptions` | `createPostgresStockWaitReads` | experimental | no |
| `./subscriptions` | `createPostgresSubscriptionSaveOfferAcceptor` | experimental | no |
| `./subscriptions` | `installSubscriptionEditQuoteTtlMinutesPolicy` | experimental | no |
| `./subscriptions` | `installSubscriptionRetrySchedulePolicy` | experimental | no |
| `./subscriptions` | `readSubscriptionEditQuoteTtlMinutesOverride` | experimental | no |
| `./subscriptions` | `readSubscriptionEditQuoteTtlMinutesPolicy` | experimental | no |
| `./subscriptions` | `readSubscriptionRetryScheduleOverride` | experimental | no |
| `./subscriptions` | `readSubscriptionRetrySchedulePolicy` | experimental | no |
| `./subscriptions` | `resolveSubscriptionEditQuoteTtlMinutes` | experimental | no |
| `./subscriptions` | `selectCatalogProfileCadence` | experimental | no |
| `./subscriptions` | `stockWaitHealth` | experimental | no |
| `./subscriptions` | `validateSubscriptionEditQuoteTtlMinutes` | experimental | no |
| `./subscriptions` | `validateSubscriptionRetrySchedule` | experimental | no |
| `./subscriptions/contracts` | `StockWaitAdminPage` | experimental | no |
| `./subscriptions/contracts` | `StockWaitOperatorSummary` | experimental | no |
| `./subscriptions/contracts` | `StockWaitReadNotice` | experimental | no |
| `./subscriptions/contracts` | `StockWaitReadProjection` | experimental | no |
| `./subscriptions/contracts` | `StockWaitReadState` | experimental | no |
| `./subscriptions/contracts` | `SubscriptionSaveOfferPresentation` | experimental | no |

68 symbols are not listed because their declarations are not in this package's API reports.

5 subpaths omitted because their names are provider-specific. Complete list: [package.json](https://github.com/openlup/openlup/blob/openlup-core-v1.3.0/packages/platform/package.json) and [Subpath maturity](https://github.com/openlup/openlup/blob/openlup-core-v1.3.0/packages/platform/AGENTS.md#subpath-maturity).
<!-- /generated:maturity-symbols:platform -->

