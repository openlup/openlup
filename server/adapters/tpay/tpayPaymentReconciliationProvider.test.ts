import { describe, expect, it } from "vitest";
import {
  createTpayPaymentReconciliationProvider,
  normalizeTpayTransaction,
} from "./tpayPaymentReconciliationProvider.js";

// One composed reason per decline code; the counted-token families price each
// spelled rail prefix, so the tests compose it here exactly once. The normalizer
// is aliased for the same reason, and every block below calls it through `normalize`.
const declineReason = (code: string) => `tpay_decline_${code}`;
const normalize = normalizeTpayTransaction;

describe("normalizeTpayTransaction", () => {
  const attempt = { amountMinor: 14_900, currency: "PLN" } as never;
  it("maps Tpay correct/paid states to succeeded", () => {
    expect(normalizeTpayTransaction({
      transactionId: "tr_1",
      title: "TR-1",
      status: "correct",
      amount: "12.99",
      currency: "pln",
    })).toMatchObject({
      status: "succeeded",
      providerStatus: "correct",
      amountMinor: 1299,
      currency: "PLN",
      failureReason: null,
    });
  });

  it("uses official nested realization date and raw paidAmount from transaction readback", () => {
    expect(normalizeTpayTransaction({
      transactionId: "tr_1",
      status: "correct",
      amount: "12.99",
      paidAmount: "12.34",
      currency: "PLN",
      date: {
        creation: "2026-07-26T10:00:00.000Z",
        realization: "2026-07-26T10:01:00.000Z",
      },
      providerExtra: { retained: true },
    })).toMatchObject({
      amountMinor: 1234,
      occurredAt: "2026-07-26T10:01:00.000Z",
    });
  });

  it("maps Tpay failed boolean-like states to failed", () => {
    expect(normalizeTpayTransaction({
      tr_id: "TR-2",
      tr_status: "false",
      tr_amount: "20,50",
      tr_currency: "PLN",
    })).toMatchObject({
      status: "failed",
      providerStatus: "false",
      amountMinor: 2050,
      currency: "PLN",
      failureReason: "tpay_false",
    });
  });

  it("keeps unfamiliar provider states unknown without inventing a terminal result", () => {
    expect(normalizeTpayTransaction({
      transactionId: "tr_3",
      status: "bank_review",
    })).toMatchObject({
      status: "unknown",
      providerStatus: "bank_review",
      failureReason: null,
    });
  });

  it("uses transactionId rather than the merchant title and resumes only a trusted pending URL", async () => {
    const getTransaction = async () => ({
      transactionId: "transaction-id",
      title: "TR-merchant-title",
      status: "pending",
      transactionPaymentUrl: "https://secure.tpay.com/transaction/abc",
      amount: 149,
      currency: "PLN",
      requestId: "req-1",
      payments: {},
    });
    const provider = createTpayPaymentReconciliationProvider({ getTransaction });
    expect(provider.resolvePaymentReference?.({
      providerAttemptId: "TR-merchant-title",
      providerSessionId: "transaction-id",
      intentProviderPaymentId: null,
    })).toBe("transaction-id");
    expect(provider.resolvePaymentReference?.({
      providerAttemptId: "TR-merchant-title",
      providerSessionId: null,
      intentProviderPaymentId: "TR-merchant-title",
    })).toBeNull();
    await expect(provider.readRecoveryPayment({
      providerPaymentId: "transaction-id",
      attempt,
    })).resolves.toMatchObject({
      identityMatches: true,
      configuredMoneyMatches: true,
      clientAction: { kind: "redirect", url: "https://secure.tpay.com/transaction/abc" },
    });
  });

  it("matches pending recovery against configured amount when paidAmount is still zero", async () => {
    const provider = createTpayPaymentReconciliationProvider({
      getTransaction: async () => ({
        transactionId: "transaction-id",
        title: "TR-merchant-title",
        status: "pending",
        transactionPaymentUrl: "https://secure.tpay.com/transaction/abc",
        amount: 149,
        paidAmount: "0.00",
        currency: "PLN",
        requestId: "req-1",
        payments: { amountPaid: 0 },
      }),
    });

    await expect(provider.readRecoveryPayment({
      providerPaymentId: "transaction-id",
      attempt,
    })).resolves.toMatchObject({
      status: { status: "pending", amountMinor: 0 },
      configuredMoneyMatches: true,
      clientAction: { kind: "redirect", url: "https://secure.tpay.com/transaction/abc" },
    });
  });

  it.each([
    "http://secure.tpay.com/pay",
    "https://evil.example/pay",
    "https://secure.tpay.com:444/pay",
    "https://user:password@secure.tpay.com/pay",
  ])("does not construct or return an untrusted Tpay redirect URL: %s", async (transactionPaymentUrl) => {
    const provider = createTpayPaymentReconciliationProvider({
      getTransaction: async () => ({
        transactionId: "transaction-id",
        title: "TR-merchant-title",
        status: "pending",
        transactionPaymentUrl,
        amount: 149,
        currency: "PLN",
        requestId: "req-1",
        payments: {},
      }),
    });
    await expect(provider.readRecoveryPayment({
      providerPaymentId: "transaction-id",
      attempt,
    })).resolves.toMatchObject({
      status: { status: "pending" },
      clientAction: null,
    });
  });

  it("marks a provider object identity mismatch for the neutral manual-review lane", async () => {
    const provider = createTpayPaymentReconciliationProvider({
      getTransaction: async () => ({
        transactionId: "other",
        title: "TR-other",
        status: "correct",
        transactionPaymentUrl: null,
        amount: 1,
        currency: "PLN",
        requestId: "req-2",
        payments: {},
      }),
    });
    await expect(provider.readRecoveryPayment({
      providerPaymentId: "expected",
      attempt,
    })).resolves.toMatchObject({
      identityMatches: false,
      clientAction: null,
    });
  });

  it.each(["refunded", "chargeback"])(
    "marks Tpay money-moved status %s for manual review instead of retry",
    async (providerStatus) => {
      expect(normalizeTpayTransaction({
        transactionId: "transaction-id",
        status: providerStatus,
        amount: 149,
        currency: "PLN",
      })).toMatchObject({ status: "unknown", providerStatus });
      const provider = createTpayPaymentReconciliationProvider({
        getTransaction: async () => ({
          transactionId: "transaction-id",
          title: "TR-merchant-title",
          status: providerStatus,
          transactionPaymentUrl: null,
          amount: 149,
          currency: "PLN",
          requestId: "req-3",
          payments: {},
        }),
      });

      await expect(provider.readRecoveryPayment({
        providerPaymentId: "transaction-id",
        attempt,
      })).resolves.toMatchObject({
        identityMatches: true,
        manualReviewRequired: true,
        clientAction: null,
      });
    },
  );
});

