import { beforeAll, describe, expect, it, vi } from "vitest";

import { verifyTpayJwsSignature } from "../../../src/payments/tpay/webhookJwsVerifier.js";
import { createTpayJwsFixture } from "./webhookJws.testFixtures.js";

describe("Tpay JWS default crypto", () => {
  let fixture: ReturnType<typeof createTpayJwsFixture>;
  const rawBody = "tr_id=TR-real&tr_status=TRUE&tr_amount=25.99&tr_paid=25.99";
  beforeAll(() => { fixture = createTpayJwsFixture(); });

  it("verifies an actual root-signed leaf and detached RSA signature", async () => {
    const resolveCertificate = vi.fn(async () => fixture.signingCertificatePem);
    await expect(verifyTpayJwsSignature({ rawBody, signatureHeader: fixture.signature(rawBody),
      rootCertificatePem: fixture.rootCertificatePem, resolveCertificate })).resolves.toBe(true);
    expect(resolveCertificate).toHaveBeenCalledExactlyOnceWith("https://secure.sandbox.tpay.com/x509/test-signing.pem");
  });

  it.each(["root", "body", "signature", "header"] as const)("rejects changed %s with real crypto", async (changed) => {
    const signatureHeader = fixture.signature(rawBody);
    const parts = signatureHeader.split(".");
    if (changed === "signature") parts[2] = Buffer.alloc(256, 1).toString("base64url");
    if (changed === "header") parts[0] = Buffer.from(JSON.stringify({
      alg: "RS256", x5u: "https://secure.sandbox.tpay.com/x509/changed.pem",
    })).toString("base64url");
    const resolveCertificate = vi.fn(async () => fixture.signingCertificatePem);
    await expect(verifyTpayJwsSignature({
      rawBody: changed === "body" ? rawBody.replace("25.99", "26.00") : rawBody,
      signatureHeader: parts.join("."), resolveCertificate,
      rootCertificatePem: changed === "root" ? fixture.signingCertificatePem : fixture.rootCertificatePem,
    })).resolves.toBe(false);
    expect(resolveCertificate).toHaveBeenCalledTimes(1);
  });

  it("refuses a genuinely signed forbidden x5u before certificate resolution", async () => {
    const resolveCertificate = vi.fn(async () => fixture.signingCertificatePem);
    await expect(verifyTpayJwsSignature({ rawBody,
      signatureHeader: fixture.signature(rawBody, "https://forbidden.example.test/signer.pem"),
      rootCertificatePem: fixture.rootCertificatePem, resolveCertificate })).resolves.toBe(false);
    expect(resolveCertificate).not.toHaveBeenCalled();
  });
});

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
