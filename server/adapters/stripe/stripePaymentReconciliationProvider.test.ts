import { beforeEach, describe, expect, it, vi } from "vitest";
import { PSP_PROVIDER_KINDS } from "../../../src/domains/payment/pspIntegrationPlan.js";

// The shared classification seam is spied THROUGH to its real implementation:
// the abandonment branch has to prove the classifier was never consulted, and a
// stubbed class would prove nothing about the classes the decline branch yields.
const classifyDeclineSpy = vi.hoisted(() => vi.fn());
vi.mock("../../shared/finalizeDeclinedAttempt.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/finalizeDeclinedAttempt.js")>();
  classifyDeclineSpy.mockImplementation(actual.classifyDecline);
  return { ...actual, classifyDecline: classifyDeclineSpy };
});

// The normalizer is aliased on import: the directory already names the provider,
// and every case in the first two blocks calls that one entry point.
import {
  ABANDONED_BEFORE_CONFIRMATION,
  createStripePaymentReconciliationProvider,
  normalizeStripeIntent as normalize,
} from "./stripePaymentReconciliationProvider.js";

beforeEach(() => {
  classifyDeclineSpy.mockClear();
});

describe("normalize", () => {
  it("maps succeeded Stripe PaymentIntent to terminal success with amount and currency", () => {
    expect(normalize({
      id: "pi_ok",
      status: "succeeded",
      amount: 1299,
      amount_received: 1299,
      currency: "pln",
    })).toMatchObject({
      status: "succeeded",
      providerStatus: "succeeded",
      amountMinor: 1299,
      currency: "PLN",
      failureReason: null,
    });
  });

  it("maps off-session action-required states to terminal failure for dunning", () => {
    expect(normalize({
      id: "pi_action",
      status: "requires_action",
      amount: 1299,
      currency: "pln",
      next_action: { type: "use_stripe_sdk" },
    })).toMatchObject({
      status: "failed",
      providerStatus: "requires_action",
      failureReason: "stripe_requires_action",
      rawPayload: expect.objectContaining({ nextActionType: "use_stripe_sdk" }),
    });
  });

  it("compares an incomplete intent's configured amount instead of zero received", () => {
    expect(normalize({
      id: "pi_incomplete",
      status: "requires_payment_method",
      amount: 10_430,
      amount_received: 0,
      currency: "pln",
    })).toMatchObject({
      status: "failed",
      providerStatus: "requires_payment_method",
      amountMinor: 10_430,
      currency: "PLN",
      failureReason: "stripe_requires_payment_method",
    });
  });

  it("pins the persisted reason keys byte-stable while the structured fields are added beside them", () => {
    // These strings are what the rail writes to
    // `commerce_payment_attempts.failure_reason`. The capture below is additive:
    // nothing renames a key any stored row or comparison already holds.
    expect(normalize({ id: "pi_1", status: "requires_action" }).failureReason)
      .toBe("stripe_requires_action");
    expect(normalize({ id: "pi_2", status: "requires_payment_method" }).failureReason)
      .toBe("stripe_requires_payment_method");
    expect(normalize({
      id: "pi_4",
      status: "requires_payment_method",
      last_payment_error: { code: "card_declined", decline_code: "insufficient_funds" },
    }).failureReason).toBe("stripe_card_declined");
  });

  it("keeps provider processing as non-terminal pending", () => {
    expect(normalize({
      id: "pi_processing",
      status: "processing",
    })).toMatchObject({
      status: "pending",
      providerStatus: "processing",
    });
  });
});

