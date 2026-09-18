import { describe, expect, it } from "vitest";
import { DEFAULT_DUNNING_CADENCE } from "./dunningCadenceConfig.js";
import {
  createDunningConsentGate,
  dunningRefusalSkipReason,
  evaluateDunningCadence,
  type DunningConsentGate,
} from "./dunningConsentGate.js";

const signal = new AbortController().signal;
const request = {
  recipientEmail: "k@example.com",
  notificationKind: "payment_failed",
  templateSlug: "subscription-payment-failed-1",
  signal,
};

describe("dunning refusal skip reasons", () => {
  it("keeps the word the control-disabled skip has always written", () => {
    // Renaming it would re-baseline every historical skip row an operator reads.
    expect(dunningRefusalSkipReason("control_disabled")).toBe("admin_disabled");
    expect(dunningRefusalSkipReason("consent_denied")).toBe("consent_denied");
    expect(dunningRefusalSkipReason("cadence_not_allowed")).toBe("cadence_not_allowed");
  });
});

describe("cadence leg", () => {
  it("admits every notice kind the shipped cadence sends today", () => {
    for (const kind of ["payment_failed", "payment_expired"]) {
      expect(evaluateDunningCadence(DEFAULT_DUNNING_CADENCE, kind)).toEqual({ verdict: "allow" });
    }
  });

  it("refuses a kind the deployment never listed", () => {
    expect(evaluateDunningCadence(DEFAULT_DUNNING_CADENCE, "payment_nagged")).toEqual({
      verdict: "refuse",
      refusalCode: "cadence_not_allowed",
    });
  });
});

describe("composed gate", () => {
  it("sends when the deployment has no recipient consent state at all", async () => {
    // A deployment with no consent ledger is one where every transactional
    // notice sends. Withholding repair mail there would be a bug, not caution.
    const gate = createDunningConsentGate({ cadence: DEFAULT_DUNNING_CADENCE });
    expect(await gate.evaluate(request)).toEqual({ verdict: "allow" });
  });

  it("refuses the cadence before it ever asks about the recipient", async () => {
    let asked = 0;
    const recipientConsent: DunningConsentGate = {
      evaluate: async () => { asked += 1; return { verdict: "allow" }; },
    };
    const gate = createDunningConsentGate({ cadence: DEFAULT_DUNNING_CADENCE, recipientConsent });
    expect(await gate.evaluate({ ...request, notificationKind: "payment_nagged" })).toEqual({
      verdict: "refuse",
      refusalCode: "cadence_not_allowed",
    });
    expect(asked).toBe(0);
  });

  it("passes the recipient leg's refusal through unchanged", async () => {
    const recipientConsent: DunningConsentGate = {
      evaluate: async () => ({ verdict: "refuse", refusalCode: "consent_denied" }),
    };
    const gate = createDunningConsentGate({ cadence: DEFAULT_DUNNING_CADENCE, recipientConsent });
    expect(await gate.evaluate(request)).toEqual({ verdict: "refuse", refusalCode: "consent_denied" });
  });

  it("sends when the recipient leg throws, because silence would cost the recovery", async () => {
    const recipientConsent: DunningConsentGate = {
      evaluate: async () => { throw new Error("permission read down"); },
    };
    const gate = createDunningConsentGate({ cadence: DEFAULT_DUNNING_CADENCE, recipientConsent });
    expect(await gate.evaluate(request)).toEqual({ verdict: "allow" });
  });

  it("hands the recipient leg the whole request", async () => {
    const seen: unknown[] = [];
    const recipientConsent: DunningConsentGate = {
      evaluate: async (input) => { seen.push(input); return { verdict: "allow" }; },
    };
    await createDunningConsentGate({ cadence: DEFAULT_DUNNING_CADENCE, recipientConsent }).evaluate(request);
    expect(seen).toEqual([request]);
  });
});
