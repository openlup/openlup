import { isValidGtin } from "./contracts/foundation.js";

const internalPrefix = "04";

/**
 * Assigns a restricted-circulation number for use within one store. Choose a
 * sequence unused in that store and keep the result out of external GTIN fields.
 * @experimental
 */
export function catalogInternalGtin(sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 9_999_999_999) {
    throw Object.assign(new RangeError("The internal identifier sequence must be an integer from 0 to 9999999999."), {
      code: "catalog_internal_gtin_sequence_invalid",
    });
  }
  const reference = internalPrefix + String(sequence).padStart(10, "0");
  const sum = [...reference].reduce((total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 1 : 3), 0);
  return reference + String((10 - sum % 10) % 10);
}

/** @internal Classifies a GTIN using its fourteen-digit normalized form. */
export function isInternalGtin(scheme: string, authored: string): boolean {
  if (scheme !== "gs1:gtin" || !isValidGtin(authored)) return true;
  const value = authored.padStart(14, "0");
  if (value.startsWith("000000")) return /^(?:[02]|952|97[7-9]|9[89])/u.test(value.slice(6));
  const body = value.slice(1);
  return value.startsWith("9")
    || /^(?:0[245]|2[0-9]|951|952|9[89]|00000[0-9]{2}|000[1-7][0-9]{3})/u.test(body);
}