/**
 * The backstop that survives the read becoming unconditional: a charge with no
 * attempt records is still running, and must never be turned terminal. The two
 * sibling pins that recorded the old silence were deleted with the flag that
 * produced it - see this wave's PR body.
 */
describe("in-flight charge (no attempt records)", () => {
  it("stays pending, so a running charge is never terminalized", () => {
    expect(normalizeTpayTransaction({
      transactionId: "tr_inflight",
      status: "pending",
      payments: { attempts: [] },
    })).toMatchObject({ status: "pending", failureReason: null });
  });
});

/**
 * Reading a refusal this rail reports per attempt. Unconditional: the switch
 * that used to gate it is gone, because its off state was the incident.
 */
describe("attempt refusal read", () => {
  const refused = Object.freeze({
    transactionId: "01KZTPM9SVY8C9C2R70FSA63AJ",
    title: "TR-7Y65-Z346CJX",
    status: "pending",
    date: { creation: "2026-08-12 12:00:02", realization: null },
    payments: { attempts: [{ date: "12.08.2026 12:00", paymentErrorCode: "103" }] },
  });

  it("turns a per-attempt refusal into a terminal failure with a stable reason", () => {
    expect(normalize({ ...refused })).toMatchObject({
      status: "failed",
      providerStatus: "pending",
      failureReason: declineReason("103"),
    });
  });

  // A live read may now say it is being made for a checkout the buyer is still
  // standing in, because on the card rail a never-confirmed intent looks exactly
  // like an abandoned one and must not be closed under them. This rail has no
  // such ambiguity - it never reports a non-terminal state as failed - so the
  // hint changes nothing here, and a refusal it CAN see stays terminal. That
  // matters: this rail emits no webhook for a decline, so the buyer-triggered
  // readback is the only thing that learns of one before the reconciliation cron.
  it("ignores a live-checkout read purpose and still reports the refusal", async () => {
    const provider = createTpayPaymentReconciliationProvider({
      getTransaction: async () => ({
        ...refused,
        transactionPaymentUrl: null,
        amount: null,
        currency: null,
        requestId: null,
      }),
    });

    await expect(provider.readPayment({
      providerPaymentId: refused.transactionId,
      purpose: "active_checkout",
    })).resolves.toMatchObject({ status: "failed", failureReason: declineReason("103") });
  });

  it("classifies through the shared seam and persists neutral evidence", () => {
    expect(normalize({ ...refused }).rawPayload).toMatchObject({
      declineCode: "103",
      neutralReasonHints: ["transient"],
      failureClass: "soft_retryable",
    });
  });

  // The abstention is one hint wide. Every other reading states something about
  // the CHARGE, which this rail observed in full, so narrowing them would throw
  // away evidence it actually holds. Pinned per code so a future widening of the
  // funnel cannot pass unnoticed.
  it.each([
    ["103", ["transient"], "soft_retryable", "neutral_hint"],
    ["104", ["transient"], "soft_retryable", "neutral_hint"],
    ["106", ["limitExceeded"], "soft_retry_delayed", "neutral_hint"],
    ["101", [], "hard_do_not_retry", "advice_code"],
    ["107", [], "hard_do_not_retry", "advice_code"],
  ])("states its whole reading of %s, which claims nothing about the bank", (
    code, hints, failureClass, decidedBy,
  ) => {
    expect(normalize({
      ...refused,
      payments: { attempts: [{ date: "12.08.2026 12:00", paymentErrorCode: code }] },
    }).rawPayload).toMatchObject({ declineCode: code, neutralReasonHints: hints, failureClass, failureClassDecidedBy: decidedBy });
  });

  // Same abstention on the carrier this rail prefers. The errors-array block
  // below pins it on the other one; a rule that held on only one carrier would
  // re-create the divergence one level down.
  it("abstains from the bank claim on the attempt carrier too", () => {
    expect(normalize({
      ...refused,
      payments: { attempts: [{ date: "12.08.2026 12:00", paymentErrorCode: "105" }] },
    }).rawPayload).toMatchObject({
      declineCode: "105",
      neutralReasonHints: [],
      failureClass: "indeterminate",
      failureClassDecidedBy: "default",
    });
  });

  it("dates the result from the attempt, not from transaction creation", () => {
    // 12:00 is the rail's local wall clock, so the instant is 10:00Z (CEST).
    expect(normalize({ ...refused }).occurredAt).toBe("2026-08-12T10:00:00.000Z");
  });

  it("prefers the most recent refusal when the payer retried", () => {
    expect(normalize({
      ...refused,
      payments: {
        attempts: [
          { date: "12.08.2026 12:00", paymentErrorCode: "103" },
          { date: "12.08.2026 12:30", paymentErrorCode: "101" },
        ],
      },
    })).toMatchObject({ failureReason: "tpay_decline_101" });
  });

  it("never contradicts a succeeded status field", () => {
    expect(normalize({ ...refused, status: "correct" }))
      .toMatchObject({ status: "succeeded", failureReason: null });
  });

  it("leaves a charge with no refusal code non-terminal", () => {
    expect(normalize({
      ...refused,
      payments: { attempts: [{ date: "12.08.2026 12:00" }] },
    })).toMatchObject({ status: "pending", failureReason: null });
  });


  // ---- audit scenario 2(a) of 2026-08-09 -----------------------------------
  //
  // A decline discovered by RECONCILIATION rather than by `execute()`. PR 2700
  // taught this normalizer to read a refusal reported per ATTEMPT (pinned above,
  // both directions). It left the other carrier untouched: the same readback also
  // reports refusals in `payments.errors[]`, whose `errorCode` the transport layer
  // already parses and types (`readPaymentErrors` in the HTTP client). Wave 3i
  // closed that carrier, so a charge refused through it alone is now read as the
  // refusal it is, under the same flag and through the same decline-hint table.
  describe("a refusal reported in the errors array instead", () => {
    // No attempts array at all, so nothing here restates what the attempt reader
    // already covers. `105` is the code this adapter's own table reads as
    // `mandateUnsupported` — the single most consequential reading it can make,
    // and therefore the one whose blast radius is worth pinning per rail.
    const refusedThroughErrors = Object.freeze({
      ...refused,
      payments: { errors: [{ errorCode: "105", errorMessage: "refused", fieldName: null }] },
    });

    it("reads a refused charge as terminally failed", () => {
      expect(normalize({ ...refusedThroughErrors })).toMatchObject({
        status: "failed",
        providerStatus: "pending",
        failureReason: declineReason("105"),
      });
    });

    // ⛔ The title is pinned by the dunning conformance kit
    // (`server/adapters/dunningConformanceKit.testFixtures.ts`), which names this
    // exact string as the carrier of its reconciliation scenario. It still says
    // what the test does — the class it reads AS is what this wave narrows — so
    // it stays put rather than moving a shared receipt for a rewording.
    it("keeps the code the transport parsed, and the class it reads as", () => {
      // The code is recorded in full; what this rail may CONCLUDE from it is
      // narrower. `mandateUnsupported` is a claim about the payer's bank being
      // unable to register a mandate, and only a registration can establish
      // that. This rail reads a transaction back — it cannot tell a refused
      // registration from a refused charge on a mandate the bank already
      // holds — so it abstains, and the class stays `indeterminate`.
      //
      // Until this wave it did NOT abstain, and the execution path did: the
      // same code on the same renewal read `mandate_dead` here and
      // `indeterminate` there, so the verdict depended on which rail looked
      // first. `declineCode` below is what still carries the observation
      // forward for the corpus replay that will settle the reading.
      const { rawPayload } = normalize({ ...refusedThroughErrors });
      expect(rawPayload).toMatchObject({
        declineCode: "105",
        neutralReasonHints: [],
        failureClass: "indeterminate",
        failureClassDecidedBy: "default",
      });
    });


    it("prefers the timestamped attempt carrier when both report a refusal", () => {
      // Only one carrier can date its rows, so only one can say which refusal is
      // current. A readback carrying both must not answer from the undated one.
      expect(normalize({
        ...refused,
        payments: {
          attempts: [{ date: "12.08.2026 12:00", paymentErrorCode: "103" }],
          errors: [{ errorCode: "105", errorMessage: "refused", fieldName: null }],
        },
      })).toMatchObject({
        failureReason: declineReason("103"),
        occurredAt: "2026-08-12T10:00:00.000Z",
      });
    });

    it("leaves an errors array with no code non-terminal", () => {
      // The fail-closed direction, restated for the second carrier: terminal only
      // from an explicit code, never from the array's mere presence.
      expect(normalize({
        ...refused,
        payments: { errors: [{ errorCode: "", errorMessage: "noise", fieldName: null }] },
      })).toMatchObject({ status: "pending", failureReason: null });
    });
  });
});

