import type { RequiredSchema } from "@openlup/core/readiness";
import type { CatalogCapabilityDescriptor } from "@openlup/platform/catalog";

/** The host supplies its observed complete catalogue identity, never a sparse projection identity. */
export function m05CatalogSchema(catalogue: { version: string; migration: string }): RequiredSchema {
  return {
    ...catalogue,
    objects: [
      ...["catalog_products", "catalog_skus", "catalog_product_document_revisions", "catalog_sku_identifiers", "catalog_draft_heads", "catalog_draft_revisions", "catalog_draft_command_receipts", "catalog_draft_sku_reservations", "catalog_bundles", "catalog_bundle_components", "catalog_bundle_prices", "catalog_bundle_write_events", "price_lists", "price_entries", "subscription_price_policy_revisions", "platform_communication_operators"].map(name => ({ kind: "table" as const, name: `public.${name}` })),
      ...Object.entries({
        catalog_products: "id slug primary_sku_id current_document_revision_id",
        catalog_skus: "id product_id sku title net_weight_g status sellable_standalone sellable_in_subscription is_addon asset_ref",
        catalog_product_document_revisions: "id product_id revision_no schema_id document_ref source_ref digest",
        catalog_sku_identifiers: "catalog_sku_id issuer identifier_kind normalized_value pack_kind quantity is_primary",
        catalog_draft_heads: "draft_id product_id revision status",
        catalog_draft_revisions: "draft_id revision product_id status payload command_key fingerprint actor_id created_at",
        catalog_draft_command_receipts: "draft_id command_key fingerprint revision",
        catalog_draft_sku_reservations: "sku_id draft_id product_id code",
        catalog_bundles: "id code title status fulfillment_mode updated_at composition_constraint metadata",
        catalog_bundle_components: "bundle_id catalog_sku_id quantity is_addon sort_order",
        catalog_bundle_prices: "bundle_id price_list_id mode target_price_minor amount_kind active valid_from valid_to",
        catalog_bundle_write_events: "id bundle_code action before_state after_state created_at idempotency_key principal_id",
        price_lists: "id currency region_code status valid_from valid_to created_at",
        price_entries: "id price_list_id variant_id mode min_qty unit_price_minor amount_kind active valid_from valid_to",
        subscription_price_policy_revisions: "id revision_no price_list_id region_code currency channel discount_bps rounding_quantum_minor rounding_rule digest effective_from effective_to",
        platform_communication_operators: "principal_id active",
      }).flatMap(([table, columns]) => columns.split(" ").map(column => ({ kind: "column" as const, name: `public.${table}.${column}` }))),
      ...[
        ["communications_operator_is_active", "uuid"],
        ["catalog_draft_apply", "text,text,text"], ["catalog_draft_get", "uuid,integer,text"], ["catalog_draft_list", "uuid,integer"],
        ["admin_upsert_bundle_draft", "uuid,text,text,text,jsonb,jsonb,text,text,text,text,text"],
        ["admin_set_bundle_composition", "uuid,text,jsonb,text,text,text,text"],
        ["admin_set_bundle_target_price", "uuid,text,text,integer,text,text,text,text,text,text"],
        ["admin_activate_bundle", "uuid,text,text,text,text,text"],
        ["admin_deactivate_bundle", "uuid,text,text,text,text,text"],
        ["admin_archive_bundle", "uuid,text,text,text,text,text"],
        ["admin_restore_bundle", "uuid,text,text,text,text,text"],
      ].map(([name, signature]) => ({ kind: "function" as const, name: `public.${name}`, signature })),
    ],
  };
}

/** Draft status is not publication authority. These native capabilities remain unsupported. */
export const M05_CATALOG_CAPABILITIES: Readonly<CatalogCapabilityDescriptor> = Object.freeze({
  read: true, draft: true, publicationRead: false, publish: false, lifecycleWrite: false,
});
export const M05_UNSUPPORTED_CAPABILITIES = Object.freeze([
  "publicationRead", "publish", "lifecycleWrite", "nativeAcquisitionAcceptance",
  "nativePromotionAdminWrite", "nativePromotionCodeCandidateResolution",
] as const);
