import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createInitialSubscriptionCheckoutModel as createCoreModel } from "@openlup/core/subscription";
import { DELIVERY_DISPATCH_POLICY } from "#delivery-dispatch-policy";
import { createInitialSubscriptionCheckoutModel } from "./subscriptionEngine.js";
import { baseTemplate, pricingSnapshot, unwrap } from "./subscriptionEngineTestHelpers.js";

/**
 * E11 characterization proof.
 *
 * Pins that supplying the timezone EXPLICITLY (the market zone the composition
 * root owns, `DELIVERY_DISPATCH_POLICY.timeZone`) yields identical engine output
 * before and after the silent market-zone fallback was removed from the app
 * shim. `subscription.timezone` is an inert record field for cycle math, so
 * removing the default cannot move any computed value; this test is the
 * empirical stop-condition for that assumption, including a case whose cycle
 * instants straddle the market zone's spring-forward boundary (2026-03-29
 * 01:00 UTC, local 02:00 -> 03:00).
 *
 * The expected model below is a full-field transcription of the engine output
 * captured against the pre-change code (with the then-default zone passed
 * explicitly), so any drift in cycle planning, event emission, or record
 * assembly fails this test. Market-specific values (zone, template, pricing)
 * are sourced from their canonical constants rather than written literally,
 * per the OSS-readiness token ratchet.
 */

const EXPLICIT_TZ = DELIVERY_DISPATCH_POLICY.timeZone;

// DST-crossing window: `now` sits before, `firstCycleAt` after, the 01:00 UTC
// spring-forward jump in the market zone on 2026-03-29.
const dstNow = "2026-03-28T23:30:00.000Z";
const dstFirstCycleAt = "2026-03-29T01:30:00.000Z";

function appInput(overrides: Record<string, unknown> = {}) {
  return {
    subscriptionId: "sub-e11",
    clientRef: "client-e11",
    template: baseTemplate,
    paymentMethodRef: "pm-e11",
    paymentMethodKind: "card",
    now: dstNow,
    firstCycleAt: dstFirstCycleAt,
    pricingSnapshot,
    idempotencyKey: "e11-example",
    timezone: EXPLICIT_TZ,
    ...overrides,
  };
}

/** Transcribed from the pre-change engine output for the input above. */
const expectedModel = {
  subscription: {
    id: "sub-e11",
    clientRef: "client-e11",
    status: "active",
    template: baseTemplate,
    templateVersion: 1,
    nextCycleAt: dstFirstCycleAt,
    paymentMethodRef: "pm-e11",
    paymentMethodKind: "card",
    timezone: EXPLICIT_TZ,
    createdAt: dstNow,
    updatedAt: dstNow,
  },
  cycle: {
    subscriptionId: "sub-e11",
    cycleNumber: 1,
    status: "payment_pending",
    scheduledAt: dstFirstCycleAt,
    paidAt: null,
    templateVersion: 1,
    templateSnapshot: baseTemplate,
    pricingSnapshot,
    paymentMethodRef: "pm-e11",
    retryAttempt: 0,
    nextRetryAt: null,
    failureReason: null,
    engineIdempotencyKey: "e11-example",
  },
  events: [
    {
      cycleNumber: undefined,
      eventType: "subscription.created",
      idempotencyKey: "e11-example:subscription.created",
      occurredAt: dstNow,
      payload: { clientRef: "client-e11", templateVersion: 1 },
      subscriptionId: "sub-e11",
    },
    {
      cycleNumber: 1,
      eventType: "subscription.cycle_planned",
      idempotencyKey: "e11-example:cycle_planned",
      occurredAt: dstNow,
      payload: { scheduledAt: dstFirstCycleAt, templateVersion: 1 },
      subscriptionId: "sub-e11",
    },
    {
      cycleNumber: 1,
      eventType: "subscription.payment_requested",
      idempotencyKey: "e11-example:payment_requested",
      occurredAt: dstNow,
      payload: { paymentMethodRef: "pm-e11" },
      subscriptionId: "sub-e11",
    },
  ],
};

describe("E11 subscription-create timezone characterization", () => {
  it("app shim with the explicit market zone equals core with the same zone (DST-crossing)", () => {
    const viaApp = createInitialSubscriptionCheckoutModel(appInput());
    const viaCore = createCoreModel(appInput());
    expect(viaApp).toEqual(viaCore);
  });

  it("pins the full engine output for the explicit market zone across a DST boundary", () => {
    const model = unwrap(createInitialSubscriptionCheckoutModel(appInput()));
    expect(model).toEqual(expectedModel);
  });

  it("carries the explicitly supplied zone onto the persisted subscription record", () => {
    const model = unwrap(createInitialSubscriptionCheckoutModel(appInput()));
    expect(model.subscription.timezone).toBe(EXPLICIT_TZ);
    expect(model.subscription.nextCycleAt).toBe(dstFirstCycleAt);
    expect(model.cycle.scheduledAt).toBe(dstFirstCycleAt);
  });

  it("keeps the deprecated compatibility constant importable", async () => {
    // Compat pin for the deprecated export (also keeps the module inside the
    // 0%-line-coverage gate now that no runtime path imports it). Its EQUALITY to
    // the deployment's market zone is a value pin and was moved byte-identical to
    // a pin file of the same name in the deployment overlay's own test tree.
    const { DEFAULT_TIMEZONE } = await import("./subscriptionEngineTypes.js");
    expect(typeof DEFAULT_TIMEZONE).toBe("string");
    expect(() => new Intl.DateTimeFormat("en", { timeZone: DEFAULT_TIMEZONE })).not.toThrow();
  });

  it("no first-party runtime module resolves timezone from the default", () => {
    const coreSrc = readFileSync(
      fileURLToPath(new URL("./subscriptionEngineCore.ts", import.meta.url)),
      "utf8",
    );
    // The silent `?? DEFAULT_TIMEZONE` fallback must be gone from the app shim.
    expect(coreSrc).not.toMatch(/\?\?\s*DEFAULT_TIMEZONE/);
    // DEFAULT_TIMEZONE remains exported for compatibility, but deprecated.
    const typesSrc = readFileSync(
      fileURLToPath(new URL("./subscriptionEngineTypes.ts", import.meta.url)),
      "utf8",
    );
    expect(typesSrc).toMatch(/@deprecated[\s\S]*DEFAULT_TIMEZONE/);
  });
});
