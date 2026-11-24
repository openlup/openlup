import { expect, it, vi } from "vitest";
import corpus from "./payment_decline_notice_timing.json";
import {
  DEFAULT_PAYMENT_DECLINE_LINK_LIFETIME_HOURS,
  DEFAULT_PAYMENT_DECLINE_NOTICE_DELAY_MINUTES,
  installPaymentDeclineNoticeTimingPolicy,
  readPaymentDeclineNoticeTimingOverride,
  readPaymentDeclineNoticeTimingPolicy,
  validatePaymentDeclineNoticeTiming,
} from "../../src/payments/declineNoticeTimingPolicy.js";

it("defaults only for an absent row and installs exact validated JSON", async () => {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  expect(DEFAULT_PAYMENT_DECLINE_NOTICE_DELAY_MINUTES).toBe(3);
  expect(DEFAULT_PAYMENT_DECLINE_LINK_LIFETIME_HOURS).toBe(24);
  expect(await readPaymentDeclineNoticeTimingOverride({ query })).toBeUndefined();
  expect(await readPaymentDeclineNoticeTimingPolicy({ query })).toEqual({
    revision: "default",
    delayMinutes: 3,
    linkLifetimeHours: 24,
  });
  for (const [delayMinutes, linkLifetimeHours] of [
    [0, 1],
    [3, 24],
    [15, 48],
    [1440, 168],
  ] as const) {
    const policy = { revision: "owned-1", delayMinutes, linkLifetimeHours };
    await installPaymentDeclineNoticeTimingPolicy({ query }, policy);
    expect(query.mock.lastCall?.[1]).toEqual(["payment_decline_notice_timing", JSON.stringify(policy)]);
    query.mockResolvedValueOnce({ rows: [{ value_text: JSON.stringify(policy) }] });
    expect(await readPaymentDeclineNoticeTimingPolicy({ query })).toEqual(policy);
  }
});

it.each(corpus)("shared corpus (TS): $name", async ({ input: rawJson, accepted, normalized, decodedNormalized, code }) => {
  const input: unknown = JSON.parse(rawJson);
  if (accepted || decodedNormalized) {
    expect(validatePaymentDeclineNoticeTiming(input)).toStrictEqual(decodedNormalized ?? normalized);
    return;
  }
  const query = vi.fn().mockResolvedValue({ rows: [{ value_text: rawJson }] });
  expect(() => validatePaymentDeclineNoticeTiming(input)).toThrow(code);
  await expect(installPaymentDeclineNoticeTimingPolicy({ query }, input as never)).rejects.toThrow(code);
  expect(query).not.toHaveBeenCalled();
  await expect(readPaymentDeclineNoticeTimingPolicy({ query })).rejects.toThrow(code);
  await expect(readPaymentDeclineNoticeTimingOverride({ query })).rejects.toThrow(code);
});

it.each([Infinity, NaN])("refuses non-JSON numbers before writes: %s", async bad => {
  const query = vi.fn();
  await expect(installPaymentDeclineNoticeTimingPolicy({ query }, { revision: "x", delayMinutes: bad, linkLifetimeHours: 24 }))
    .rejects.toThrow("payment_decline_notice_timing_policy_invalid");
  await expect(installPaymentDeclineNoticeTimingPolicy({ query }, { revision: "x", delayMinutes: 3, linkLifetimeHours: bad }))
    .rejects.toThrow("payment_decline_notice_timing_policy_invalid");
  expect(query).not.toHaveBeenCalled();
});

it.each([null, "{bad-json", "undefined"])("names malformed persisted JSON: %j", async value_text => {
  const query = vi.fn().mockResolvedValue({ rows: [{ value_text }] });
  await expect(readPaymentDeclineNoticeTimingPolicy({ query })).rejects.toThrow("payment_decline_notice_timing_policy_invalid");
  expect(query.mock.calls[0]?.[0]).toMatch(/^SELECT /);
});