describe("failure capture", () => {
  it("carries the fine decline code and the issuer's advice, and lets advice decide the class", () => {
    const status = normalize({
      id: "pi_declined",
      status: "requires_payment_method",
      latest_charge: "ch_failed",
      last_payment_error: {
        code: "card_declined",
        type: "card_error",
        decline_code: "insufficient_funds",
        advice_code: "try_again_later",
      },
    });

    expect(status.rawPayload).toMatchObject({
      lastPaymentErrorCode: "card_declined",
      declineCode: "insufficient_funds",
      adviceCode: "try_again_later",
      neutralReasonHints: ["transient"],
      failureClass: "soft_retryable",
      failureClassDecidedBy: "advice_code",
    });
  });

  it("classifies a fine decline code through this adapter's own hint table", () => {
    expect(normalize({
      id: "pi_lost",
      status: "requires_payment_method",
      latest_charge: "ch_failed",
      last_payment_error: { code: "card_declined", decline_code: "lost_card" },
    }).rawPayload).toMatchObject({
      declineCode: "lost_card",
      adviceCode: null,
      neutralReasonHints: ["credentialDead"],
      failureClass: "hard_do_not_retry",
      failureClassDecidedBy: "neutral_hint",
    });
  });

  it("answers indeterminate rather than guessing when only the coarse code arrived", () => {
    // `card_declined` is the bucket, not the reason. Nothing here decides a
    // class, and the honest source is `default` — the adapter-prefixed reason
    // key this rail persists is not a mapped verdict either.
    expect(normalize({
      id: "pi_coarse",
      status: "requires_payment_method",
      latest_charge: "ch_failed",
      last_payment_error: { code: "card_declined" },
    }).rawPayload).toMatchObject({
      declineCode: null,
      adviceCode: null,
      neutralReasonHints: [],
      failureClass: "indeterminate",
      failureClassDecidedBy: "default",
    });
  });

  it("holds no opinion on a decline code the research could not read", () => {
    expect(normalize({
      id: "pi_dnh",
      status: "requires_payment_method",
      latest_charge: "ch_failed",
      last_payment_error: { code: "card_declined", decline_code: "do_not_honor" },
    }).rawPayload).toMatchObject({
      declineCode: "do_not_honor",
      neutralReasonHints: [],
      failureClass: "indeterminate",
    });
  });

  it("calls an unconfirmed intent abandonment, never a decline, and never asks the classifier", () => {
    const status = normalize({ id: "pi_abandoned", status: "requires_payment_method" });

    expect(status.rawPayload).toMatchObject({
      lastPaymentErrorCode: null,
      nonDeclineDisposition: ABANDONED_BEFORE_CONFIRMATION,
    });
    // No class at all, so the column stays NULL: `indeterminate` would carry a
    // frozen decision permitting a standard retry, and a cadence reading it
    // would dun a customer who simply closed the tab.
    expect(status.rawPayload).not.toHaveProperty("failureClass");
    expect(classifyDeclineSpy).not.toHaveBeenCalled();
  });

  it("does not claim abandonment while any evidence of an attempt survives", () => {
    for (const intent of [
      { id: "pi_charged", status: "requires_payment_method", latest_charge: "ch_1" },
      {
        id: "pi_errored",
        status: "requires_payment_method",
        last_payment_error: { code: "card_declined" },
      },
    ]) {
      const payload = normalize(intent).rawPayload;
      expect(payload).not.toHaveProperty("nonDeclineDisposition");
      expect(payload).toHaveProperty("failureClass");
    }
    expect(classifyDeclineSpy).toHaveBeenCalledTimes(2);
  });

  it("leaves a non-failed intent entirely uncaptured", () => {
    for (const intent of [
      { id: "pi_ok", status: "succeeded", amount: 1299, amount_received: 1299 },
      { id: "pi_processing", status: "processing" },
    ]) {
      const payload = normalize(intent).rawPayload;
      expect(payload).not.toHaveProperty("failureClass");
      expect(payload).not.toHaveProperty("declineCode");
      expect(payload).not.toHaveProperty("nonDeclineDisposition");
    }
    expect(classifyDeclineSpy).not.toHaveBeenCalled();
  });
});

