import { expect, it, vi } from "vitest";
import corpus from "./payment_method_expiry_warning_days.json";
import {
  DEFAULT_PAYMENT_METHOD_EXPIRY_WARNING_DAYS,
  installPaymentMethodExpiryWarningDaysPolicy,
  readPaymentMethodExpiryWarningDaysOverride,
  readPaymentMethodExpiryWarningDaysPolicy,
  validatePaymentMethodExpiryWarningDays,
} from "../../src/payments/methodExpiryWarningPolicy.js";

it("defaults only for an absent row and installs exact validated JSON", async () => {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  expect(DEFAULT_PAYMENT_METHOD_EXPIRY_WARNING_DAYS).toBe(30);
  expect(await readPaymentMethodExpiryWarningDaysOverride({ query })).toBeUndefined();
  expect(await readPaymentMethodExpiryWarningDaysPolicy({ query })).toEqual({ revision: "default", warningDays: 30 });
  for (const warningDays of [1, 7, 30, 90, 365]) {
    const policy = { revision: "owned-1", warningDays };
    await installPaymentMethodExpiryWarningDaysPolicy({ query }, policy);
    expect(query.mock.lastCall?.[1]).toEqual(["payment_method_expiry_warning_days", JSON.stringify(policy)]);
    query.mockResolvedValueOnce({ rows: [{ value_text: JSON.stringify(policy) }] });
    expect(await readPaymentMethodExpiryWarningDaysPolicy({ query })).toEqual(policy);
  }
});

it.each(corpus)("shared corpus (TS): $name", async ({ input: rawJson, accepted, normalized, decodedNormalized, code }) => {
  const input: unknown = JSON.parse(rawJson);
  if (accepted || decodedNormalized) {
    expect(validatePaymentMethodExpiryWarningDays(input)).toStrictEqual(decodedNormalized ?? normalized);
    return;
  }
  const query = vi.fn().mockResolvedValue({ rows: [{ value_text: rawJson }] });
  expect(() => validatePaymentMethodExpiryWarningDays(input)).toThrow(code);
  await expect(installPaymentMethodExpiryWarningDaysPolicy({ query }, input as never)).rejects.toThrow(code);
  expect(query).not.toHaveBeenCalled();
  await expect(readPaymentMethodExpiryWarningDaysPolicy({ query })).rejects.toThrow(code);
  await expect(readPaymentMethodExpiryWarningDaysOverride({ query })).rejects.toThrow(code);
});

it.each([Infinity, NaN])("refuses non-JSON numbers before writes: %s", async warningDays => {
  const query = vi.fn();
  await expect(installPaymentMethodExpiryWarningDaysPolicy({ query }, { revision: "x", warningDays }))
    .rejects.toThrow("payment_method_expiry_warning_days_policy_invalid");
  expect(query).not.toHaveBeenCalled();
});

it.each([null, "{bad-json", "undefined"])("names malformed persisted JSON: %j", async value_text => {
  const query = vi.fn().mockResolvedValue({ rows: [{ value_text }] });
  await expect(readPaymentMethodExpiryWarningDaysPolicy({ query })).rejects.toThrow("payment_method_expiry_warning_days_policy_invalid");
  expect(query.mock.calls[0]?.[0]).toMatch(/^SELECT /);
});
