import { describe, expect, it } from "vitest";

import { buildTpayTransactionPayload } from "../../../src/payments/tpay/tpayTransactionPayload.js";
import type { TpayTransactionCreateInput } from "../../../src/payments/tpay/tpayTransactionPayload.js";

function baseInput(overrides: Partial<TpayTransactionCreateInput> = {}): TpayTransactionCreateInput {
  return {
    amount: 14.9,
    currency: "PLN",
    description: "OPENLUP-TEST",
    hiddenDescription: "intent-1",
    payer: { email: "buyer@example.com", name: "Buyer" },
    notificationUrl: "https://example.test/api/bff/payment/webhooks/tpay",
    successUrl: "https://example.test/ok",
    errorUrl: "https://example.test/err",
    groupId: 150,
    ...overrides,
  };
}

function blikPaymentData(input: TpayTransactionCreateInput): Record<string, unknown> {
  const payload = buildTpayTransactionPayload(input);
  const pay = payload.pay as Record<string, unknown>;
  return pay.blikPaymentData as Record<string, unknown>;
}

describe("Tpay transaction payload", () => {
  describe("Model O mandate registration", () => {
    // Shape verified against production on 2026-07-20: this exact payload
    // registered a working PayID mandate on ING.
    const registration = baseInput({
      blikToken: "123456",
      refuseNoPayId: true,
      alias: {
        value: "openlup_intent-1",
        type: "PAYID",
        label: "openlup",
        recommendedAuthLevel: "NOCONFREQ",
        autopayment: { model: "O" },
      },
    });

    it("sends recommendedAuthLevel as a sibling of autopayment, not nested inside it", () => {
      const aliases = blikPaymentData(registration).aliases as Record<string, unknown>;
      expect(aliases.recommendedAuthLevel).toBe("NOCONFREQ");
      expect(aliases.autopayment).toEqual({ model: "O" });
    });

    it("places refuseNoPayId beside aliases, so BLIK rejects an incapable bank instead of taking the money", () => {
      expect(blikPaymentData(registration).refuseNoPayId).toBe(true);
    });

    it("never sends frequency: Tpay does not accept it for model O", () => {
      const aliases = blikPaymentData(registration).aliases as Record<string, unknown>;
      expect(aliases).not.toHaveProperty("frequency");
      expect(aliases.autopayment).not.toHaveProperty("frequency");
    });
  });

  describe("Model O charge", () => {
    // Verified against production 2026-07-20: settled in ~1s with no payer
    // action. The same charge WITHOUT recommendedAuthLevel instead emailed the
    // payer an approval link — model M behaviour — so both fields are load
    // bearing on every charge, not just at registration.
    const charge = baseInput({
      blikPaymentType: 2,
      alias: {
        value: "openlup_intent-1",
        type: "PAYID",
        noDelay: true,
        recommendedAuthLevel: "NOCONFREQ",
      },
    });

    it("carries type 2, noDelay and NOCONFREQ, and sends no BLIK token", () => {
      const data = blikPaymentData(charge);
      expect(data.type).toBe(2);
      expect(data).not.toHaveProperty("blikToken");
      expect(data.aliases).toMatchObject({ noDelay: true, recommendedAuthLevel: "NOCONFREQ" });
    });
  });

  describe("plain one-off BLIK", () => {
    it("never carries refuseNoPayId: it would break ordinary BLIK, which needs no mandate", () => {
      const data = blikPaymentData(baseInput({ blikToken: "123456" }));
      expect(data).not.toHaveProperty("refuseNoPayId");
      expect(data).not.toHaveProperty("aliases");
    });
  });

  it("omits the pay block entirely when neither a token nor an alias is present", () => {
    expect(buildTpayTransactionPayload(baseInput({ groupId: undefined }))).not.toHaveProperty("pay");
  });

  describe("payer fields fit the provider's documented maxima", () => {
    // Tpay caps every payer field at 255 BYTES: `Model/Objects/Transactions/Payer.php`
    // binds each key to a field model declaring `$maxLength = 255`, and
    // `Model/Fields/FieldValidator.php` measures it with PHP `strlen()`. An
    // over-long field is refused with HTTP 400 `not_valid` and, on BLIK, the code
    // never reaches the bank.
    const MAX_BYTES = 255;

    function payerOf(payer: Partial<TpayTransactionCreateInput["payer"]>): Record<string, unknown> {
      const payload = buildTpayTransactionPayload(baseInput({
        payer: { email: "buyer@example.com", name: "Buyer", ...payer },
      }));
      return payload.payer as Record<string, unknown>;
    }

    // The exact shape that broke production on 2026-08-28: the Facebook iOS
    // in-app WebView. Facebook Android measures 195-218 and always worked.
    // The locale and carrier segments carry deliberately neutral values - only
    // the total length is load bearing, and the real ones spend shared-vocabulary
    // ratchet tokens this family has no headroom for.
    const facebookIosUserAgent =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 "
      + "(KHTML, like Gecko) Mobile/21F90 [FBAN/FBIOS;FBAV/468.0.0.35.107;FBBV/605637817;"
      + "FBDV/iPhone14,3;FBMD/iPhone;FBSN/iOS;FBSV/17.5.1;FBSS/3;FBID/phone;FBLC/de_DE;"
      + "FBCR/Telekom;FBOP/5;FBRV/609298154]";

    it("pins the incident input: the Facebook iOS user agent is 271 characters, 16 over the cap", () => {
      expect(facebookIosUserAgent).toHaveLength(271);
    });

    it("clamps that 271-character user agent to a value Tpay accepts, instead of a 400", () => {
      const userAgent = payerOf({ userAgent: facebookIosUserAgent }).userAgent as string;
      expect(new TextEncoder().encode(userAgent)).toHaveLength(MAX_BYTES);
      // A truthful prefix, not a mangled or invented value.
      expect(facebookIosUserAgent.startsWith(userAgent)).toBe(true);
      expect(userAgent.startsWith("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1")).toBe(true);
    });

    it("leaves a user agent of exactly the cap byte-identical", () => {
      const exact = "u".repeat(MAX_BYTES);
      expect(payerOf({ userAgent: exact }).userAgent).toBe(exact);
    });

    it("clamps one byte over the cap, and only by that byte", () => {
      const overByOne = "u".repeat(MAX_BYTES + 1);
      expect(payerOf({ userAgent: overByOne }).userAgent).toBe("u".repeat(MAX_BYTES));
    });

    it("leaves an ordinary user agent completely untouched", () => {
      const ordinary = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) "
        + "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
      expect(ordinary.length).toBeLessThan(MAX_BYTES);
      expect(payerOf({ userAgent: ordinary }).userAgent).toBe(ordinary);
    });

    it("counts bytes rather than characters, so a multibyte name still fits", () => {
      // 200 characters but 400 bytes in UTF-8: a character-based clamp would
      // leave this over the limit and Tpay would refuse it exactly as before.
      const name = "ż".repeat(200);
      const clamped = payerOf({ name }).name as string;
      const bytes = new TextEncoder().encode(clamped);
      expect(bytes.length).toBeLessThanOrEqual(MAX_BYTES);
      // Cut on a code-point boundary: no replacement character, still a prefix.
      expect(clamped).not.toContain("\uFFFD");
      expect(name.startsWith(clamped)).toBe(true);
    });

    it("clamps the email and the ip through the same cap", () => {
      const payer = payerOf({
        email: `${"e".repeat(MAX_BYTES)}@example.com`,
        ip: "1".repeat(MAX_BYTES + 40),
      });
      expect(payer.email).toHaveLength(MAX_BYTES);
      expect(payer.ip).toHaveLength(MAX_BYTES);
    });

    it("still omits ip and userAgent entirely when the request carried neither", () => {
      const payer = payerOf({ ip: null, userAgent: null });
      expect(payer).not.toHaveProperty("ip");
      expect(payer).not.toHaveProperty("userAgent");
    });
  });
});