describe("reconciliation provider absence probe", () => {
  const attempt = {
    paymentIntentId: "22222222-2222-4222-8222-222222222222",
    amountMinor: 1_299,
    currency: "PLN",
  } as never;

  it("exposes findPaymentByLocalIntent when the client can search, querying metadata.paymentIntentId", async () => {
    const searchPaymentIntentsByMetadata = vi.fn(async () => ({ ids: [] as string[] }));
    const provider = createStripePaymentReconciliationProvider({
      retrievePaymentIntent: vi.fn(),
      searchPaymentIntentsByMetadata,
    });

    await expect(provider.findPaymentByLocalIntent?.({ attempt })).resolves.toBe("absent");
    expect(searchPaymentIntentsByMetadata).toHaveBeenCalledWith({
      key: "paymentIntentId",
      value: "22222222-2222-4222-8222-222222222222",
      limit: 1,
    });
  });

  it("returns found when Stripe has a payment intent correlated to the local intent", async () => {
    const provider = createStripePaymentReconciliationProvider({
      retrievePaymentIntent: vi.fn(),
      searchPaymentIntentsByMetadata: vi.fn(async () => ({ ids: ["pi_live_1"] })),
    });

    await expect(provider.findPaymentByLocalIntent?.({ attempt })).resolves.toBe("found");
  });

  it("does not expose the probe when the client cannot search", () => {
    const provider = createStripePaymentReconciliationProvider({ retrievePaymentIntent: vi.fn() });
    expect(provider.findPaymentByLocalIntent).toBeUndefined();
  });

  it("closes an incomplete intent when the client supports cancellation", async () => {
    const cancelPaymentIntent = vi.fn(async () => ({
      id: "pi_old",
      status: "canceled",
      amount: 1_299,
      currency: "pln",
    }));
    const provider = createStripePaymentReconciliationProvider({
      retrievePaymentIntent: vi.fn(),
      cancelPaymentIntent,
    });

    await expect(provider.closePayment?.({ providerPaymentId: "pi_old" })).resolves.toMatchObject({
      status: "failed",
      providerStatus: "canceled",
      amountMinor: 1299,
      currency: "PLN",
    });
    expect(cancelPaymentIntent).toHaveBeenCalledWith("pi_old");
  });

  it("rejects a continuation and marks a readback when Stripe returns another PaymentIntent", async () => {
    const retrievePaymentIntent = vi.fn(async () => ({
      id: "pi_other",
      status: "requires_action",
      client_secret: "pi_other_secret",
      amount: 1_299,
      currency: "pln",
    }));
    const provider = createStripePaymentReconciliationProvider({
      retrievePaymentIntent,
    });
    await expect(provider.readRecoveryPayment({
      providerPaymentId: "pi_expected",
      attempt,
    })).resolves.toMatchObject({
      identityMatches: false,
    });
    expect(retrievePaymentIntent).toHaveBeenCalledTimes(1);
  });

  it("returns the current client secret only for the same resumable PaymentIntent", async () => {
    const provider = createStripePaymentReconciliationProvider({
      retrievePaymentIntent: vi.fn(async () => ({
        id: "pi_existing",
        status: "requires_action",
        client_secret: "pi_existing_secret",
        amount: 1_299,
        currency: "pln",
      })),
    });

    await expect(provider.readRecoveryPayment({
      providerPaymentId: "pi_existing",
      attempt,
    })).resolves.toMatchObject({
      identityMatches: true,
      configuredMoneyMatches: true,
      clientAction: {
        kind: "provider_embedded",
        provider: PSP_PROVIDER_KINDS[0],
        clientSecret: "pi_existing_secret",
      },
    });
  });

  it("returns a pristine same-attempt action only for active checkout continuation", async () => {
    const provider = createStripePaymentReconciliationProvider({
      retrievePaymentIntent: vi.fn(async () => ({
        id: "pi_existing",
        status: "requires_payment_method",
        client_secret: "pi_existing_secret",
        payment_method: null,
        latest_charge: null,
        last_payment_error: null,
        amount: 1_299,
        currency: "pln",
      })),
    });

    await expect(provider.readRecoveryPayment({
      providerPaymentId: "pi_existing",
      attempt,
      purpose: "active_checkout",
    })).resolves.toMatchObject({
      status: { status: "pending" },
      identityMatches: true,
      configuredMoneyMatches: true,
      clientAction: {
        kind: "provider_embedded",
        provider: "stripe",
        clientSecret: "pi_existing_secret",
      },
    });
  });

  it("does not expose a declined or previously used intent as an active action", async () => {
    const provider = createStripePaymentReconciliationProvider({
      retrievePaymentIntent: vi.fn(async () => ({
        id: "pi_existing",
        status: "requires_payment_method",
        client_secret: "pi_existing_secret",
        latest_charge: "ch_failed",
        last_payment_error: { code: "card_declined" },
      })),
    });

    await expect(provider.readRecoveryPayment({
      providerPaymentId: "pi_existing",
      attempt,
      purpose: "active_checkout",
    })).resolves.toMatchObject({ clientAction: null });
  });

  it.each([
    { status: "requires_action", client_secret: null },
    { status: "requires_confirmation", client_secret: "" },
    { status: "processing", client_secret: "unused" },
    { status: "requires_capture", client_secret: "unused" },
  ])("keeps an unresumable active PaymentIntent awaiting provider: $status", async (intent) => {
    const provider = createStripePaymentReconciliationProvider({
      retrievePaymentIntent: vi.fn(async () => ({ id: "pi_existing", ...intent })),
    });

    await expect(provider.readRecoveryPayment({
      providerPaymentId: "pi_existing",
      attempt,
    })).resolves.toMatchObject({
      status: { status: "pending" },
      clientAction: null,
    });
  });
});

