import { readAttemptDeclineObservation } from "./tpayDeclineEvidence.js";
import { describe, expect, it } from "vitest";
import { declineCodeReading } from "./declineFailureHints.js";
import { normalizeTpayFailureEvidence, tpayFailureEvidence } from "./tpayFailureEvidence.js";
import { normalizeStripeFailureEvidence, stripeFailureEvidence } from "../stripe/stripeFailureEvidence.js";

describe("Tpay diagnostic normalization", () => {
  it.each(["63", "100", "102", "103", "104", "105", "106", "107", "999"])("does not invent numeric-code semantics: %s", (code) => {
    const evidence = tpayFailureEvidence({ source: "readback", providerPaymentId: "01HX", refusalVerified: true,
      flow: null, observation: { code, disposition: "present" }, reading: declineCodeReading(code) });
    expect(normalizeTpayFailureEvidence(evidence)).toEqual({ refusalVerified: true, cause: "generic_decline",
      certainty: "unknown", disclosure: "safe", method: null, operation: null, advice: null });
    expect(evidence.declineCode).toBe(code);
  });

  it("describes a refused registration by its operation, never as a setup cause", () => {
    // A mistyped or expired code is refused inside the same registration. Only
    // the persisted mandate decision may say the agreement itself was refused.
    const evidence = tpayFailureEvidence({ source: "execution", providerPaymentId: "01HX", refusalVerified: true,
      flow: "blik_recurring_activation", observation: { code: "105", disposition: "present" } });
    expect(normalizeTpayFailureEvidence(evidence)).toMatchObject({ cause: "generic_decline", certainty: "unknown",
      operation: "recurring_setup", method: { kind: "blik", recoveryMethodKey: "blik" } });
  });

  it("never promotes adapter-inferred advice into issuer instructions", () => {
    const evidence = tpayFailureEvidence({ source: "execution", providerPaymentId: "01HX", refusalVerified: true,
      flow: "blik_one_time", observation: { code: "101", disposition: "present" }, reading: declineCodeReading("101") });
    expect(evidence).toMatchObject({ adviceCode: "do_not_try_again", adviceOrigin: "inferred" });
    expect(normalizeTpayFailureEvidence(evidence).advice).toBeNull();
  });

  it("normalizes BLIK independently of the rail and preserves stored-method interaction", () => {
    const tpay = tpayFailureEvidence({ source: "execution", providerPaymentId: "01HX", refusalVerified: true,
      flow: "blik_one_time", observation: { code: "100", disposition: "present" } });
    const stripe = stripeFailureEvidence({ id: "pi_blik", status: "requires_payment_method", latest_charge: "ch_blik",
      last_payment_error: { code: "payment_failed", payment_method: { type: "blik" } } }, { source: "readback" })!;
    expect(normalizeTpayFailureEvidence(tpay).method).toEqual(normalizeStripeFailureEvidence(stripe).method);
    const stored = tpayFailureEvidence({ source: "execution", providerPaymentId: "01HX", refusalVerified: true,
      flow: "blik_recurring_saved", observation: { code: "100", disposition: "present" } });
    expect(stored.method).toEqual({ kind: "blik", recoveryMethodKey: "blik_one_click", interaction: "stored_instrument" });
    expect(stored.operation).toBe("stored_method_payment");
  });

  it("cannot turn a failed diagnostic read into a refused payment", () => {
    const evidence = tpayFailureEvidence({ source: "readback", providerPaymentId: "01HX", refusalVerified: false,
      flow: "blik_recurring_activation", observation: { code: null, disposition: "read_failed" } });
    expect(normalizeTpayFailureEvidence(evidence)).toMatchObject({ refusalVerified: false, cause: "generic_decline", certainty: "unknown" });
  });
});


it("never stores another transaction's readback code or inferred advice", async () => {
  const observation = await readAttemptDeclineObservation({ getTransaction: async () => ({
    transactionId: "tx_other", title: "TR-readback-other", status: "failed",
    transactionPaymentUrl: null, amount: 149, currency: null, requestId: "readback-other",
    payments: { attempts: [{ paymentErrorCode: "101" }] },
  }) }, "tx_expected");
  const evidence = tpayFailureEvidence({ source: "execution", providerPaymentId: "tx_expected",
    refusalVerified: true, flow: "blik_one_time", observation, reading: declineCodeReading(observation.code!) });
  expect(evidence).toMatchObject({ providerPaymentId: "tx_expected", refusalVerified: true,
    disposition: "unreadable", declineCode: null, adviceCode: null, adviceOrigin: "unknown" });
  expect(normalizeTpayFailureEvidence(evidence)).toMatchObject({ cause: "generic_decline", certainty: "unknown", advice: null });
});


it("gives a refused BLIK registration the same neutral cause across adapters without enabling a method", () => {
  const tpay = tpayFailureEvidence({ source: "execution", providerPaymentId: "tx_setup", refusalVerified: true,
    flow: "blik_recurring_activation", observation: { code: null, disposition: "absent" } });
  const stripe = stripeFailureEvidence({ id: "pi_setup", status: "requires_payment_method", setup_future_usage: "off_session",
    latest_charge: "ch_setup", last_payment_error: { code: "payment_failed", payment_method: { type: "blik" } },
  }, { source: "readback" })!;
  expect(normalizeStripeFailureEvidence(stripe)).toEqual(normalizeTpayFailureEvidence(tpay));
  expect(normalizeStripeFailureEvidence(stripe)).toMatchObject({ cause: "generic_decline", certainty: "unknown",
    operation: "recurring_setup" });
});
