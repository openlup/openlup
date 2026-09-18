import { describe, expect, it } from "vitest";
import { availablePaymentRecoveryActions, derivePaymentRecoveryGuidance,
  type PaymentRecoveryAttempt, type PaymentRecoveryEvidence } from "../src/payment/index.js";
const evidence = (key = "code"): PaymentRecoveryEvidence => ({ refusalVerified: true,
  cause: "generic_decline", certainty: "unknown", disclosure: "safe", advice: null,
  method: { kind: key, recoveryMethodKey: key, interaction: "new_instrument" }, operation: "one_time_payment" });
const attempt = (id: string, key = "code"): PaymentRecoveryAttempt => ({ id, status: "failed", evidence: evidence(key) });
const read = (attempts: PaymentRecoveryAttempt[], historyComplete = true) => derivePaymentRecoveryGuidance({
  paymentState: "failed", activeAttemptId: "current", attempts, historyComplete });

describe("checkout recovery policy", () => {
  it("counts local attempts only and saturates after two", () => {
    expect(read([attempt("current")])?.consecutiveRefusals).toBe(1);
    expect(read([attempt("current"), attempt("current")])?.consecutiveRefusals).toBe(1);
    expect(read([attempt("current"), attempt("older"), attempt("oldest")])?.consecutiveRefusals).toBe(2);
    expect(read([attempt("current"), attempt("older")])?.emphasis).toBe("recommended");
  });
  it("preserves grouping by choice, not provider, and breaks for different choice", () => {
    expect(read([attempt("current", "code"), attempt("older", "card")])?.consecutiveRefusals).toBe(1);
  });
  it("does not count or reset for local validation, cancellation, or polling", () => {
    const excluded = ["blocked_preflight", "cancelled", "created", "processing", "requires_action", "expired", "sent_to_provider"] as const;
    for (const status of excluded) expect(read([attempt("current"), { id: "excluded", status, evidence: null }, attempt("older")])?.consecutiveRefusals).toBe(2);
  });
  it("specific verified cause gives immediate guidance and breaks generic streak", () => {
    const specific = { ...attempt("older"), evidence: { ...evidence(), cause: "insufficient_funds", certainty: "verified" } as PaymentRecoveryEvidence };
    expect(read([attempt("current"), specific, attempt("oldest")])?.consecutiveRefusals).toBe(1);
    expect(read([{ ...specific, id: "current" }])?.cause).toBe("insufficient_funds");
    expect(read([{ ...specific, id: "current" }])?.consecutiveRefusals).toBe(0);
  });
  it("does not invent missing history but accepts a proven complete suffix", () => {
    expect(read([attempt("current")], false)?.consecutiveRefusals).toBeNull();
    expect(read([attempt("current"), attempt("older")], false)?.consecutiveRefusals).toBe(2);
    expect(read([attempt("current"), { ...attempt("gap"), evidence: null }, attempt("older")])?.consecutiveRefusals).toBeNull();
  });
  it("suppresses stale, unresolved, paid and unproven refusals", () => {
    expect(read([{ ...attempt("current"), evidence: null }])).toBeNull();
    expect(read([{ ...attempt("current"), evidence: { ...evidence(), refusalVerified: false } }])).toBeNull();
    expect(read([attempt("later"), attempt("current")])).toBeNull();
    expect(read([attempt("current"), { ...attempt("older"), status: "succeeded" }])).toBeNull();
    for (const paymentState of ["paid", "pending", "expired"] as const) expect(derivePaymentRecoveryGuidance({ paymentState, activeAttemptId: "current", attempts: [attempt("current")], historyComplete: true })).toBeNull();
  });
  it("does not expose a sensitive cause even if a mapper supplies one", () => {
    expect(read([{ ...attempt("current"), evidence: { ...evidence(), cause: "expired_card", certainty: "verified", disclosure: "restricted" } }])?.cause).toBe("generic_decline");
  });
  it("distinguishes changing one instrument from banning a whole method", () => {
    const restricted = (scope: "instrument" | "method") => read([{ ...attempt("current", "card"), evidence: { ...evidence("card"), advice: { code: "do_not_try_again", scope } } }])!;
    expect(restricted("instrument").actions).toContain("change_instrument");
    expect(restricted("method").actions).toEqual(["change_method"]);
  });
  it("suggests only compatible available candidates and never treats unknown as supported", () => {
    const guidance = read([attempt("current")])!;
    const candidate = { method: evidence("card").method!, operation: "one_time_payment" as const,
      capability: "supported" as const, available: true, actions: ["change_method" as const] };
    expect(availablePaymentRecoveryActions(guidance, [candidate], "one_time_payment")).toEqual(["change_method"]);
    expect(availablePaymentRecoveryActions(guidance, [candidate], "recurring_setup")).toEqual(["contact_support"]);
    expect(availablePaymentRecoveryActions(guidance, [{ ...candidate, capability: "unknown" }], "one_time_payment")).toEqual(["contact_support"]);
    expect(availablePaymentRecoveryActions(guidance, [{ ...candidate, available: false }], "one_time_payment")).toEqual(["contact_support"]);
  });
});
