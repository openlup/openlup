import { describe, expect, it, vi } from "vitest";

import { verifyTpayJwsSignature } from "./webhookJwsVerifier.js";

describe("Tpay JWS verifier", () => {
  it("verifies detached payload signatures with allowed x5u", async () => {
    const header = base64Url(JSON.stringify({ x5u: "https://secure.sandbox.tpay.com/x509/notifications-jws.pem" }));
    const signature = base64Url("signature");
    const verifyDetachedSignature = vi.fn(() => true);

    await expect(verifyTpayJwsSignature({
      rawBody: "tr_id=TR-123&tr_status=true",
      signatureHeader: `${header}..${signature}`,
      resolveCertificate: async () => "SIGNING CERT",
      rootCertificatePem: "ROOT CERT",
      verifyCertificateChain: () => true,
      verifyDetachedSignature,
    })).resolves.toBe(true);

    expect(verifyDetachedSignature).toHaveBeenCalledWith({
      signingInput: `${header}.${base64Url("tr_id=TR-123&tr_status=true")}`,
      signature: Buffer.from("signature"),
      signingCertificatePem: "SIGNING CERT",
    });
  });

  it("rejects missing headers and non-Tpay certificate URLs before fetching certificates", async () => {
    const resolveCertificate = vi.fn(async () => "SIGNING CERT");
    const badHeader = base64Url(JSON.stringify({ x5u: "https://evil.example/cert.pem" }));

    await expect(verifyTpayJwsSignature({
      rawBody: "tr_id=TR-123",
      signatureHeader: undefined,
      resolveCertificate,
      rootCertificatePem: "ROOT CERT",
    })).resolves.toBe(false);

    await expect(verifyTpayJwsSignature({
      rawBody: "tr_id=TR-123",
      signatureHeader: `${badHeader}..${base64Url("signature")}`,
      resolveCertificate,
      rootCertificatePem: "ROOT CERT",
    })).resolves.toBe(false);

    expect(resolveCertificate).not.toHaveBeenCalled();
  });
});

function base64Url(value: string): string {
  return Buffer.from(value).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
