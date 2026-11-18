import { expect, it, vi } from "vitest";
import { installRenewalStockProtectionPolicy, readRenewalStockProtectionPolicy } from "../../src/inventory/renewalStockProtection.js";

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
it.each([null, [], {}, { revision: "x" }, { renewalProtectionDays: 14 },
  ...["", " \t", null, 1].map(revision => ({ revision, renewalProtectionDays: 14 })),
  ...[null, "14", 0, -1, 1.5, 3661, Infinity, NaN].map(renewalProtectionDays => ({ revision: "x", renewalProtectionDays })),
  { revision: "x", renewalProtectionDays: 14, extra: true },
])("refuses invalid policy before writes and on persisted reads: %j", async value => {
  const query = vi.fn().mockResolvedValue({ rows: [{ value_text: JSON.stringify(value) }] });
  await expect(installRenewalStockProtectionPolicy({ query }, value as never)).rejects.toThrow("inventory_renewal_protection_policy_invalid");
  expect(query).not.toHaveBeenCalled();
  await expect(readRenewalStockProtectionPolicy({ query })).rejects.toThrow("inventory_renewal_protection_policy_invalid");
});
it.each([null, "{bad-json", "undefined"])("names malformed persisted JSON: %j", async value_text => {
  const query = vi.fn().mockResolvedValue({ rows: [{ value_text }] });
  await expect(readRenewalStockProtectionPolicy({ query })).rejects.toThrow("inventory_renewal_protection_policy_invalid");
  expect(query.mock.calls[0]?.[0]).toMatch(/^SELECT /);
});
