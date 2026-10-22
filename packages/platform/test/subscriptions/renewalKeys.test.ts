import { expect, it } from "vitest";
import { renewalIdentity } from "../../src/subscriptions/index.js";
it("passes original schedule bytes to the existing host key dialect", () => {
  const keys = (value: { subscriptionId: string; scheduledAt: string }) => ({
    cycleIdempotencyKey: `subscription:${value.subscriptionId}:cycle:${value.scheduledAt}`,
    executionIdempotencyKey: "original:execution:01", externalIdempotencyKey: "original:external:01",
    requestFingerprint: "original-fingerprint",
  });
  const first = { subscriptionId: "s", scheduledAt: "2026-10-21T12:00:00Z", scheduledInstant: 1792584000000 };
  const second = { ...first, scheduledAt: "2026-10-21T14:00:00+02:00" };
  expect(Date.parse(first.scheduledAt)).toBe(Date.parse(second.scheduledAt));
  expect(renewalIdentity(first, keys)).toEqual({ cycleIdempotencyKey: "subscription:s:cycle:2026-10-21T12:00:00Z",
    executionIdempotencyKey: "original:execution:01", externalIdempotencyKey: "original:external:01", requestFingerprint: "original-fingerprint" });
  expect(renewalIdentity(second, keys).cycleIdempotencyKey).toBe("subscription:s:cycle:2026-10-21T14:00:00+02:00");
});
