import { describe, expect, it } from "vitest";

import {
  TPAY_PRODUCTION_JWS_CERT_PREFIX,
  TPAY_PRODUCTION_JWS_ROOT_CERT_URL,
  TPAY_PRODUCTION_OPEN_API_BASE_URL,
  TPAY_SANDBOX_JWS_CERT_PREFIX,
  TPAY_SANDBOX_JWS_ROOT_CERT_URL,
  TPAY_SANDBOX_OPEN_API_BASE_URL,
  isTpayProductionOpenApiBaseUrl,
  isTpaySandboxOpenApiBaseUrl,
} from "./tpayEnvironment.js";

describe("Tpay environment constants", () => {
  it("pins sandbox and production OpenAPI hosts", () => {
    expect(TPAY_SANDBOX_OPEN_API_BASE_URL).toBe("https://openapi.sandbox.tpay.com");
    expect(TPAY_PRODUCTION_OPEN_API_BASE_URL).toBe("https://api.tpay.com");
  });

  it("pins sandbox and production JWS certificate hosts", () => {
    expect(TPAY_SANDBOX_JWS_ROOT_CERT_URL).toBe("https://secure.sandbox.tpay.com/x509/tpay-jws-root.pem");
    expect(TPAY_SANDBOX_JWS_CERT_PREFIX).toBe("https://secure.sandbox.tpay.com/");
    expect(TPAY_PRODUCTION_JWS_ROOT_CERT_URL).toBe("https://secure.tpay.com/x509/tpay-jws-root.pem");
    expect(TPAY_PRODUCTION_JWS_CERT_PREFIX).toBe("https://secure.tpay.com/");
  });

  it("classifies only the exact sandbox OpenAPI host as sandbox", () => {
    expect(isTpaySandboxOpenApiBaseUrl("https://openapi.sandbox.tpay.com")).toBe(true);
    expect(isTpaySandboxOpenApiBaseUrl("https://api.tpay.com")).toBe(false);
    expect(isTpaySandboxOpenApiBaseUrl("http://openapi.sandbox.tpay.com")).toBe(false);
    expect(isTpaySandboxOpenApiBaseUrl("not a url")).toBe(false);
  });

  it("classifies only the exact production OpenAPI host as production", () => {
    expect(isTpayProductionOpenApiBaseUrl("https://api.tpay.com")).toBe(true);
    expect(isTpayProductionOpenApiBaseUrl("https://openapi.sandbox.tpay.com")).toBe(false);
    expect(isTpayProductionOpenApiBaseUrl("http://api.tpay.com")).toBe(false);
    expect(isTpayProductionOpenApiBaseUrl("not a url")).toBe(false);
  });
});
