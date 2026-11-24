import { expect, it, vi } from "vitest";
import corpus from "./promotion_claim_hold_hours.json";
import {
  DEFAULT_PROMOTION_CLAIM_HOLD_HOURS,
  installPromotionClaimHoldHoursPolicy,
  readPromotionClaimHoldHoursOverride,
  readPromotionClaimHoldHoursPolicy,
  validatePromotionClaimHoldHours,
} from "../../src/promotions/claimHoldHoursPolicy.js";

it("defaults only for an absent row and installs exact validated JSON", async () => {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  expect(DEFAULT_PROMOTION_CLAIM_HOLD_HOURS).toBe(24);
  expect(await readPromotionClaimHoldHoursOverride({ query })).toBeUndefined();
  expect(await readPromotionClaimHoldHoursPolicy({ query })).toEqual({ revision: "default", holdHours: 24 });
  for (const holdHours of [1, 6, 24, 48, 720]) {
    const policy = { revision: "owned-1", holdHours };
    await installPromotionClaimHoldHoursPolicy({ query }, policy);
    expect(query.mock.lastCall?.[1]).toEqual(["promotion_claim_hold_hours", JSON.stringify(policy)]);
    query.mockResolvedValueOnce({ rows: [{ value_text: JSON.stringify(policy) }] });
    expect(await readPromotionClaimHoldHoursPolicy({ query })).toEqual(policy);
  }
});

it.each(corpus)("shared corpus (TS): $name", async ({ input: rawJson, accepted, normalized, decodedNormalized, code }) => {
  const input: unknown = JSON.parse(rawJson);
  if (accepted || decodedNormalized) {
    expect(validatePromotionClaimHoldHours(input)).toStrictEqual(decodedNormalized ?? normalized);
    return;
  }
  const query = vi.fn().mockResolvedValue({ rows: [{ value_text: rawJson }] });
  expect(() => validatePromotionClaimHoldHours(input)).toThrow(code);
  await expect(installPromotionClaimHoldHoursPolicy({ query }, input as never)).rejects.toThrow(code);
  expect(query).not.toHaveBeenCalled();
  await expect(readPromotionClaimHoldHoursPolicy({ query })).rejects.toThrow(code);
  await expect(readPromotionClaimHoldHoursOverride({ query })).rejects.toThrow(code);
});

it.each([Infinity, NaN])("refuses non-JSON numbers before writes: %s", async holdHours => {
  const query = vi.fn();
  await expect(installPromotionClaimHoldHoursPolicy({ query }, { revision: "x", holdHours }))
    .rejects.toThrow("promotion_claim_hold_hours_policy_invalid");
  expect(query).not.toHaveBeenCalled();
});

it.each([null, "{bad-json", "undefined"])("names malformed persisted JSON: %j", async value_text => {
  const query = vi.fn().mockResolvedValue({ rows: [{ value_text }] });
  await expect(readPromotionClaimHoldHoursPolicy({ query })).rejects.toThrow("promotion_claim_hold_hours_policy_invalid");
  expect(query.mock.calls[0]?.[0]).toMatch(/^SELECT /);
});
