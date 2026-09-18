import { describe, expect, it } from "vitest";

import {
  readTpayHttpFailure,
  tpayHttpFailureDiagnostic,
  TpayHttpError,
} from "./tpayHttpFailure.js";

describe("Tpay HTTP failure diagnostics", () => {
  it("keeps only bounded machine facts and discards provider prose and payer secrets", async () => {
    const body = {
      requestId: "d3a9826d92c48cb8c185",
      errors: [
        { errorCode: "invalid_request_body", fieldName: "pay.blikPaymentData.blikToken", errorMessage: "anna@example.com token=123456" },
        { errorCode: "payment_failed", fieldName: "payer.email", errorMessage: "PAYID payid-secret https://unsafe.test" },
        { errorCode: "123456", fieldName: "PAYID-secret", errorMessage: "do not retain" },
        { errorCode: "bearer-secret", fieldName: "customer-token", errorMessage: "do not retain either" },
      ],
      payer: { email: "anna@example.com" },
      accessToken: "bearer-secret",
    };

    const { diagnostic } = await readTpayHttpFailure(response(body, 400));

    expect(diagnostic).toEqual({
      httpStatus: 400,
      requestId: "d3a9826d92c48cb8c185",
      providerErrorCodes: ["invalid_request_body", "payment_failed"],
      fieldNames: ["pay.blikPaymentData.blikToken", "payer.email"],
    });
    const serialized = JSON.stringify(diagnostic);
    for (const secret of ["anna@example.com", "123456", "payid-secret", "PAYID-secret", "https://unsafe.test", "bearer-secret", "customer-token", "do not retain"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("degrades malformed and oversized bodies to status-only facts", async () => {
    await expect(readTpayHttpFailure(response("{not-json", 502))).resolves.toEqual({
      diagnostic: { httpStatus: 502, requestId: null, providerErrorCodes: [], fieldNames: [] },
      refusedBeforeTransaction: false,
    });
    await expect(readTpayHttpFailure(response("x".repeat(16_385), 500))).resolves.toEqual({
      diagnostic: { httpStatus: 500, requestId: null, providerErrorCodes: [], fieldNames: [] },
      refusedBeforeTransaction: false,
    });
  });

  /**
   * The release decision this verdict feeds can only be wrong in one direction
   * that costs money, so every case that is not a positively recognized Tpay
   * validation envelope must read `false`.
   */
  describe("pre-transaction refusal verdict", () => {
    it("is true only for a 400 whose every raw error code names a request defect", async () => {
      await expect(refusalOf({ errors: [{ errorCode: "not_valid", fieldName: "payer.name" }] }, 400))
        .resolves.toBe(true);
      // The production shape measured 2026-09-02: one `not_valid`, no field name.
      await expect(refusalOf({ errors: [{ errorCode: "not_valid" }] }, 400)).resolves.toBe(true);
      await expect(refusalOf({ payments: { errors: [{ errorCode: "is_required" }] } }, 400))
        .resolves.toBe(true);
    });

    it("is false when any raw code is not a request defect, including codes the diagnostic drops", async () => {
      // `transaction_lock` is loggable but ambiguous: it may sit on a real
      // transaction.
      await expect(refusalOf({ errors: [{ errorCode: "not_valid" }, { errorCode: "transaction_lock" }] }, 400))
        .resolves.toBe(false);
      // `tpay_future_code` is NOT in the loggable set, so the sanitized
      // diagnostic would show only `not_valid` and read as uniformly safe. The
      // verdict must still refuse, which is why it reads the raw body.
      await expect(refusalOf({ errors: [{ errorCode: "not_valid" }, { errorCode: "tpay_future_code" }] }, 400))
        .resolves.toBe(false);
      await expect(refusalOf({ errors: [{ errorCode: 42 }] }, 400)).resolves.toBe(false);
    });

    it("is false for every status other than 400, and for a 400 that proves nothing", async () => {
      for (const status of [409, 429, 500, 502, 503]) {
        await expect(refusalOf({ errors: [{ errorCode: "not_valid" }] }, status)).resolves.toBe(false);
      }
      await expect(refusalOf({ errors: [] }, 400)).resolves.toBe(false);
      await expect(refusalOf({}, 400)).resolves.toBe(false);
      await expect(refusalOf("not-json-at-all", 400)).resolves.toBe(false);
    });
  });

  it("revalidates the closed projection before it crosses a boundary", () => {
    const error = new TpayHttpError("tpay_request_failed", 400, {
      httpStatus: 400,
      requestId: "d3a9826d92c48cb8c185",
      providerErrorCodes: ["invalid_request_body"],
      fieldNames: ["payer.email"],
    });
    expect(tpayHttpFailureDiagnostic(error)).toEqual(error.failureDiagnostic);
    expect(tpayHttpFailureDiagnostic({
      failureDiagnostic: {
        httpStatus: 400,
        requestId: "buyer-token",
        providerErrorCodes: ["PAYID-secret"],
        fieldNames: ["customer-token"],
      },
    })).toBeNull();
  });
});

async function refusalOf(body: unknown, status: number): Promise<boolean> {
  return (await readTpayHttpFailure(response(body, status))).refusedBeforeTransaction;
}

function response(body: unknown, status: number) {
  return {
    status,
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
  };
}
