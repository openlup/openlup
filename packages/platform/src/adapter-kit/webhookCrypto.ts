import { createHmac, createPublicKey, verify as cryptoVerify } from "node:crypto";
import {
  MAX_WEBHOOK_BODY_BYTES,
  readRawBody,
  timingSafeStringEqual,
  WebhookBodyTooLargeError,
} from "../http/index.js";

export { MAX_WEBHOOK_BODY_BYTES, readRawBody, timingSafeStringEqual, WebhookBodyTooLargeError };

export interface VerifyHmacSha256Input {
  readonly payload: string | Uint8Array;
  readonly signature: string;
  readonly secrets: readonly (string | Uint8Array)[];
  readonly encoding?: "hex" | "base64";
  readonly prefix?: string;
}

export function verifyHmacSha256(input: VerifyHmacSha256Input): boolean {
  const { payload, signature, secrets } = input;
  if (!signature || !Array.isArray(secrets) || secrets.length === 0) return false;
  const encoding = input.encoding ?? "hex";
  const prefix = input.prefix ?? "";
  if (prefix && !signature.startsWith(prefix)) return false;
  const candidate = prefix ? signature.slice(prefix.length) : signature;
  if (!candidate) return false;

  const normalizedCandidate = encoding === "hex" ? candidate.toLowerCase() : candidate;
  for (const secret of secrets) {
    if (typeof secret === "string" ? secret.length === 0 : secret.byteLength === 0) continue;
    const expected = createHmac("sha256", secret).update(payload).digest(encoding);
    if (timingSafeStringEqual(normalizedCandidate, expected)) return true;
  }
  return false;
}

function decodeStrictWhsecKey(secret: string): Buffer | null {
  if (!secret) return null;
  if (!secret.startsWith("whsec_")) {
    const raw = Buffer.from(secret, "utf8");
    return raw.byteLength >= 16 ? raw : null;
  }
  const encoded = secret.slice("whsec_".length);
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded) || encoded.length % 4 === 1) {
    return null;
  }
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.byteLength < 16) return null;
  const canonicalPadded = decoded.toString("base64");
  const canonicalUnpadded = canonicalPadded.replace(/=+$/u, "");
  return encoded === canonicalPadded || encoded === canonicalUnpadded ? decoded : null;
}

export interface VerifyHardenedStandardWebhookInput {
  readonly rawBody: string | Uint8Array;
  readonly webhookId: string | undefined;
  readonly timestamp: string | undefined;
  readonly signature: string | undefined;
  readonly secrets: readonly string[];
  readonly toleranceSeconds?: number;
  readonly now?: () => number;
}

/**
 * Standard Webhooks (Svix `whsec_`) verifier with strict canonical base64 >= 16 B key check,
 * multi-secret rotation, multi-signature (`v1,<base64>`) matching, and timestamp skew guard.
 */
export function verifyHardenedStandardWebhook(input: VerifyHardenedStandardWebhookInput): boolean {
  const { rawBody, webhookId, timestamp, signature, secrets } = input;
  if (!webhookId || !timestamp || !signature || !Array.isArray(secrets) || secrets.length === 0) {
    return false;
  }
  if (!/^\d+$/u.test(timestamp.trim())) return false;
  const tsSeconds = Number.parseInt(timestamp.trim(), 10);
  if (!Number.isSafeInteger(tsSeconds)) return false;

  const nowSeconds = input.now ? input.now() : Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? 300;
  if (!Number.isFinite(tolerance) || tolerance < 0 || Math.abs(nowSeconds - tsSeconds) > tolerance) {
    return false;
  }

  const members = signature
    .split(/\s+/u)
    .map((m) => m.trim())
    .filter((m) => m.startsWith("v1,"));
  if (members.length === 0) return false;

  const prefix = `${webhookId}.${timestamp.trim()}.`;
  for (const secret of secrets) {
    const key = decodeStrictWhsecKey(secret);
    if (!key) continue;
    const expected = createHmac("sha256", key).update(prefix).update(rawBody).digest("base64");
    const expectedMember = `v1,${expected}`;
    for (const member of members) {
      if (timingSafeStringEqual(member, expectedMember)) return true;
    }
  }
  return false;
}

export interface VerifyEd25519SignatureInput {
  readonly payload: string | Uint8Array;
  readonly signature: string;
  readonly publicKeyPem: string;
  readonly signatureEncoding?: "hex" | "base64";
}

export function verifyEd25519Signature(input: VerifyEd25519SignatureInput): boolean {
  const { payload, signature, publicKeyPem } = input;
  if (!signature || !publicKeyPem) return false;
  const encoding = input.signatureEncoding ?? "base64";
  try {
    let sigBytes: Buffer;
    if (encoding === "hex") {
      if (!/^[0-9a-fA-F]+$/u.test(signature) || signature.length % 2 !== 0) return false;
      sigBytes = Buffer.from(signature, "hex");
    } else {
      if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(signature) || signature.length % 4 === 1) return false;
      sigBytes = Buffer.from(signature, "base64");
    }
    if (sigBytes.byteLength !== 64) return false;
    const keyObj = createPublicKey(publicKeyPem);
    const data = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
    return cryptoVerify(null, data, keyObj, sigBytes);
  } catch {
    return false;
  }
}
