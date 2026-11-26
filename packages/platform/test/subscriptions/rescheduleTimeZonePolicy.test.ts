import { expect, it, vi } from "vitest";
import corpus from "./subscription_reschedule_timezone.json";
import {
  DEFAULT_SUBSCRIPTION_RESCHEDULE_TIMEZONE,
  installSubscriptionRescheduleTimeZonePolicy,
  readSubscriptionRescheduleTimeZoneOverride,
  readSubscriptionRescheduleTimeZonePolicy,
  validateSubscriptionRescheduleTimeZone,
} from "../../src/subscriptions/rescheduleTimeZonePolicy.js";

it("defaults only for an absent row and installs exact validated JSON", async () => {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  expect(DEFAULT_SUBSCRIPTION_RESCHEDULE_TIMEZONE).toBe("UTC");
  expect(await readSubscriptionRescheduleTimeZoneOverride({ query })).toBeUndefined();
  expect(await readSubscriptionRescheduleTimeZonePolicy({ query })).toEqual({
    revision: "default",
    timeZone: "UTC",
  });
  for (const timeZone of ["UTC", "Europe/Berlin", "America/New_York", "Asia/Tokyo"]) {
    const policy = { revision: "owned-1", timeZone };
    await installSubscriptionRescheduleTimeZonePolicy({ query }, policy);
    expect(query.mock.lastCall?.[1]).toEqual(["subscription_reschedule_timezone", JSON.stringify(policy)]);
    query.mockResolvedValueOnce({ rows: [{ value_text: JSON.stringify(policy) }] });
    expect(await readSubscriptionRescheduleTimeZonePolicy({ query })).toEqual(policy);
  }
});

it.each(corpus)("shared corpus (TS): $name", async ({ input: rawJson, accepted, normalized, code }) => {
  const input: unknown = JSON.parse(rawJson);
  if (accepted) {
    expect(validateSubscriptionRescheduleTimeZone(input)).toStrictEqual(normalized);
    return;
  }
  const query = vi.fn().mockResolvedValue({ rows: [{ value_text: rawJson }] });
  expect(() => validateSubscriptionRescheduleTimeZone(input)).toThrow(code);
  await expect(installSubscriptionRescheduleTimeZonePolicy({ query }, input as never)).rejects.toThrow(code);
  expect(query).not.toHaveBeenCalled();
  await expect(readSubscriptionRescheduleTimeZonePolicy({ query })).rejects.toThrow(code);
  await expect(readSubscriptionRescheduleTimeZoneOverride({ query })).rejects.toThrow(code);
});

it.each([null, "{bad-json", "undefined"])("names malformed persisted JSON: %j", async value_text => {
  const query = vi.fn().mockResolvedValue({ rows: [{ value_text }] });
  await expect(readSubscriptionRescheduleTimeZonePolicy({ query }))
    .rejects.toThrow("subscription_reschedule_timezone_policy_invalid");
  expect(query.mock.calls[0]?.[0]).toMatch(/^SELECT /);
});
