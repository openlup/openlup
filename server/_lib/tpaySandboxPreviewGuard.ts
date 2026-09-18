export type TpayPreviewGuardMismatchReason =
  | "tpay_sandbox_api_base_mismatch"
  | "tpay_sandbox_jws_cert_mismatch"
  | "tpay_verified_test_confirmation_missing"
  | "tpay_verified_test_api_base_mismatch"
  | "tpay_verified_test_jws_cert_mismatch";

export function readTpayPreviewModeMismatch(env: Record<string, string | undefined>): {
  reason: TpayPreviewGuardMismatchReason;
  details: Record<string, unknown>;
} | null {
  if (env.PAYMENTS_TPAY_ENABLED !== "true") {
    return null;
  }

  if (env.PAYMENTS_TPAY_VERIFIED_TEST_MODE_ENABLED === "true") {
    if (env.TPAY_VERIFIED_TEST_MODE_CONFIRMED !== "true") {
      return mismatch(
        "tpay_verified_test_confirmation_missing",
        "TPAY_VERIFIED_TEST_MODE_CONFIRMED",
        env.TPAY_VERIFIED_TEST_MODE_CONFIRMED ?? "missing",
      );
    }
    if (env.TPAY_API_BASE_URL && !isTpayProductionApiBaseUrl(env.TPAY_API_BASE_URL)) {
      return mismatch("tpay_verified_test_api_base_mismatch", "TPAY_API_BASE_URL", env.TPAY_API_BASE_URL);
    }
    if (
      env.TPAY_WEBHOOK_JWS_ROOT_CERT_URL &&
      !isTpayProductionCertificateUrl(env.TPAY_WEBHOOK_JWS_ROOT_CERT_URL)
    ) {
      return mismatch(
        "tpay_verified_test_jws_cert_mismatch",
        "TPAY_WEBHOOK_JWS_ROOT_CERT_URL",
        env.TPAY_WEBHOOK_JWS_ROOT_CERT_URL,
      );
    }
    if (
      env.TPAY_WEBHOOK_JWS_CERT_PREFIX &&
      !isTpayProductionCertificateUrl(env.TPAY_WEBHOOK_JWS_CERT_PREFIX)
    ) {
      return mismatch(
        "tpay_verified_test_jws_cert_mismatch",
        "TPAY_WEBHOOK_JWS_CERT_PREFIX",
        env.TPAY_WEBHOOK_JWS_CERT_PREFIX,
      );
    }
    return null;
  }

  if (env.PAYMENTS_TPAY_SANDBOX_ENABLED !== "true") return null;

  if (env.TPAY_API_BASE_URL && !isTpaySandboxApiBaseUrl(env.TPAY_API_BASE_URL)) {
    return mismatch("tpay_sandbox_api_base_mismatch", "TPAY_API_BASE_URL", env.TPAY_API_BASE_URL);
  }
  if (
    env.TPAY_WEBHOOK_JWS_ROOT_CERT_URL &&
    !isTpaySandboxCertificateUrl(env.TPAY_WEBHOOK_JWS_ROOT_CERT_URL)
  ) {
    return mismatch("tpay_sandbox_jws_cert_mismatch", "TPAY_WEBHOOK_JWS_ROOT_CERT_URL", env.TPAY_WEBHOOK_JWS_ROOT_CERT_URL);
  }
  if (
    env.TPAY_WEBHOOK_JWS_CERT_PREFIX &&
    !isTpaySandboxCertificateUrl(env.TPAY_WEBHOOK_JWS_CERT_PREFIX)
  ) {
    return mismatch("tpay_sandbox_jws_cert_mismatch", "TPAY_WEBHOOK_JWS_CERT_PREFIX", env.TPAY_WEBHOOK_JWS_CERT_PREFIX);
  }
  return null;
}

export const readTpaySandboxMismatch = readTpayPreviewModeMismatch;

function mismatch(reason: TpayPreviewGuardMismatchReason, key: string, value: string) {
  return { reason, details: { provider: "tpay", key, value } };
}

function isTpaySandboxApiBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "openapi.sandbox.tpay.com";
  } catch {
    return false;
  }
}

function isTpayProductionApiBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "api.tpay.com";
  } catch {
    return false;
  }
}

function isTpaySandboxCertificateUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "secure.sandbox.tpay.com";
  } catch {
    return false;
  }
}

function isTpayProductionCertificateUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "secure.tpay.com";
  } catch {
    return false;
  }
}
