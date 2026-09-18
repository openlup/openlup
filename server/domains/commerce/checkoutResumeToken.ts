import { createHash, createHmac, randomBytes } from "node:crypto";

export interface CheckoutResumeTokenCodec {
  generateToken(input?: { idempotencyKey?: string }): string;
  hashToken(token: string): string;
  hashIdempotencyKey(idempotencyKey: string): string;
}

export function createNodeCheckoutResumeTokenCodec(
  deterministicSecret?: string,
): CheckoutResumeTokenCodec {
  const secret = deterministicSecret?.trim() || null;

  return {
    generateToken(input = {}) {
      if (input.idempotencyKey && secret) {
        return toBase64Url(
          createHmac("sha256", secret)
            .update(`commerce.checkout_resume.v1:${input.idempotencyKey}`)
            .digest(),
        );
      }

      return toBase64Url(randomBytes(32));
    },
    hashToken(token: string) {
      return createHash("sha256").update(token).digest("hex");
    },
    hashIdempotencyKey(idempotencyKey: string) {
      if (secret) {
        return createHmac("sha256", secret)
          .update(`commerce.checkout_resume.idempotency.v1:${idempotencyKey}`)
          .digest("hex");
      }

      return createHash("sha256").update(idempotencyKey).digest("hex");
    },
  };
}

function toBase64Url(bytes: Buffer): string {
  return bytes
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