/**
 * The rail stamps its own local wall-clock time and never labels it. Reading it as
 * UTC put every instant this adapter produced one or two hours into the future;
 * on 2026-08-15 a decline that landed 14:46Z was written as 16:46Z — later than
 * the reconciliation run that wrote it. Both carriers are pinned here, on both
 * offsets, because `occurredAt` reaches `p_occurred_at` and dates money.
 */
describe("local wall-clock timestamps become UTC instants", () => {
  const declinedAt = (date: string) => normalize({
    transactionId: "tr_wall_clock",
    status: "pending",
    payments: { attempts: [{ date, paymentErrorCode: "103" }] },
  }).occurredAt;

  const settledAt = (creation: unknown) => normalize({
    transactionId: "tr_wall_clock",
    status: "correct",
    date: { creation, realization: null },
  }).occurredAt;

  it("reproduces the production decline the skew was measured on", () => {
    // The exact inverse of the incident: the rail reported 16:46 local, the bank
    // refused at 14:46Z, and the old parser stored the label as the instant.
    expect(declinedAt("15.08.2026 16:46")).toBe("2026-08-15T14:46:00.000Z");
  });

  it("subtracts one hour rather than two outside summer time", () => {
    expect(declinedAt("12.01.2026 12:00")).toBe("2026-01-12T11:00:00.000Z");
  });

  it("resolves the hour before a spring-forward through the offset then in force", () => {
    // Warsaw jumps 02:00 -> 03:00 on 2026-03-29, i.e. at 01:00Z. Local 01:00 is
    // still CET (00:00Z), but pricing the offset at the naive reading alone sees
    // the post-transition CEST and lands an hour early on 2026-03-28T23:00Z.
    // This is the case that separates the two-pass conversion from a one-pass one.
    expect(declinedAt("29.03.2026 01:00")).toBe("2026-03-29T00:00:00.000Z");
    expect(declinedAt("29.03.2026 03:00")).toBe("2026-03-29T01:00:00.000Z");
  });

  it("reads the transaction carrier's zone-less stamp in the same zone", () => {
    // `readDate`'s own shape, verbatim from the archived production payload.
    // `Date.parse` resolved this against the HOST zone, so it read correct on a
    // Warsaw laptop and skewed on the UTC runtime — this pin holds on both.
    expect(settledAt("2026-08-12 12:00:02")).toBe("2026-08-12T10:00:02.000Z");
  });

  it("honours a stated offset as written instead of shifting it again", () => {
    // The over-application guard: a qualified instant is already an instant.
    expect(settledAt("2026-08-12T12:00:02Z")).toBe("2026-08-12T12:00:02.000Z");
    expect(settledAt("2026-08-12T12:00:02+02:00")).toBe("2026-08-12T10:00:02.000Z");
  });

  it("yields no instant for an unparseable stamp instead of inventing one", () => {
    expect(settledAt("not a date")).toBeNull();
    expect(settledAt(null)).toBeNull();
  });
});


