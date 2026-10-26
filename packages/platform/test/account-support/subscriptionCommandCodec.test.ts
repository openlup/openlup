import { expect, it } from "vitest";
import { createNativeSubscriptionDriver, decodeNativeSubscriptionPreview, encodeNativeSubscriptionCommand, type NativeSubscriptionCommand } from "../../src/account-support/index.js";

const preview = { status: "previewed", canApply: true, templateVersion: 7, quoteHash: "a".repeat(64), quoteExpiresAt: "2026-10-25T12:15:00Z", currentTotalMinor: 100, newTotalMinor: 300,
    lines: [{ variantId: "variant", quantity: 3, isAddon: false, sortOrder: 0, unitPriceMinor: 100, currency: "XXX" }],
    priceAgreementPolicy: { kind: "lock_until_edit", proration: "none", cycleEffect: "future_unlocked_cycles_only" } };

it("C2 keeps quoted command identity, payload presence and separate preview/apply calls", async () => {
  const context = { principalId: "actor", clientId: "client", graph: "native" as const };
  const payload = { coreLines: [{ variantId: "variant", qty: 3 }], expectedTemplateVersion: 7, acceptedQuoteHash: "a".repeat(64), confirmedChargeTiming: false };
  const request = { subscriptionId: "UPPER-ID", idempotencyKey: "original-key", action: "update_bundle", payload };
  const applied = { status: "applied", commandFingerprint: "original", extra: true }, calls: NativeSubscriptionCommand[] = [];
  let projected = 0, previewed = 0;
  const driver = createNativeSubscriptionDriver<string, Record<string, unknown>, object>({
    now: () => "2026-10-25T12:00:00Z",
    owner: { async preview(command) { previewed++; calls.push(command); return preview; }, async apply(command) { calls.push(command); return applied; } },
    previewProjection(record) { projected++; expect(record).toBe(preview); return record; },
  });
  expect(encodeNativeSubscriptionCommand(context, request, "time")).toEqual({ actorId: "actor", clientId: "client", idempotencyKey: "original-key", subscriptionId: "UPPER-ID", action: "update_bundle", payload, now: "time" });
  expect((await driver.preview(context, request))).toEqual({ kind: "projected", preview });
  expect(calls[0]!.payload).toEqual({ coreLines: payload.coreLines, expectedTemplateVersion: 7, confirmedChargeTiming: false });
  expect(calls[0]!.payload).not.toBe(payload); expect(payload.acceptedQuoteHash).toBe("a".repeat(64));
  expect(await driver.apply(context, request)).toBe(applied); expect(calls[1]!.payload).toBe(payload);
  expect(previewed).toBe(1); expect(projected).toBe(1);
});
it.each([{ name: "null lines", change: { lines: null } }])("C2 refuses malformed preview: $name before projection", ({ change }) => {
  let projected = 0;
  expect(() => decodeNativeSubscriptionPreview({ ...preview, ...change }, () => { projected++; })).toThrow("subscription_command_preview_invalid");
  expect(projected).toBe(0);
});
it.each([
  { status: "refused", reason: "subscription_command_preview_unsupported" },
  { status: "applied", commandFingerprint: "original", extra: true },
])("C2 keeps $status owner record identity", result => {
  const decoded = decodeNativeSubscriptionPreview(result, () => { throw new Error("unreachable"); });
  expect(decoded).toEqual({ kind: "owner", result });
  expect(decoded.kind === "owner" && decoded.result).toBe(result);
});

it("C2 retains explicit empty addonLines on apply without preview", async () => {
  const payload = { addonLines: [] }, applied = { status: "applied" };
  let calls = 0;
  const driver = createNativeSubscriptionDriver({
    now: () => "time",
    owner: { async preview() { throw new Error("unexpected-preview"); }, async apply(command) { calls++; expect(command.payload).toBe(payload); expect(command.payload.addonLines).toBe(payload.addonLines); return applied; } },
    previewProjection() { throw new Error("unexpected-projection"); },
  });
  expect(await driver.apply({ principalId: "actor", clientId: "client", graph: "native" }, { subscriptionId: "s", idempotencyKey: "key", action: "update_bundle", payload })).toBe(applied);
  expect(calls).toBe(1);
});
