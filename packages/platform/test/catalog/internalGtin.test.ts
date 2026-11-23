import { expect, it } from "vitest";
import { catalogInternalGtin, isValidGtin } from "../../src/catalog/index.js";

it.each([0, 1, 9_999_999_999])("internal_gtin_is_valid (%i)", (sequence) => {
  const value = catalogInternalGtin(sequence);
  expect(value).toHaveLength(13);
  expect(value.slice(0, -1)).toBe(`04${String(sequence).padStart(10, "0")}`);
  expect(isValidGtin(value)).toBe(true);
});

it.each([-1, 10_000_000_000, 1.5])("sequence_out_of_range_refuses (%s)", (sequence) => {
  expect(() => catalogInternalGtin(sequence)).toThrow(expect.objectContaining({
    name: "RangeError",
    code: "catalog_internal_gtin_sequence_invalid",
    message: "The internal identifier sequence must be an integer from 0 to 9999999999.",
  }));
  expect(() => catalogInternalGtin(sequence)).toThrow(RangeError);
});
