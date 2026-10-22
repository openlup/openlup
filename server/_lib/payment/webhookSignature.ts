import { readRawBody as readGenericRawBody } from "@openlup/platform/http";
import type { VercelRequest } from "../types/vercel.js";

export {
  MAX_WEBHOOK_BODY_BYTES,
  WebhookBodyTooLargeError,
  verifyHmacSignature,
  timingSafeStringEqual,
} from "@openlup/platform/http";

/** The generic raw-body reader, keeping this module's declared request type. */
export const readRawBody: (req: VercelRequest) => Promise<string> = readGenericRawBody;
