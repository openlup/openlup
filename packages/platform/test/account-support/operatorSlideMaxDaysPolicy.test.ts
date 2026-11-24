import { expect, it, vi } from "vitest";
import corpus from "./account_support_operator_slide_max_days.json";
import {
  DEFAULT_ACCOUNT_SUPPORT_OPERATOR_SLIDE_MAX_DAYS,
  installAccountSupportOperatorSlideMaxDaysPolicy,
  readAccountSupportOperatorSlideMaxDaysOverride,
  readAccountSupportOperatorSlideMaxDaysPolicy,
  validateAccountSupportOperatorSlideMaxDays,
} from "../../src/account-support/operatorSlideMaxDaysPolicy.js";

it("defaults only for an absent row and installs exact validated JSON", async () => {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  expect(DEFAULT_ACCOUNT_SUPPORT_OPERATOR_SLIDE_MAX_DAYS).toBe(60);
  expect(await readAccountSupportOperatorSlideMaxDaysOverride({ query })).toBeUndefined();
  expect(await readAccountSupportOperatorSlideMaxDaysPolicy({ query })).toEqual({
    revision: "default",
    maxDays: 60,
  });
  for (const maxDays of [3, 14, 60, 120, 365]) {
    const policy = { revision: "owned-1", maxDays };
    await installAccountSupportOperatorSlideMaxDaysPolicy({ query }, policy);
    expect(query.mock.lastCall?.[1]).toEqual(["account_support_operator_slide_max_days", JSON.stringify(policy)]);
    query.mockResolvedValueOnce({ rows: [{ value_text: JSON.stringify(policy) }] });
    expect(await readAccountSupportOperatorSlideMaxDaysPolicy({ query })).toEqual(policy);
  }
});

it.each(corpus)("shared corpus (TS): $name", async ({ input: rawJson, accepted, normalized, decodedNormalized, code }) => {
  const input: unknown = JSON.parse(rawJson);
  if (accepted || decodedNormalized) {
    expect(validateAccountSupportOperatorSlideMaxDays(input)).toStrictEqual(decodedNormalized ?? normalized);
    return;
  }
  const query = vi.fn().mockResolvedValue({ rows: [{ value_text: rawJson }] });
  expect(() => validateAccountSupportOperatorSlideMaxDays(input)).toThrow(code);
  await expect(installAccountSupportOperatorSlideMaxDaysPolicy({ query }, input as never)).rejects.toThrow(code);
  expect(query).not.toHaveBeenCalled();
  await expect(readAccountSupportOperatorSlideMaxDaysPolicy({ query })).rejects.toThrow(code);
  await expect(readAccountSupportOperatorSlideMaxDaysOverride({ query })).rejects.toThrow(code);
});

it.each([Infinity, NaN])("refuses non-JSON numbers before writes: %s", async bad => {
  const query = vi.fn();
  await expect(installAccountSupportOperatorSlideMaxDaysPolicy({ query }, { revision: "x", maxDays: bad }))
    .rejects.toThrow("account_support_operator_slide_max_days_policy_invalid");
  expect(query).not.toHaveBeenCalled();
});

it.each([null, "{bad-json", "undefined"])("names malformed persisted JSON: %j", async value_text => {
  const query = vi.fn().mockResolvedValue({ rows: [{ value_text }] });
  await expect(readAccountSupportOperatorSlideMaxDaysPolicy({ query }))
    .rejects.toThrow("account_support_operator_slide_max_days_policy_invalid");
  expect(query.mock.calls[0]?.[0]).toMatch(/^SELECT /);
});
