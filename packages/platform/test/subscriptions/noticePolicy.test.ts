import { describe, expect, it } from "vitest";
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
});
