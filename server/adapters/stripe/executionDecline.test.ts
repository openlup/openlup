import { describe, expect, it } from "vitest";
import {
  declineFromError,
  declinedExecutionFacts,
  PROVIDER_DECLINE_ERROR_TYPE,
} from "./executionDecline.js";

describe("declineFromError", () => {
  it("reads the refusal codes the provider passed through", () => {
    const declined = declineFromError(Object.assign(new Error("Your card was declined."), {
      type: PROVIDER_DECLINE_ERROR_TYPE,
      code: "card_declined",
      decline_code: "insufficient_funds",
      advice_code: "try_again_later",
      payment_intent: { id: "pi_1", status: "requires_payment_method" },
    }));

    expect(declined?.diagnosticFailureEvidence).toMatchObject({
      source: "execution", refusalVerified: true, providerPaymentId: "pi_1",
      code: "card_declined", declineCode: "insufficient_funds", adviceCode: "try_again_later",
    });
    const { diagnosticFailureEvidence: _diagnostic, ...legacy } = declined!;
    expect(legacy).toEqual({
      decline: {
        code: "card_declined",
        mandateUnsupported: false,
        declineCode: "insufficient_funds",
        adviceCode: "try_again_later",
        // The adapter's own table read: the opaque decline code is translated
        // here so nothing downstream has to know this provider's vocabulary.
        neutralReasonHints: ["transient"],
      },
      providerAttemptId: "pi_1",
      providerStatus: "requires_payment_method",
    });
  });

  it("omits the optional codes rather than carrying empty ones", () => {
    const declined = declineFromError(Object.assign(new Error("declined"), {
      type: PROVIDER_DECLINE_ERROR_TYPE,
      code: "card_declined",
      decline_code: "",
    }));

    // An empty code is not a code: persisting one would put a value in the
    // attempt payload that no classification could ever read.
    expect(declined?.decline).toEqual({ code: "card_declined", mandateUnsupported: false });
  });

  it("names a stable code when the refusal carries none", () => {
    const declined = declineFromError(Object.assign(new Error("declined"), {
      type: PROVIDER_DECLINE_ERROR_TYPE,
    }));

    expect(declined?.decline.code).toBe("provider_declined");
    expect(declined?.providerAttemptId).toBeNull();
    expect(declined?.providerStatus).toBeNull();
  });

  it.each([
    ["a coded transport failure", Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })],
    ["another provider error class", Object.assign(new Error("rate limited"), { type: "RateLimit", code: "lock_timeout" })],
    ["a bare error", new Error("boom")],
    ["a thrown string", "card_declined"],
    ["null", null],
  ])("refuses to read a decline out of %s", (_label, error) => {
    // Everything here must keep throwing at the call site: after an ambiguous
    // failure the charge may still have been accepted, and only the fail-closed
    // path avoids a terminal `failed` on a possibly-paid attempt.
    expect(declineFromError(error)).toBeNull();
  });
});

describe("declinedExecutionFacts", () => {
  it("keeps the attempt non-terminal and lists the codes only once", () => {
    const facts = declinedExecutionFacts({
      decline: { code: "card_declined", mandateUnsupported: false, declineCode: "lost_card" },
      providerAttemptId: "pi_2",
      providerStatus: "requires_payment_method",
    });

    expect(facts.attemptStatus).toBe("processing");
    expect(facts.clientSecret).toBeNull();
    expect(facts.nextActionKind).toBeNull();
    expect(facts.recoveryRequired).toBe(false);
    expect(facts.responsePayload.providerErrorCodes).toEqual(["card_declined", "lost_card"]);
  });

  // NAMED PIN — do not "fix" this by restoring the correlation handle.
  // Event ingest matches a callback to an attempt by `provider_attempt_id`
  // (migration 20260612100000), and the control plane's failed branch has no
  // already-failed guard (20260711150000): it only short-circuits on succeeded /
  // refunded / disputed. So publishing the refused intent id here would let the
  // provider's failure callback apply the SAME refusal a second time under its
  // own idempotency key — retry_attempt 1 -> 2, next_retry_at 24h -> 72h, the
  // failure reason overwritten, a second dunning email to the customer minutes
  // after the first, and a 4-rung ladder that terminalizes after 2 real charges.
  // This exit stays uncorrelated until that branch is idempotent (PR-0c); the
  // id remains in responsePayload, which nothing joins on.
  it("publishes NO correlation handle, so the failure callback cannot re-apply the decline", () => {
    const facts = declinedExecutionFacts({
      decline: { code: "card_declined", mandateUnsupported: false },
      providerAttemptId: "pi_3",
      providerStatus: "requires_payment_method",
    });

    expect(facts.providerAttemptId).toBeNull();
    expect(facts.providerSessionId).toBeNull();
    expect(facts.webhookExpected).toBe(false);
    // Forensics survive: an operator can still find the refused intent.
    expect(facts.responsePayload).toMatchObject({
      providerAttemptId: "pi_3",
      providerStatus: "requires_payment_method",
      providerDeclined: true,
    });
  });
});
