import { catalogPriceSetupApplyResultSchema, catalogPriceSetupPreviewResultSchema, catalogPriceSetupReasonsSchema } from "./catalogPriceSetupSchemas.js";
import type { CatalogPriceSetupRefusal } from "./contracts/catalogPriceSetup.js";
import type { CatalogPriceSetupStorePort } from "./catalogPriceSetupHandler.js";

/** The authenticated transaction's executor; publication may use its own connection. */
export interface CatalogPriceSetupQueryExecutor {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Session-bound SQL authority derives the actor; composition verifies the session. */
export function createPostgresCatalogPriceSetupStore(client: CatalogPriceSetupQueryExecutor): CatalogPriceSetupStorePort {
  async function call(sql: string, values: unknown[], schema: typeof catalogPriceSetupApplyResultSchema | typeof catalogPriceSetupPreviewResultSchema) {
    try {
      const result = await client.query(sql, values);
      const parsed = schema.safeParse(result.rows.length === 1 ? result.rows[0]?.result : undefined);
      return parsed.success ? parsed.data : { outcome: "dependency_unavailable" as const, reason: "invalid_store_response" };
    } catch (error) { return catalogPriceSetupRefusal(error); }
  }
  return {
    preview: query => call("SELECT public.catalog_price_setup_preview($1::uuid,$2::uuid,$3::integer) AS result",
      [query.variantId, query.priceListId, query.unitPriceMinor ?? null], catalogPriceSetupPreviewResultSchema),
    apply: input => call("SELECT public.catalog_price_setup_apply($1::text,$2::text) AS result",
      [input.canonicalCommand, input.fingerprint], catalogPriceSetupApplyResultSchema),
  };
}

/** Explicit whitelist: arbitrary database text never reaches a caller. */
export const CATALOG_PRICE_SETUP_HARD_REFUSALS = [
  "native_promotion_unverified", "native_cohort_unverified", "native_order_unverified", "native_agreement_unverified",
  "settlement_context_unverified", "native_promotion_domain_unverified", "native_price_domain_unverified",
  "native_catalog_domain_unverified", "native_policy_domain_unverified", "native_agreement_domain_unverified",
  "native_job_domain_unverified", "native_order_domain_unverified", "native_order_policy_pair_unverified",
  "native_order_admission_unverified", "native_order_guard_unverified", "native_order_claim_guard_unverified",
] as const;

/** Preserve refusal precedence, including hard evidence failures before/after writes. */
export function catalogPriceSetupRefusal(error: unknown): CatalogPriceSetupRefusal {
  const field = (key: string): unknown => error !== null && typeof error === "object" && key in error
    ? (error as Record<string, unknown>)[key] : undefined;
  const code = field("code"), message = field("message");
  if (code === "42501") return { outcome: "unauthorized", reason: "operator_required" };
  if (code === "40001") return { outcome: "conflict", reason: "expected_state_mismatch" };
  if (code === "55000" && message === "catalog_price_setup_readiness_would_fail") {
    let reasons: string[] | undefined;
    try {
      const parsed = catalogPriceSetupReasonsSchema.safeParse(JSON.parse(String(field("detail") ?? field("details"))));
      if (parsed.success) reasons = parsed.data;
    } catch { /* Only a valid bounded reason list is public. */ }
    return { outcome: "validation_issue", reason: "readiness_would_fail", ...(reasons ? { reasons } : {}) };
  }
  if (code === "55000") for (const reason of CATALOG_PRICE_SETUP_HARD_REFUSALS) {
    if (message === `catalog_price_setup_${reason}`) return { outcome: "dependency_unavailable", reason };
  }
  if (code === "22023") return { outcome: "validation_issue", reason: "invalid_store_request" };
  return { outcome: "dependency_unavailable", reason: "store_unavailable" };
}
