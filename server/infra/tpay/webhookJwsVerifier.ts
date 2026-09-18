import { verify as verifySignature, X509Certificate } from "node:crypto";

export interface TpayJwsCertificateResolver {
  (url: string): Promise<string>;
}

export interface TpayJwsVerificationInput {
  rawBody: string;
  signatureHeader: string | undefined;
  resolveCertificate: TpayJwsCertificateResolver;
  rootCertificatePem: string;
  allowedX5uPrefix?: string;
  verifyCertificateChain?: (signingCertificatePem: string, rootCertificatePem: string) => boolean;
  verifyDetachedSignature?: (input: {
    signingInput: string;
    signature: Buffer;
    signingCertificatePem: string;
  }) => boolean;
}

export async function verifyTpayJwsSignature({
  rawBody,
  signatureHeader,
  resolveCertificate,
  rootCertificatePem,
  allowedX5uPrefix = "https://secure.sandbox.tpay.com/",
  verifyCertificateChain: verifyChain = verifyCertificateChain,
  verifyDetachedSignature: verifyDetached = defaultVerifyDetachedSignature,
}: TpayJwsVerificationInput): Promise<boolean> {
  if (!signatureHeader || !rootCertificatePem) return false;
  const parts = signatureHeader.split(".");
  if (parts.length < 3 || !parts[0] || !parts[2]) return false;
  const header = parseJwsHeader(parts[0]);
  if (!header?.x5u || !header.x5u.startsWith(allowedX5uPrefix)) return false;

  const signingCertificatePem = await resolveCertificate(header.x5u);
  if (!verifyChain(signingCertificatePem, rootCertificatePem)) return false;

  const signedPayload = `${parts[0]}.${base64Url(Buffer.from(rawBody, "utf8"))}`;
  const signature = base64UrlDecode(parts[2]);
  return verifyDetached({ signingInput: signedPayload, signature, signingCertificatePem });
}

function parseJwsHeader(encoded: string): { x5u?: string } | null {
  try {
    const parsed = JSON.parse(base64UrlDecode(encoded).toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const x5u = (parsed as Record<string, unknown>).x5u;
    return typeof x5u === "string" ? { x5u } : null;
  } catch {
    return null;
  }
}

function verifyCertificateChain(signingCertificatePem: string, rootCertificatePem: string): boolean {
  try {
    const signing = new X509Certificate(signingCertificatePem);
    const root = new X509Certificate(rootCertificatePem);
    return signing.verify(root.publicKey);
  } catch {
    return false;
  }
}

function defaultVerifyDetachedSignature(input: {
  signingInput: string;
  signature: Buffer;
  signingCertificatePem: string;
}): boolean {
  const publicKey = new X509Certificate(input.signingCertificatePem).publicKey;
  return verifySignature("RSA-SHA256", Buffer.from(input.signingInput), publicKey, input.signature);
}

function base64Url(value: Buffer): string {
  return value.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64UrlDecode(value: string): Buffer {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), "=");
  return Buffer.from(padded, "base64");
}
