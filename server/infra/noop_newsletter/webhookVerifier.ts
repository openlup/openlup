import { verifyHmacSignature } from "../../_lib/payment/webhookSignature.js";
import type { VercelRequest } from "../../_lib/types/vercel.js";

export function verifyNoopNewsletterWebhookSignature(input: {
  req: VercelRequest;
  rawBody: string;
  secret: string | undefined;
}): boolean {
  if (!input.secret) return false;
  const signature = firstHeader(input.req.headers["x-openlup-signature"]);
  return verifyHmacSignature({
    rawBody: input.rawBody,
    signatureHeader: signature,
    secret: input.secret,
  });
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
