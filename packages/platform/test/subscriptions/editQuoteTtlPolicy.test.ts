import { expect, it, vi } from "vitest";
import corpus from "./subscription_edit_quote_ttl_minutes.json";
import {
  DEFAULT_SUBSCRIPTION_EDIT_QUOTE_TTL_MINUTES,
  installSubscriptionEditQuoteTtlMinutesPolicy,
  readSubscriptionEditQuoteTtlMinutesOverride,
  readSubscriptionEditQuoteTtlMinutesPolicy,
  resolveSubscriptionEditQuoteTtlMinutes,
  validateSubscriptionEditQuoteTtlMinutes,
} from "../../src/subscriptions/editQuoteTtlPolicy.js";

it("defaults only for an absent row and installs exact validated JSON", async () => {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  expect(DEFAULT_SUBSCRIPTION_EDIT_QUOTE_TTL_MINUTES).toBe(15);
  expect(resolveSubscriptionEditQuoteTtlMinutes()).toBe(15);
  expect(resolveSubscriptionEditQuoteTtlMinutes(undefined)).toBe(15);
  expect(resolveSubscriptionEditQuoteTtlMinutes(1)).toBe(1);
  expect(resolveSubscriptionEditQuoteTtlMinutes(1440)).toBe(1440);
  expect(await readSubscriptionEditQuoteTtlMinutesOverride({ query })).toBeUndefined();
  expect(await readSubscriptionEditQuoteTtlMinutesPolicy({ query })).toEqual({
    revision: "default",
    ttlMinutes: 15,
  });
  for (const ttlMinutes of [1, 15, 45, 1440]) {
    const policy = { revision: "owned-1", ttlMinutes };
    await installSubscriptionEditQuoteTtlMinutesPolicy({ query }, policy);
    expect(query.mock.lastCall?.[1]).toEqual(["subscription_edit_quote_ttl_minutes", JSON.stringify(policy)]);
    query.mockResolvedValueOnce({ rows: [{ value_text: JSON.stringify(policy) }] });
    expect(await readSubscriptionEditQuoteTtlMinutesPolicy({ query })).toEqual(policy);
  }
});

it.each(corpus)("shared corpus (TS): $name", async ({ input: rawJson, accepted, normalized, decodedNormalized, code }) => {
  const input: unknown = JSON.parse(rawJson);
  if (accepted || decodedNormalized) {
    expect(validateSubscriptionEditQuoteTtlMinutes(input)).toStrictEqual(decodedNormalized ?? normalized);
    return;
  }
  const query = vi.fn().mockResolvedValue({ rows: [{ value_text: rawJson }] });
  expect(() => validateSubscriptionEditQuoteTtlMinutes(input)).toThrow(code);
  await expect(installSubscriptionEditQuoteTtlMinutesPolicy({ query }, input as never)).rejects.toThrow(code);
  expect(query).not.toHaveBeenCalled();
  await expect(readSubscriptionEditQuoteTtlMinutesPolicy({ query })).rejects.toThrow(code);
  await expect(readSubscriptionEditQuoteTtlMinutesOverride({ query })).rejects.toThrow(code);
});

it.each([0, -1, 1.5, 1441, Infinity, NaN])("rejects invalid quoteTtlMinutes option: %s", bad => {
  expect(() => resolveSubscriptionEditQuoteTtlMinutes(bad)).toThrow("subscription_edit_quote_ttl_minutes_policy_invalid");
});

it.each([Infinity, NaN])("refuses non-JSON numbers before writes: %s", async bad => {
  const query = vi.fn();
  await expect(installSubscriptionEditQuoteTtlMinutesPolicy({ query }, { revision: "x", ttlMinutes: bad }))
    .rejects.toThrow("subscription_edit_quote_ttl_minutes_policy_invalid");
  expect(query).not.toHaveBeenCalled();
});

it.each([null, "{bad-json", "undefined"])("names malformed persisted JSON: %j", async value_text => {
  const query = vi.fn().mockResolvedValue({ rows: [{ value_text }] });
  await expect(readSubscriptionEditQuoteTtlMinutesPolicy({ query }))
    .rejects.toThrow("subscription_edit_quote_ttl_minutes_policy_invalid");
  expect(query.mock.calls[0]?.[0]).toMatch(/^SELECT /);
});
