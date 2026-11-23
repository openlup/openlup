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
