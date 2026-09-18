import { describe, expect, it } from "vitest";

import { readTpayPreviewModeMismatch, readTpaySandboxMismatch } from "./tpaySandboxPreviewGuard.js";

describe("Tpay preview mode guard", () => {
  it("keeps disabled and simulator-only Tpay out of sandbox URL validation", () => {
    expect(readTpayPreviewModeMismatch({ PAYMENTS_TPAY_ENABLED: "false" })).toBeNull();
    expect(readTpayPreviewModeMismatch({
      PAYMENTS_TPAY_ENABLED: "true",
      PAYMENTS_TPAY_SIMULATOR_ENABLED: "true",
      TPAY_API_BASE_URL: "https://api.tpay.com",
    })).toBeNull();
  });

  it("requires sandbox API and sandbox JWS hosts in sandbox mode", () => {
    expect(readTpayPreviewModeMismatch({
      PAYMENTS_TPAY_ENABLED: "true",
      PAYMENTS_TPAY_SANDBOX_ENABLED: "true",
      TPAY_API_BASE_URL: "https://api.tpay.com",
    })).toMatchObject({ reason: "tpay_sandbox_api_base_mismatch" });

    expect(readTpayPreviewModeMismatch({
      PAYMENTS_TPAY_ENABLED: "true",
      PAYMENTS_TPAY_SANDBOX_ENABLED: "true",
      TPAY_API_BASE_URL: "https://openapi.sandbox.tpay.com",
      TPAY_WEBHOOK_JWS_CERT_PREFIX: "https://secure.tpay.com/",
    })).toMatchObject({ reason: "tpay_sandbox_jws_cert_mismatch" });
  });

  it("requires explicit confirmation plus production API/JWS hosts in verified test mode", () => {
    expect(readTpayPreviewModeMismatch({
      PAYMENTS_TPAY_ENABLED: "true",
      PAYMENTS_TPAY_VERIFIED_TEST_MODE_ENABLED: "true",
      TPAY_API_BASE_URL: "https://api.tpay.com",
    })).toMatchObject({ reason: "tpay_verified_test_confirmation_missing" });

    expect(readTpayPreviewModeMismatch({
      PAYMENTS_TPAY_ENABLED: "true",
      PAYMENTS_TPAY_VERIFIED_TEST_MODE_ENABLED: "true",
      TPAY_VERIFIED_TEST_MODE_CONFIRMED: "true",
      TPAY_API_BASE_URL: "https://openapi.sandbox.tpay.com",
    })).toMatchObject({ reason: "tpay_verified_test_api_base_mismatch" });

    expect(readTpayPreviewModeMismatch({
      PAYMENTS_TPAY_ENABLED: "true",
      PAYMENTS_TPAY_VERIFIED_TEST_MODE_ENABLED: "true",
      TPAY_VERIFIED_TEST_MODE_CONFIRMED: "true",
      TPAY_API_BASE_URL: "https://api.tpay.com",
      TPAY_WEBHOOK_JWS_ROOT_CERT_URL: "https://secure.sandbox.tpay.com/x509/tpay-jws-root.pem",
    })).toMatchObject({ reason: "tpay_verified_test_jws_cert_mismatch" });
  });

  it("keeps the legacy sandbox export wired to the preview guard", () => {
    expect(readTpaySandboxMismatch({
      PAYMENTS_TPAY_ENABLED: "true",
      PAYMENTS_TPAY_SANDBOX_ENABLED: "true",
      TPAY_API_BASE_URL: "https://api.tpay.com",
    })).toMatchObject({ reason: "tpay_sandbox_api_base_mismatch" });
  });
});
