import { expect, it, vi } from "vitest";
import corpus from "./inventory_renewal_protection.json";
import { installRenewalStockProtectionPolicy, readRenewalStockProtectionPolicy, validateRenewalStockProtection } from "../../src/inventory/renewalStockProtection.js";

it("defaults only for an absent row and installs exact validated JSON", async () => {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  expect(await readRenewalStockProtectionPolicy({ query })).toEqual({ revision: "default", renewalProtectionDays: 14 });
  for (const days of [1, 7, 14, 21, 3660]) {
    const policy = { revision: "owned-1", renewalProtectionDays: days };
    await installRenewalStockProtectionPolicy({ query }, policy);
    expect(query.mock.lastCall?.[1]).toEqual(["inventory_renewal_protection", JSON.stringify(policy)]);
    query.mockResolvedValueOnce({ rows: [{ value_text: JSON.stringify(policy) }] });
    expect(await readRenewalStockProtectionPolicy({ query })).toEqual(policy);
  }
});
it.each(corpus)("shared corpus (TS): $name", async ({ input: rawJson, accepted, normalized, decodedNormalized, code }) => {
  const input: unknown = JSON.parse(rawJson);
  if (accepted || decodedNormalized) {
    expect(validateRenewalStockProtection(input)).toStrictEqual(decodedNormalized ?? normalized);
    return;
  }
  const query = vi.fn().mockResolvedValue({ rows: [{ value_text: rawJson }] });
  expect(() => validateRenewalStockProtection(input)).toThrow(code);
  await expect(installRenewalStockProtectionPolicy({ query }, input as never)).rejects.toThrow(code);
  expect(query).not.toHaveBeenCalled();
  await expect(readRenewalStockProtectionPolicy({ query })).rejects.toThrow(code);
});
it.each([Infinity, NaN])("refuses non-JSON numbers before writes: %s", async renewalProtectionDays => {
  const query = vi.fn();
  await expect(installRenewalStockProtectionPolicy({ query }, { revision: "x", renewalProtectionDays }))
    .rejects.toThrow("inventory_renewal_protection_policy_invalid");
  expect(query).not.toHaveBeenCalled();
});
it.each([null, "{bad-json", "undefined"])("names malformed persisted JSON: %j", async value_text => {
  const query = vi.fn().mockResolvedValue({ rows: [{ value_text }] });
  await expect(readRenewalStockProtectionPolicy({ query })).rejects.toThrow("inventory_renewal_protection_policy_invalid");
  expect(query.mock.calls[0]?.[0]).toMatch(/^SELECT /);
});
