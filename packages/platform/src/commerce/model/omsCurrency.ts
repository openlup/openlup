import type { OmsCurrencyPolicy } from "../contracts/omsTypes.js";
export type { OmsCurrencyPolicy } from "../contracts/omsTypes.js";
/** Settlement policy is supplied by the host; the neutral default checks format only. */

export const neutralOmsCurrencyPolicy: OmsCurrencyPolicy = {
  defaultCurrency: "XXX",
  accepts: currency => /^[A-Z]{3}$/.test(currency),
};
