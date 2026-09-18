import type { SupabaseClient } from "@supabase/supabase-js";

import { selectUniqueEffectivePriceList } from "../../../src/domains/pricing/commercePriceAuthority.js";
import type { AdminSubscriptionBandEntry } from "../../../src/domains/commerce/adminPromotionsContracts.js";
import {
  CommercePriceAuthorityError,
  type CommercePriceAuthorityPort,
} from "../../../src/domains/pricing/ports.js";
import type { SettlementProfile } from "../../../src/lib/currency/platformCurrency.js";

import type { AdminPromotionsSupabaseClient } from "./adminPromotions.js";
import { createSupabaseCommercePriceAuthorityPort } from "./pricingResolver.js";

/**
 * The admin subscription band, read the way checkout prices a subscription line.
 *
 * Since D5 the subscription unit price is DERIVED by the strict price authority
 * from the one_time base and the effective `subscription_price_policy_revisions`
 * row; the stored `price_entries.mode='subscription'` rows on the active list are
 * closed (`active=false`). Pairing stored rows - what this adapter did until
 * 2026-09-09 - therefore returned an empty band on production, which blanked the
 * Code Center's preview context and disabled create/activate.
 *
 * Twin of `STRICT_D1_COMMERCE_CHANNEL` in
 * `server/domains/commerce/dbBackedCommerceQuotePort.ts`: the admin band and the
 * public quote must ask the authority for the SAME settlement context, or the
 * operator previews a price no customer is ever charged.
 */
const ADMIN_BAND_COMMERCE_CHANNEL = "D2C";

type Row = Record<string, unknown>;

export interface AdminSubscriptionBandDeps {
  /** Injected only by tests that drive the authority directly; production builds it from `client`. */
  priceAuthorityPort?: CommercePriceAuthorityPort;
  now?: () => string;
}

export async function listSubscriptionBandEntries(
  client: AdminPromotionsSupabaseClient,
  settlement: SettlementProfile,
  deps: AdminSubscriptionBandDeps = {},
): Promise<AdminSubscriptionBandEntry[]> {
  // Share one instant across list selection and every variant's policy resolution.
  const atTime = (deps.now ?? (() => new Date().toISOString()))();
  const listId = await activePriceListId(client, settlement, atTime);
  if (!listId) return [];
  const rows = await listBandPriceRows(client, listId);
  const authority = deps.priceAuthorityPort
    ?? createSupabaseCommercePriceAuthorityPort({ client: client as unknown as SupabaseClient });
  const entries = await Promise.all(rows.map(
    async (row): Promise<AdminSubscriptionBandEntry | null> => {
      const subscription = await resolveSubscriptionMinor({
        authority, variantId: row.variantId, settlement, atTime,
      });
      if (!subscription) return null;
      const oneTimeMinor = subscription.baseMinor;
      return {
        variantId: row.variantId,
        sku: row.sku,
        oneTimeMinor,
        subscriptionMinor: subscription.minor,
        percent: oneTimeMinor > 0 ? Math.round((1 - subscription.minor / oneTimeMinor) * 100) : 0,
      };
    },
  ));

  return entries
    .filter((entry): entry is AdminSubscriptionBandEntry => entry !== null)
    .sort(bySku);
}

/** A refused variant is omitted; stored legacy pricing belongs solely to the authority. */
async function resolveSubscriptionMinor(input: {
  authority: CommercePriceAuthorityPort;
  variantId: string;
  settlement: SettlementProfile;
  atTime: string;
}): Promise<{ minor: number; baseMinor: number } | null> {
  try {
    const resolved = await input.authority.resolvePrice({
      variantId: input.variantId,
      mode: "subscription",
      regionCode: input.settlement.regionCode,
      currency: input.settlement.defaultCurrency,
      channel: ADMIN_BAND_COMMERCE_CHANNEL,
      atTime: input.atTime,
    });
    // `subscription_policy` carries the policy-derived amount and
    // `subscription_legacy` the stored pre-cutover one; both spell it here.
    return { minor: resolved.unitPriceMinor, baseMinor: resolved.base.unitPriceMinor };
  } catch (error) {
    if (!(error instanceof CommercePriceAuthorityError)) throw error;
    return null;
  }
}

interface BandPriceRow {
  variantId: string;
  sku: string | null;
}

async function listBandPriceRows(
  client: AdminPromotionsSupabaseClient, listId: string,
): Promise<BandPriceRow[]> {
  const { data, error } = await client
    .from("price_entries")
    .select("variant_id, catalog_skus!price_entries_variant_id_fkey(sku)")
    .eq("price_list_id", listId)
    .eq("active", true)
    .eq("min_qty", 1)
    .eq("mode", "one_time");
  if (error) throw asError(error, "subscription_band_list_failed");
  const rows = Array.isArray(data) ? (data as Row[]) : [];
  const byVariant = new Map<string, BandPriceRow>();
  for (const row of rows) {
    if (typeof row.variant_id !== "string") continue;
    byVariant.set(row.variant_id, { variantId: row.variant_id, sku: skuOf(row) });
  }
  return [...byVariant.values()];
}

/** Deterministic table order; a SKU-less variant sorts last, then by id, never by read order. */
function bySku(left: AdminSubscriptionBandEntry, right: AdminSubscriptionBandEntry): number {
  if (left.sku === right.sku) return left.variantId.localeCompare(right.variantId);
  if (left.sku === null) return 1;
  if (right.sku === null) return -1;
  return left.sku.localeCompare(right.sku);
}

/** Select the same unique effective market list as the strict price authority. */
async function activePriceListId(
  client: AdminPromotionsSupabaseClient, settlement: SettlementProfile, atTime: string,
): Promise<string | null> {
  const { data, error } = await client
    .from("price_lists")
    .select("id, valid_from, valid_to")
    .eq("region_code", settlement.regionCode)
    .eq("currency", settlement.defaultCurrency)
    .eq("status", "active");
  if (error) throw asError(error, "price_list_lookup_failed");
  const rows = Array.isArray(data) ? (data as Row[]) : [];
  try {
    return selectUniqueEffectivePriceList(rows.map((row) => ({
      value: row.id as string,
      validFrom: row.valid_from as string,
      validTo: row.valid_to as string | null,
    })), atTime);
  } catch (error) {
    if (!(error instanceof CommercePriceAuthorityError)) throw error;
    return null;
  }
}

function skuOf(row: Row): string | null {
  const joined = row.catalog_skus;
  const obj = Array.isArray(joined) ? joined[0] : joined;
  const sku = (obj as Row | null | undefined)?.sku;
  return typeof sku === "string" ? sku : null;
}

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}
