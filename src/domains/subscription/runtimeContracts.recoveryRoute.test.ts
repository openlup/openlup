import { describe, expect, it } from "vitest";
import {
  SUBSCRIPTION_RUNTIME_CONTRACT_VERSION,
  handleSubscriptionPaymentFailureResponseSchema,
} from "./runtimeContracts";
import { PAYMENT_RECOVERY_PATH } from "@/lib/customerRecoverySession";

// Characterization for E12: the runtime dunning contract now validates the
// recovery deep-link by SHAPE (absolute path + `?token=<64 hex>`) instead of a
// hard-coded market route literal. These tests pin that the change is
// behaviour-neutral for every currently-produced value and every prior
// structural rejection, and label the one intended delta (other absolute paths
// with a valid token are now accepted too).

// A representative 64-char lowercase-hex dunning token (the DB RPC token
// shape), constructed programmatically so secret scanners do not read the
// fixture as a secret-like literal (gitleaks generic-api-key keys on a
// token-named assignment holding a contiguous hex string).
const HEX_ALPHABET = "0123456789abcdef";
const TOKEN = HEX_ALPHABET.repeat(4);

// The concrete route is app/overlay-owned; sourced from the single canonical
// constant so a drift in the produced route fails this test loudly.
const RECOVERY_ROUTE = PAYMENT_RECOVERY_PATH;

function responseWithRecoveryUrlPath(recoveryUrlPath: string) {
  return {
    contractVersion: SUBSCRIPTION_RUNTIME_CONTRACT_VERSION,
    subscriptionDunning: {
      caseId: "11111111-1111-4111-8111-111111111111",
      subscriptionId: "22222222-2222-4222-8222-222222222222",
      cycleId: "33333333-3333-4333-8333-333333333333",
      orderId: "44444444-4444-4444-8444-444444444444",
      paymentIntentId: "55555555-5555-4555-8555-555555555555",
      status: "open" as const,
      retryAttempt: 1,
      nextRetryAt: "2026-08-02T10:00:00.000Z",
      customerNotificationQueued: true,
      adminNotificationCount: 0,
      recoveryTokenPurpose: "repair_payment" as const,
      recoveryUrlPath,
      replayed: false,
    },
  };
}

describe("runtimeContracts recovery route shape (E12)", () => {
  it("produces the current recovery URL path byte-for-byte", () => {
    // Stop condition guard: if the produced recovery URL ever drifts from the
    // canonical route, this fails (stop-if-produced-recovery-url-differs).
    const producedPath = `${RECOVERY_ROUTE}?token=${TOKEN}`;
    expect(producedPath).toBe(`/konto/platnosc/napraw?token=${TOKEN}`);
    expect(
      handleSubscriptionPaymentFailureResponseSchema.safeParse(
        responseWithRecoveryUrlPath(producedPath),
      ).success,
    ).toBe(true);
  });

  it("accepts the full current valid dunning response payload", () => {
    const parsed = handleSubscriptionPaymentFailureResponseSchema.safeParse(
      responseWithRecoveryUrlPath(`${RECOVERY_ROUTE}?token=${TOKEN}`),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.subscriptionDunning.recoveryUrlPath).toBe(
        `/konto/platnosc/napraw?token=${TOKEN}`,
      );
    }
  });

  it("keeps every prior structural rejection", () => {
    const rejected = [
      `konto/platnosc/napraw?token=${TOKEN}`, // relative path
      "/konto/platnosc/napraw", // missing token
      `/?token=${TOKEN}`, // empty path segment
      `/konto/platnosc/napraw?token=${TOKEN.slice(0, 63)}`, // token too short
      `/konto/platnosc/napraw?token=${TOKEN}a`, // token too long
      `/konto/platnosc/napraw?token=${TOKEN.toUpperCase()}`, // uppercase hex
      `/konto/platnosc/napraw?token=${"g".repeat(64)}`, // non-hex char
      `/konto/platnosc/napraw?token=${TOKEN}&source=xyz`, // extra query param
      `/konto/platnosc/napraw?token=${TOKEN}#payment`, // fragment
      `/konto platnosc/napraw?token=${TOKEN}`, // whitespace in path
      `/konto/platnosc/napraw?token=`, // empty token
    ];
    for (const recoveryUrlPath of rejected) {
      expect(
        handleSubscriptionPaymentFailureResponseSchema.safeParse(
          responseWithRecoveryUrlPath(recoveryUrlPath),
        ).success,
        recoveryUrlPath,
      ).toBe(false);
    }
  });

  it("intended E12 delta: other absolute routes with a valid token now validate", () => {
    // The behaviour E12 unlocks (vertical-agnostic): the contract no longer pins
    // one market's path segment. No live producer emits these today.
    for (const path of ["/account/payment/recover", "/anything/here", "/x"]) {
      expect(
        handleSubscriptionPaymentFailureResponseSchema.safeParse(
          responseWithRecoveryUrlPath(`${path}?token=${TOKEN}`),
        ).success,
        path,
      ).toBe(true);
    }
  });
});
