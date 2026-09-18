import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  CHECKOUT_RESUME_CONTRACT_VERSION,
  checkoutResumeReadRequestSchema,
  checkoutResumeReadResponseSchema,
  checkoutResumeUpsertRequestSchema,
  checkoutResumeUpsertResponseSchema,
} from "../../../src/domains/commerce/checkoutResumeContracts.js";
import {
  CommerceCheckoutResumePersistenceError,
  type CommerceCheckoutResumeDraftPort,
} from "../../../src/domains/commerce/ports.js";
import type { CheckoutResumeTokenCodec } from "./checkoutResumeToken.js";

export interface CommerceCheckoutResumeHandlerDeps {
  resumePort: CommerceCheckoutResumeDraftPort;
  tokenCodec: CheckoutResumeTokenCodec;
  now?: () => Date;
}

export function createCommerceCheckoutResumeUpsertHandler({
  resumePort,
  tokenCodec,
  now = () => new Date(),
}: CommerceCheckoutResumeHandlerDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "POST") {
      sendMethodNotAllowed(res, ["POST"]);
      return;
    }

    const parsed = checkoutResumeUpsertRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid checkout resume request", {
        details: parsed.error.flatten(),
      });
      return;
    }

    const request = parsed.data;
    const resumeToken =
      request.resumeToken ??
      tokenCodec.generateToken({ idempotencyKey: request.idempotencyKey });
    const currentTime = now();
    const currentIso = currentTime.toISOString();
    const expiresAt = new Date(currentTime.getTime() + request.ttlMinutes * 60_000).toISOString();

    try {
      const draft = await resumePort.upsertDraft({
        tokenHash: tokenCodec.hashToken(resumeToken),
        idempotencyKeyHash: request.idempotencyKey
          ? tokenCodec.hashIdempotencyKey(request.idempotencyKey)
          : null,
        lastSectionId: request.lastSectionId,
        draftState: request.draftState,
        expiresAt,
        now: currentIso,
      });
      const response = checkoutResumeUpsertResponseSchema.safeParse({
        contractVersion: CHECKOUT_RESUME_CONTRACT_VERSION,
        resumeToken,
        draft,
      });
      if (!response.success) {
        sendInvalidResponse(res);
        return;
      }

      sendBffSuccess(res, response.data, {
        contractVersion: CHECKOUT_RESUME_CONTRACT_VERSION,
      });
    } catch (error) {
      if (error instanceof CommerceCheckoutResumePersistenceError) {
        sendBffError(res, "UPSTREAM_UNAVAILABLE", "Checkout resume draft failed", {
          details: error.details,
        });
        return;
      }

      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Checkout resume draft failed");
    }
  };
}

export function createCommerceCheckoutResumeReadHandler({
  resumePort,
  tokenCodec,
  now = () => new Date(),
}: CommerceCheckoutResumeHandlerDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, ["GET"]);
      return;
    }

    const token = readSingleQueryValue(req.query.token);
    const parsed = checkoutResumeReadRequestSchema.safeParse({ resumeToken: token });
    if (!parsed.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid checkout resume token", {
        details: parsed.error.flatten(),
      });
      return;
    }

    try {
      const draft = await resumePort.readDraftByTokenHash({
        tokenHash: tokenCodec.hashToken(parsed.data.resumeToken),
        now: now().toISOString(),
      });
      if (!draft) {
        sendBffError(res, "NOT_FOUND", "Checkout resume draft was not found");
        return;
      }

      const response = checkoutResumeReadResponseSchema.safeParse({
        contractVersion: CHECKOUT_RESUME_CONTRACT_VERSION,
        draft,
      });
      if (!response.success) {
        sendInvalidResponse(res);
        return;
      }

      sendBffSuccess(res, response.data, {
        contractVersion: CHECKOUT_RESUME_CONTRACT_VERSION,
      });
    } catch (error) {
      if (error instanceof CommerceCheckoutResumePersistenceError) {
        sendBffError(res, "UPSTREAM_UNAVAILABLE", "Checkout resume draft read failed", {
          details: error.details,
        });
        return;
      }

      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Checkout resume draft read failed");
    }
  };
}

function readSingleQueryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function sendInvalidResponse(res: VercelResponse): void {
  sendBffError(res, "INVALID_RESPONSE", "Checkout resume draft returned invalid response");
}