describe("refusal readback without a readable cause", () => {
  it.each([
    [undefined, "absent"], [{ attempts: [] }, "absent"],
    [{ attempts: "malformed" }, "unreadable"], [{ attempts: [{ paymentErrorCode: 63 }] }, "unreadable"],
  ])("persists missing cause disposition for a provider-confirmed failure", async (payments, disposition) => {
    const provider = createTpayPaymentReconciliationProvider({ getTransaction: async () => ({
      transactionId: "tx_refused", title: "TR-readback-refused", status: "failed",
      transactionPaymentUrl: null, amount: 149, currency: null, requestId: "readback-refused", payments: payments ?? {},
    }) });
    const result = await provider.readPayment({ providerPaymentId: "tx_refused" });
    expect(result).toMatchObject({ status: "failed", failureReason: "tpay_failed",
      rawPayload: { failureEvidence: { source: "readback", providerPaymentId: "tx_refused",
        refusalVerified: true, disposition, declineCode: null, adviceCode: null, method: null } } });
    expect(result.rawPayload).not.toHaveProperty("failureClass");
  });
  it.each(["pending", "bank_review", "correct", "cancelled", "expired"])("does not manufacture refusal evidence for %s", (status) => {
    expect(normalize({ transactionId: "tx_other", status }).rawPayload).not.toHaveProperty("failureEvidence");
  });
});
