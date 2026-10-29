import {
  readSettlementProfile as readPackageSettlementProfile,
  type SettlementProfile,
} from "@openlup/platform/market-packs";
import { PLATFORM_DEFAULT_FISCAL_PROFILE } from "./fiscalProfile.js";
export type { SettlementProfile } from "@openlup/platform/market-packs";
export { InvalidSettlementCurrencyError, InvalidSettlementRegionError, describesSameSettlement } from "@openlup/platform/market-packs";

export const PLATFORM_DEFAULT_CURRENCY = "PLN" as const;

/**
 * The environment key that names the currency this deployment settles in.
 *
 * `COMMERCE_` rather than `PLATFORM_` on purpose: only the prefixes listed in
 * the env/flag discovery guard are governed, and `PLATFORM_` is not among
 * them. A `PLATFORM_`-named key would be invisible to the registry guard —
 * droppable, renameable and misspellable with nothing failing. The prefix is a
 * governance namespace, not a statement about which domain owns the concept.
 */
export const PLATFORM_DEFAULT_REGION = "PL" as const;

/** The environment key that names the region this deployment prices for. */
/** Use the same reference facts when env values are absent or blank. */
export function readSettlementProfile(env: Readonly<Record<string, string | undefined>> = {}): SettlementProfile {
  return readPackageSettlementProfile(env, {
    defaultCurrency: PLATFORM_DEFAULT_CURRENCY,
    regionCode: PLATFORM_DEFAULT_REGION,
    fiscalProfile: PLATFORM_DEFAULT_FISCAL_PROFILE,
  });
}
