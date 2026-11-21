import { packagedPlatformMigrationPosition } from "../migrations/index.js";

/** Sparse projections of canonical units, never an install chain. */
export const BUNDLE_MIGRATIONS = [
  { id: "20260812140000_sellable_bundle_catalog", catalogPath: "db/platform/migrations/20260812140000_sellable_bundle_catalog.sql", position: 16, sha256: "62fbf0910a3a7a2ee47e2d798933fe0a5a273fd1242cae7cc78ff237ba39e394", url: new URL("../../sql/20260812140000_sellable_bundle_catalog.sql", import.meta.url) },
  { id: "20260812210000_bundle_operator_write_boundary", catalogPath: "db/platform/migrations/20260812210000_bundle_operator_write_boundary.sql", position: 19, sha256: "d0ec6674d7eedf4cd3ce0d8ccd7345ebe2f93da635316a68a6bd178ec55b2679", url: new URL("../../sql/20260812210000_bundle_operator_write_boundary.sql", import.meta.url) },
] as const;

/**
 * Catalog foundation projections; install the complete canonical catalogue.
 * @appendOnly
 */
export const CATALOG_MIGRATIONS: readonly [
  { readonly id: "20260807140000_read_parity_catalog"; readonly catalogPath: "db/platform/migrations/20260807140000_read_parity_catalog.sql"; readonly position: 1; readonly sha256: "fcf3827028c1651ae42a7c7d7472153825a3121c936d58a3d105befc7dece9ea"; readonly url: URL; },
  { readonly id: "20260810120000_storefront_catalog_attributes"; readonly catalogPath: "db/platform/migrations/20260810120000_storefront_catalog_attributes.sql"; readonly position: 8; readonly sha256: "2bf938f5d0076193557bea834f86dbd9bcb7f3e2de00f99fb91cc1229b93a14b"; readonly url: URL; },
  { readonly id: "20260827220000_catalog_document_revision_foundation"; readonly catalogPath: "db/platform/migrations/20260827220000_catalog_document_revision_foundation.sql"; readonly position: 58; readonly sha256: "715e74d655b76d35b8a49e0d2a5625594a6c4856863f369cd1eadcd1fb1ae90e"; readonly url: URL; },
  { readonly id: "20260827220001_catalog_document_revision_foundation_validate"; readonly catalogPath: "db/platform/migrations/20260827220001_catalog_document_revision_foundation_validate.sql"; readonly position: 59; readonly sha256: "f3cd7fb61dcebac1cf0468cf2d7c1f9dd036817ab0094c72864266e307b269de"; readonly url: URL; },
  { readonly id: "20260908100000_catalog_draft_foundation"; readonly catalogPath: "db/platform/migrations/20260908100000_catalog_draft_foundation.sql"; readonly position: 61; readonly sha256: "ac0d614cdb2874df8fbdbbbda4f9455986ef95241fe1334b0b54a1fa6478ab2e"; readonly url: URL; },
  /** @experimental */
  { readonly id: "20261122100000_catalog_definition_binding"; readonly catalogPath: "db/platform/migrations/20261122100000_catalog_definition_binding.sql"; readonly position: 142; readonly sha256: "3236260783b90d8210d324d656bf5b9406ec9deeb59e943f0bda3f3aa337b6cb"; readonly url: URL; },
  /** @experimental */
  { readonly id: "20261122110000_catalog_quantities"; readonly catalogPath: "db/platform/migrations/20261122110000_catalog_quantities.sql"; readonly position: 143; readonly sha256: "7c347d2449ca970a6edd4ec77a03892680a901450d817f243456b1b08840573a"; readonly url: URL; },
  /** @experimental */
  { readonly id: "20261122120000_catalog_attributes"; readonly catalogPath: "db/platform/migrations/20261122120000_catalog_attributes.sql"; readonly position: 144; readonly sha256: "a33c24d3e7904125cd8e8df489b2c995e83ddbf70fb2fd4dbc6f3c463cdfb7d1"; readonly url: URL; },
  /** @experimental */
  { readonly id: "20261122130000_catalog_variant_axes"; readonly catalogPath: "db/platform/migrations/20261122130000_catalog_variant_axes.sql"; readonly position: 145; readonly sha256: "48bc16639ca567aba31f2257f7cd79ca7c562be4cd4aedc4020aedf70e273c70"; readonly url: URL; },
  /** @experimental */
  { readonly id: "20261122140000_subscription_price_policy_close_digest"; readonly catalogPath: "db/platform/migrations/20261122140000_subscription_price_policy_close_digest.sql"; readonly position: 146; readonly sha256: "3a30959d1a0721fc48455242ec31d2c31d1f52694aefaca80531bac4b270eb78"; readonly url: URL; },
  /** @experimental */
  { readonly id: "20261122150000_catalog_drafts_v2"; readonly catalogPath: "db/platform/migrations/20261122150000_catalog_drafts_v2.sql"; readonly position: 147; readonly sha256: "3336df885007ea87d0d53d18edbf55ae444027cdfeee555486a1371ad23e6376"; readonly url: URL; },
  /** @experimental */
  { readonly id: "20261122160000_catalog_drafts_v3"; readonly catalogPath: "db/platform/migrations/20261122160000_catalog_drafts_v3.sql"; readonly position: 148; readonly sha256: "e5c0fe84c7689a48ef9524037ee0e03ffc47057fcfc84088943fe8f657d0dbfd"; readonly url: URL; },
  /** @experimental */
  { readonly id: "20261122170000_offer_policy_readiness_inputs"; readonly catalogPath: "db/platform/migrations/20261122170000_offer_policy_readiness_inputs.sql"; readonly position: 149; readonly sha256: "f19489a760c073f59b155d83dbab6bc2b33a96b5d17206806b21b257497d0e9f"; readonly url: URL; },
  /** @experimental */
  { readonly id: "20261122180000_catalog_base_price_writer"; readonly catalogPath: "db/platform/migrations/20261122180000_catalog_base_price_writer.sql"; readonly position: 150; readonly sha256: "42ae3bf025c9e1a6b0a554672dae00d122b55d7185f0016e7a7604ffc94b4d65"; readonly url: URL; },
  /** @experimental */
  { readonly id: "20261123190000_catalog_publication"; readonly catalogPath: "db/platform/migrations/20261123190000_catalog_publication.sql"; readonly position: number; readonly sha256: "4cbee715641c5cc7fcaa779feb5b25959db2418867a2be672e61d7130838a8e9"; readonly url: URL; },
  /** @experimental */
  { readonly id: "20261123191000_catalog_publication_commands"; readonly catalogPath: "db/platform/migrations/20261123191000_catalog_publication_commands.sql"; readonly position: number; readonly sha256: "2a83d6f21a923669dcab4230569dcb7c1e4218d87b6c8e99589f857854725907"; readonly url: URL; },
  /** @experimental */
  { readonly id: "20261123192000_subscription_price_policy_close_provenance"; readonly catalogPath: "db/platform/migrations/20261123192000_subscription_price_policy_close_provenance.sql"; readonly position: number; readonly sha256: "0522c432752df11a5e49787b9847137a77ddf7b969e9dc770686232117c8af96"; readonly url: URL; },
  /** @experimental */
  { readonly id: "20261124190000_catalog_quantity_serving"; readonly catalogPath: "db/platform/migrations/20261124190000_catalog_quantity_serving.sql"; readonly position: number; readonly sha256: "43329ff5134966e6efac9732a9dbdc1f2e769d8fc0c73956369d6eb7a233e790"; readonly url: URL; },
] = [
  { id: "20260807140000_read_parity_catalog", catalogPath: "db/platform/migrations/20260807140000_read_parity_catalog.sql", position: 1, sha256: "fcf3827028c1651ae42a7c7d7472153825a3121c936d58a3d105befc7dece9ea", url: new URL("../../sql/20260807140000_read_parity_catalog.sql", import.meta.url) },
  { id: "20260810120000_storefront_catalog_attributes", catalogPath: "db/platform/migrations/20260810120000_storefront_catalog_attributes.sql", position: 8, sha256: "2bf938f5d0076193557bea834f86dbd9bcb7f3e2de00f99fb91cc1229b93a14b", url: new URL("../../sql/20260810120000_storefront_catalog_attributes.sql", import.meta.url) },
  { id: "20260827220000_catalog_document_revision_foundation", catalogPath: "db/platform/migrations/20260827220000_catalog_document_revision_foundation.sql", position: 58, sha256: "715e74d655b76d35b8a49e0d2a5625594a6c4856863f369cd1eadcd1fb1ae90e", url: new URL("../../sql/20260827220000_catalog_document_revision_foundation.sql", import.meta.url) },
  { id: "20260827220001_catalog_document_revision_foundation_validate", catalogPath: "db/platform/migrations/20260827220001_catalog_document_revision_foundation_validate.sql", position: 59, sha256: "f3cd7fb61dcebac1cf0468cf2d7c1f9dd036817ab0094c72864266e307b269de", url: new URL("../../sql/20260827220001_catalog_document_revision_foundation_validate.sql", import.meta.url) },
  { id: "20260908100000_catalog_draft_foundation", catalogPath: "db/platform/migrations/20260908100000_catalog_draft_foundation.sql", position: 61, sha256: "ac0d614cdb2874df8fbdbbbda4f9455986ef95241fe1334b0b54a1fa6478ab2e", url: new URL("../../sql/20260908100000_catalog_draft_foundation.sql", import.meta.url) },
  { id: "20261122100000_catalog_definition_binding", catalogPath: "db/platform/migrations/20261122100000_catalog_definition_binding.sql", position: 142, sha256: "3236260783b90d8210d324d656bf5b9406ec9deeb59e943f0bda3f3aa337b6cb", url: new URL("../../sql/20261122100000_catalog_definition_binding.sql", import.meta.url) },
  { id: "20261122110000_catalog_quantities", catalogPath: "db/platform/migrations/20261122110000_catalog_quantities.sql", position: 143, sha256: "7c347d2449ca970a6edd4ec77a03892680a901450d817f243456b1b08840573a", url: new URL("../../sql/20261122110000_catalog_quantities.sql", import.meta.url) },
  { id: "20261122120000_catalog_attributes", catalogPath: "db/platform/migrations/20261122120000_catalog_attributes.sql", position: 144, sha256: "a33c24d3e7904125cd8e8df489b2c995e83ddbf70fb2fd4dbc6f3c463cdfb7d1", url: new URL("../../sql/20261122120000_catalog_attributes.sql", import.meta.url) },
  { id: "20261122130000_catalog_variant_axes", catalogPath: "db/platform/migrations/20261122130000_catalog_variant_axes.sql", position: 145, sha256: "48bc16639ca567aba31f2257f7cd79ca7c562be4cd4aedc4020aedf70e273c70", url: new URL("../../sql/20261122130000_catalog_variant_axes.sql", import.meta.url) },
  { id: "20261122140000_subscription_price_policy_close_digest", catalogPath: "db/platform/migrations/20261122140000_subscription_price_policy_close_digest.sql", position: 146, sha256: "3a30959d1a0721fc48455242ec31d2c31d1f52694aefaca80531bac4b270eb78", url: new URL("../../sql/20261122140000_subscription_price_policy_close_digest.sql", import.meta.url) },
  { id: "20261122150000_catalog_drafts_v2", catalogPath: "db/platform/migrations/20261122150000_catalog_drafts_v2.sql", position: 147, sha256: "3336df885007ea87d0d53d18edbf55ae444027cdfeee555486a1371ad23e6376", url: new URL("../../sql/20261122150000_catalog_drafts_v2.sql", import.meta.url) },
  { id: "20261122160000_catalog_drafts_v3", catalogPath: "db/platform/migrations/20261122160000_catalog_drafts_v3.sql", position: 148, sha256: "e5c0fe84c7689a48ef9524037ee0e03ffc47057fcfc84088943fe8f657d0dbfd", url: new URL("../../sql/20261122160000_catalog_drafts_v3.sql", import.meta.url) },
  { id: "20261122170000_offer_policy_readiness_inputs", catalogPath: "db/platform/migrations/20261122170000_offer_policy_readiness_inputs.sql", position: 149, sha256: "f19489a760c073f59b155d83dbab6bc2b33a96b5d17206806b21b257497d0e9f", url: new URL("../../sql/20261122170000_offer_policy_readiness_inputs.sql", import.meta.url) },
  { id: "20261122180000_catalog_base_price_writer", catalogPath: "db/platform/migrations/20261122180000_catalog_base_price_writer.sql", position: 150, sha256: "42ae3bf025c9e1a6b0a554672dae00d122b55d7185f0016e7a7604ffc94b4d65", url: new URL("../../sql/20261122180000_catalog_base_price_writer.sql", import.meta.url) },
  { id: "20261123190000_catalog_publication", catalogPath: "db/platform/migrations/20261123190000_catalog_publication.sql", get position(): number { return packagedPlatformMigrationPosition(this.catalogPath, this.sha256); }, sha256: "4cbee715641c5cc7fcaa779feb5b25959db2418867a2be672e61d7130838a8e9", url: new URL("../../sql/20261123190000_catalog_publication.sql", import.meta.url) },
  { id: "20261123191000_catalog_publication_commands", catalogPath: "db/platform/migrations/20261123191000_catalog_publication_commands.sql", get position(): number { return packagedPlatformMigrationPosition(this.catalogPath, this.sha256); }, sha256: "2a83d6f21a923669dcab4230569dcb7c1e4218d87b6c8e99589f857854725907", url: new URL("../../sql/20261123191000_catalog_publication_commands.sql", import.meta.url) },
  { id: "20261123192000_subscription_price_policy_close_provenance", catalogPath: "db/platform/migrations/20261123192000_subscription_price_policy_close_provenance.sql", get position(): number { return packagedPlatformMigrationPosition(this.catalogPath, this.sha256); }, sha256: "0522c432752df11a5e49787b9847137a77ddf7b969e9dc770686232117c8af96", url: new URL("../../sql/20261123192000_subscription_price_policy_close_provenance.sql", import.meta.url) },
  { id: "20261124190000_catalog_quantity_serving", catalogPath: "db/platform/migrations/20261124190000_catalog_quantity_serving.sql", get position(): number { return packagedPlatformMigrationPosition(this.catalogPath, this.sha256); }, sha256: "43329ff5134966e6efac9732a9dbdc1f2e769d8fc0c73956369d6eb7a233e790", url: new URL("../../sql/20261124190000_catalog_quantity_serving.sql", import.meta.url) },
] as const;