describe("live read purpose", () => {
  const attempt = { paymentIntentId: "33333333-3333-4333-8333-333333333333" } as never;

  const neverAsked = {
    id: "pi_fresh",
    status: "requires_payment_method",
    client_secret: "pi_fresh_secret",
    payment_method: null,
    latest_charge: null,
    last_payment_error: null,
  };

  // Derived from the client contract: the intent shape is not exported here, and
  // a hand-written fixture type would drift from what the reader actually takes.
  type IntentFixture = Awaited<ReturnType<
    Parameters<typeof createStripePaymentReconciliationProvider>[0]["retrievePaymentIntent"]
  >>;

  function providerFor(intent: IntentFixture) {
    return createStripePaymentReconciliationProvider({
      retrievePaymentIntent: vi.fn(async () => intent),
    });
  }

  // The defect this block exists for: an intent nobody has been asked to pay was
  // read by the buyer's own "check it now" and came back `failed`, so a live
  // checkout was terminalized 60-70 s after it opened (production, 2026-08-23).
  it("reports an intent no issuer was asked about as pending for an active checkout", async () => {
    await expect(providerFor(neverAsked).readPayment({
      providerPaymentId: "pi_fresh",
      attempt,
      purpose: "active_checkout",
    })).resolves.toMatchObject({
      status: "pending",
      providerStatus: "requires_payment_method",
    });
  });

  // The other half of the same rule, and the reason the purpose is opt-IN:
  // reconciliation names no purpose and must go on closing real abandonment.
  it("still terminalizes the same intent for a purposeless reconciliation read", async () => {
    await expect(providerFor(neverAsked).readPayment({
      providerPaymentId: "pi_fresh",
      attempt,
    })).resolves.toMatchObject({ status: "failed" });
  });

  it("keeps a refused intent terminal even for an active checkout", async () => {
    await expect(providerFor({
      ...neverAsked,
      last_payment_error: { code: "card_declined", decline_code: "insufficient_funds" },
    }).readPayment({
      providerPaymentId: "pi_fresh",
      attempt,
      purpose: "active_checkout",
    })).resolves.toMatchObject({ status: "failed" });
  });

  it.each([
    { case: "a payment method is already attached", intent: { payment_method: "pm_1" } },
    { case: "a charge exists", intent: { latest_charge: "ch_1" } },
    { case: "the intent was cancelled", intent: { status: "canceled" } },
  ])("keeps the intent terminal for an active checkout when $case", async ({ intent }) => {
    await expect(providerFor({ ...neverAsked, ...intent }).readPayment({
      providerPaymentId: "pi_fresh",
      attempt,
      purpose: "active_checkout",
    })).resolves.toMatchObject({ status: "failed" });
  });

  // Our inability to hand back a card form is a fact about us, not a refusal by
  // an issuer, so it may not decide the payment's status.
  it("lowers the recovery read even when no client secret can be handed back", async () => {
    const { client_secret: _omitted, ...secretless } = neverAsked;

    await expect(providerFor(secretless).readRecoveryPayment({
      providerPaymentId: "pi_fresh",
      attempt,
      purpose: "active_checkout",
    })).resolves.toMatchObject({
      status: { status: "pending" },
      clientAction: null,
    });
  });
});

/**
 * ⛔ THE SEAM A RENAME WOULD SILENTLY BREAK.
 *
 * `payment_abandoned_before_confirmation` (p1) counts this disposition out of the
 * reconciliation run's durable payload. The detector lives in
 * `server/domains/platform/checkoutAbandonmentEvidence.ts` and holds the token as
 * a string literal, because a platform domain module may not import a named
 * provider adapter — and naming a vendor inside `server/domains/**` is a counted
 * OSS-ratchet token, while `server/adapters/**` is excluded.
 *
 * That boundary is correct and it is also exactly how a detector goes quietly
 * empty: rename the constant on this side and the literal over there keeps
 * compiling while matching nothing, forever. The assertion therefore lives HERE,
 * on the side that owns the value, and fails whichever side moves.
 */
describe("the abandonment disposition crosses to the platform detector intact", () => {
  it("writes the exact token the abandonment detector matches", async () => {
    const { ABANDONED_BEFORE_CONFIRMATION: detectorToken } = await import(
      "../../domains/platform/checkoutAbandonmentEvidence.js"
    );
    expect(ABANDONED_BEFORE_CONFIRMATION).toBe(detectorToken);
  });

  // The nesting the detector reads is `payload.providerPayload.<key>`, and the
  // worker composes that from this adapter's `rawPayload`. Pinning the KEY here
  // keeps the two halves of that path honest from the producing end.
  it("carries the disposition under the key the run payload preserves", () => {
    const payload = normalize({
      id: "pi_abandoned",
      status: "requires_payment_method",
      currency: "pln",
    } as never).rawPayload;

    expect(payload).toMatchObject({ nonDeclineDisposition: ABANDONED_BEFORE_CONFIRMATION });
  });
});
