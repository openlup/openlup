import { expect, it, vi } from "vitest";
import corpus from "./shipping_payment_method_preferences.json";
import {
  DEFAULT_SHIPPING_PAYMENT_METHOD_PREFERENCES,
  installShippingPaymentMethodPreferencesPolicy,
  readShippingPaymentMethodPreferencesOverride,
  readShippingPaymentMethodPreferencesPolicy,
  validateShippingPaymentMethodPreferences,
} from "../../src/shipping/paymentMethodPreferencesPolicy.js";

it("defaults only for an absent row and installs validated JSON through SQL validator", async () => {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  expect(DEFAULT_SHIPPING_PAYMENT_METHOD_PREFERENCES).toEqual(["instant", "card", "transfer"]);
  expect(await readShippingPaymentMethodPreferencesOverride({ query })).toBeUndefined();
  expect(await readShippingPaymentMethodPreferencesPolicy({ query })).toEqual({
    revision: "default",
    methodKinds: [...DEFAULT_SHIPPING_PAYMENT_METHOD_PREFERENCES],
  });
  const policy = { revision: "store-1", methodKinds: ["instant", "card", "wallet_express"] };
  await installShippingPaymentMethodPreferencesPolicy({ query }, policy);
  expect(query.mock.lastCall?.[0]).toContain("public.shipping_payment_method_preferences_validate($2::jsonb)::text");
  expect(query.mock.lastCall?.[1]).toEqual(["shipping_payment_method_preferences", JSON.stringify(policy)]);
  query.mockResolvedValueOnce({ rows: [{ value_text: JSON.stringify(policy) }] });
  expect(await readShippingPaymentMethodPreferencesPolicy({ query })).toEqual(policy);
});

it("enforces the 32-item upper bound", () => {
  const maxMethods = Array.from({ length: 32 }, (_, i) => `m_${i}`);
  expect(validateShippingPaymentMethodPreferences({ revision: "m32", methodKinds: maxMethods }).methodKinds).toHaveLength(32);
  const tooMany = Array.from({ length: 33 }, (_, i) => `m_${i}`);
  expect(() => validateShippingPaymentMethodPreferences({ revision: "m33", methodKinds: tooMany }))
    .toThrow("shipping_payment_method_preferences_policy_invalid");
});

it.each(corpus)("shared corpus (TS): $name", async ({ input: rawJson, accepted, normalized, code }) => {
  const input: unknown = JSON.parse(rawJson);
  if (accepted) {
    expect(validateShippingPaymentMethodPreferences(input)).toStrictEqual(normalized);
    return;
  }
  const query = vi.fn().mockResolvedValue({ rows: [{ value_text: rawJson }] });
  expect(() => validateShippingPaymentMethodPreferences(input)).toThrow(code);
  await expect(installShippingPaymentMethodPreferencesPolicy({ query }, input as never)).rejects.toThrow(code);
  expect(query).not.toHaveBeenCalled();
  await expect(readShippingPaymentMethodPreferencesPolicy({ query })).rejects.toThrow(code);
  await expect(readShippingPaymentMethodPreferencesOverride({ query })).rejects.toThrow(code);
});

it.each([null, "{bad-json", "undefined"])("names malformed persisted JSON: %j", async value_text => {
  const query = vi.fn().mockResolvedValue({ rows: [{ value_text }] });
  await expect(readShippingPaymentMethodPreferencesPolicy({ query }))
    .rejects.toThrow("shipping_payment_method_preferences_policy_invalid");
  expect(query.mock.calls[0]?.[0]).toMatch(/^SELECT /);
});
