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

const MAX_X509_CACHE_ENTRIES = 32;
const x509CertificateCache = new Map<string, X509Certificate>();

/** Bounded PEM -> X509Certificate cache to avoid reparsing identical certs per webhook. */
export function parseX509Certificate(pem: string): X509Certificate {
  const cached = x509CertificateCache.get(pem);
  if (cached) return cached;
  const parsed = new X509Certificate(pem);
  if (x509CertificateCache.size >= MAX_X509_CACHE_ENTRIES) {
    const oldest = x509CertificateCache.keys().next().value;
    if (oldest !== undefined) x509CertificateCache.delete(oldest);
  }
  x509CertificateCache.set(pem, parsed);
  return parsed;
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
  if (parts.length !== 3 || !parts[0] || parts[1] !== "" || !parts[2]) return false;
  const header = parseJwsHeader(parts[0]);
  const certificateUrl = header?.x5u ? canonicalizeAllowedCertificateUrl(header.x5u, allowedX5uPrefix) : null;
  if (!certificateUrl) return false;

  const signingCertificatePem = await resolveCertificate(certificateUrl);
  if (!verifyChain(signingCertificatePem, rootCertificatePem)) return false;

  const signedPayload = `${parts[0]}.${base64Url(Buffer.from(rawBody, "utf8"))}`;
  const signature = base64UrlDecode(parts[2]);
  return verifyDetached({ signingInput: signedPayload, signature, signingCertificatePem });
}

function hasAsciiControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function canonicalizeAllowedCertificateUrl(candidate: string, allowedPrefix: string): string | null {
  if (hasAsciiControlChar(candidate) || hasAsciiControlChar(allowedPrefix)) return null;
  if (/[?#]/u.test(candidate) || /[?#]/u.test(allowedPrefix)) return null;
  if (/%2f|%5c/iu.test(candidate)) return null;
  let allowed: URL;
  let parsed: URL;
  try {
    allowed = new URL(allowedPrefix);
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (allowed.protocol !== "https:" || parsed.protocol !== "https:") return null;
  if (allowed.username || allowed.password || allowed.search || allowed.hash) return null;
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  if (parsed.origin !== allowed.origin) return null;
  if (/%2f|%5c/iu.test(parsed.pathname)) return null;
  const prefixPath = allowed.pathname.endsWith("/") ? allowed.pathname : `${allowed.pathname}/`;
  if (!parsed.pathname.startsWith(prefixPath) || parsed.pathname.length <= prefixPath.length) return null;
  return parsed.href;
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
    const signing = parseX509Certificate(signingCertificatePem);
    const root = parseX509Certificate(rootCertificatePem);
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
  try {
    const publicKey = parseX509Certificate(input.signingCertificatePem).publicKey;
    return verifySignature("RSA-SHA256", Buffer.from(input.signingInput), publicKey, input.signature);
  } catch {
    return false;
  }
}

function base64Url(value: Buffer): string {
  return value.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64UrlDecode(value: string): Buffer {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), "=");
  return Buffer.from(padded, "base64");
}
