import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readPackagedPlatformCatalog } from "../../src/migrations/packagedCatalog.js";
import { createPostgresLifecycleMessages, type NativeLifecycleMessagesOptions } from "../../src/subscriptions/postgresLifecycleMessages.js";

const inert: NativeLifecycleMessagesOptions = {
  async withSession() { throw new Error("validation must precede SQL"); },
  bind: async () => { throw new Error("unexpected bind"); },
  delivery: { readReceipt: async () => null, send: async () => ({ state: "accepted", deliveryReference: "captured:synthetic" }) },
};
describe("notice policy validation", () => {
  for (const [group, keys] of Object.entries({ dispatch: ["leaseSeconds", "maxAttempts", "transientBackoffSeconds"], recovered: ["windowSeconds"] })) {
    for (const key of keys) {
      it.each([null, true, "2", 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(`refuses ${group}.${key}=%s before SQL`, value => {
        expect(() => createPostgresLifecycleMessages({ ...inert, [group]: { [key]: value } })).toThrow("subscription_notice_options_invalid");
      });
    }
    it.each([null, [], 2, "policy", { unknown: 1 }])(`refuses malformed ${group} policy %s`, value => {
      expect(() => createPostgresLifecycleMessages({ ...inert, [group]: value })).toThrow("subscription_notice_options_invalid");
    });
  }
  it("accepts absent policy and explicit nondefault positive integer values", () => {
    expect(() => createPostgresLifecycleMessages(inert)).not.toThrow();
    expect(() => createPostgresLifecycleMessages({ ...inert, dispatch: { leaseSeconds: 7, maxAttempts: 4, transientBackoffSeconds: 2 }, recovered: { windowSeconds: 3600 } })).not.toThrow();
  });
  it("refuses inverted notice windows before acquiring a session", () => {
    expect(() => createPostgresLifecycleMessages({ ...inert, notices: { renewalMinSeconds: 30, renewalMaxSeconds: 20 } })).toThrow("subscription_notice_options_invalid");
    expect(() => createPostgresLifecycleMessages({ ...inert, notices: { atRiskMinDays: 5, atRiskMaxDays: 2 } })).toThrow("subscription_notice_options_invalid");
  });
  it("accepts configured notice values without changing the receipt or source contract", () => {
    expect(() => createPostgresLifecycleMessages({ ...inert, notices: { renewalMinSeconds: 12, renewalMaxSeconds: 60,
      ordinaryFreshnessSeconds: 9, starterFreshnessSeconds: 2, pauseWindowSeconds: 7, atRiskMinDays: 1, atRiskMaxDays: 3,
      atRiskMaxDaysPerCause: 2, operatorLeaseSeconds: 8, operatorMaxAttempts: 4, operatorHorizonSeconds: 100,
      operatorTransientBackoffSeconds: 11 } })).not.toThrow();
  });
});

it("loads every migration including notice production through the default packaged catalogue", () => {
  const canonical = JSON.parse(readFileSync(new URL("../../../../config/platform-migration-manifest.json", import.meta.url), "utf8"));
  const expected = new Map([canonical, canonical.qualified, canonical.qualifiedAdmin]
    .flatMap(plan => [plan.baseline, ...plan.forward]).map(({ file, sha256 }) => [file, sha256]));
  const packaged = readPackagedPlatformCatalog();
  expect(packaged.errors).toEqual([]);
  expect(packaged.manifest).toEqual(canonical);
  const loaded = new Map(packaged.migrations.map(({ file, content }) => [file, createHash("sha256").update(content).digest("hex")]));
  expect(loaded).toEqual(expected);
  expect(loaded.has("db/platform/migrations/20261106120000_subscription_notice_producers.sql")).toBe(true);
});
