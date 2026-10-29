import {
  readFiscalProfile as readPackageFiscalProfile,
  type FiscalProfile,
} from "@openlup/platform/market-packs";
export type { FiscalProfile } from "@openlup/platform/market-packs";
export { InvalidFiscalProfileError, InvalidMinimumProductPayableError, readMinimumProductPayableMinor } from "@openlup/platform/market-packs";

export const PLATFORM_DEFAULT_FISCAL_PROFILE: FiscalProfile = {
  included: true,
  country: "PL",
  category: "pet_food",
  vatRateBps: 800,
  legalBasis: "PL VAT Annex 3 item 10c",
};

/** Preserve the existing reference fiscal fallback at this application owner. */
export function readFiscalProfile(env: Readonly<Record<string, string | undefined>> = {}): FiscalProfile {
  return readPackageFiscalProfile(env, PLATFORM_DEFAULT_FISCAL_PROFILE);
}
