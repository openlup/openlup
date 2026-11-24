import { expect, it, vi } from "vitest";
import corpus from "./subscription_retry_schedule.json";
import {
  DEFAULT_SUBSCRIPTION_RETRY_BACKOFF_HOURS,
  installSubscriptionRetrySchedulePolicy,
  readSubscriptionRetryScheduleOverride,
  readSubscriptionRetrySchedulePolicy,
  validateSubscriptionRetrySchedule,
} from "../../src/subscriptions/retrySchedulePolicy.js";

it("defaults only for an absent row and installs exact validated JSON", async () => {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  expect(DEFAULT_SUBSCRIPTION_RETRY_BACKOFF_HOURS).toEqual([24, 72, 168]);
  expect(Object.isFrozen(DEFAULT_SUBSCRIPTION_RETRY_BACKOFF_HOURS)).toBe(true);
  expect(await readSubscriptionRetryScheduleOverride({ query })).toBeUndefined();
  expect(await readSubscriptionRetrySchedulePolicy({ query })).toEqual({
    revision: "default",
    backoffHours: [24, 72, 168],
  });
  for (const backoffHours of [
    [1, 1, 1],
    [12, 24, 48],
    [24, 72, 168],
    [2147483647, 2147483647, 2147483647],
  ] as [number, number, number][]) {
    const policy = { revision: "owned-1", backoffHours };
    await installSubscriptionRetrySchedulePolicy({ query }, policy);
    expect(query.mock.lastCall?.[1]).toEqual(["subscription_retry_schedule", JSON.stringify(policy)]);
    query.mockResolvedValueOnce({ rows: [{ value_text: JSON.stringify(policy) }] });
    expect(await readSubscriptionRetrySchedulePolicy({ query })).toEqual(policy);
  }
});

it.each(corpus)("shared corpus (TS): $name", async ({ input: rawJson, accepted, normalized, decodedNormalized, code }) => {
  const input: unknown = JSON.parse(rawJson);
  if (accepted || decodedNormalized) {
    expect(validateSubscriptionRetrySchedule(input)).toStrictEqual(decodedNormalized ?? normalized);
    return;
  }
  const query = vi.fn().mockResolvedValue({ rows: [{ value_text: rawJson }] });
  expect(() => validateSubscriptionRetrySchedule(input)).toThrow(code);
  await expect(installSubscriptionRetrySchedulePolicy({ query }, input as never)).rejects.toThrow(code);
  expect(query).not.toHaveBeenCalled();
  await expect(readSubscriptionRetrySchedulePolicy({ query })).rejects.toThrow(code);
  await expect(readSubscriptionRetryScheduleOverride({ query })).rejects.toThrow(code);
});

it.each([Infinity, NaN])("refuses non-JSON numbers before writes: %s", async bad => {
  const query = vi.fn();
  await expect(installSubscriptionRetrySchedulePolicy({ query }, { revision: "x", backoffHours: [bad, 72, 168] }))
    .rejects.toThrow("subscription_retry_schedule_policy_invalid");
  expect(query).not.toHaveBeenCalled();
});

it.each([null, "{bad-json", "undefined"])("names malformed persisted JSON: %j", async value_text => {
  const query = vi.fn().mockResolvedValue({ rows: [{ value_text }] });
  await expect(readSubscriptionRetrySchedulePolicy({ query })).rejects.toThrow("subscription_retry_schedule_policy_invalid");
  expect(query.mock.calls[0]?.[0]).toMatch(/^SELECT /);
});
