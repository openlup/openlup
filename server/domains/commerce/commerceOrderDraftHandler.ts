import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  createOrderDraftRequestSchema,
  createOrderDraftResponseSchema,
  type CreateQuoteResponse,
} from "../../../src/domains/commerce/contracts.js";
import { COMMERCE_CONTRACT_VERSION } from "../../../src/domains/commerce/types.js";
import {
  CommerceNotEnabledError,
  CommerceOrderDraftConflictError,
  CommerceOrderDraftInvalidResponseError,
  CommerceOrderDraftPriceChangedError,
  CommerceOrderDraftUnsupportedMoneyError,
  CommerceOrderDraftPersistenceError,
  CommerceQuoteSnapshotError,
  type CommerceOrderDraftWritePort,
  type CommerceQuoteSnapshotVerifierPort,
} from "../../../src/domains/commerce/ports.js";
import { projectPublicQuoteSnapshot } from "./catalogFactsProvenance.js";

export interface CommerceOrderDraftHandlerDeps {
  orderDraftPort: CommerceOrderDraftWritePort;
  quoteSnapshotVerifier: CommerceQuoteSnapshotVerifierPort;
}

export function createCommerceOrderDraftHandler({
  orderDraftPort,
  quoteSnapshotVerifier,
}: CommerceOrderDraftHandlerDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "POST") {
      sendMethodNotAllowed(res, ["POST"]);
      return;
    }

    const request = createOrderDraftRequestSchema.safeParse(req.body);
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid commerce order draft request", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      const verified = await quoteSnapshotVerifier.verifyQuoteSnapshot(request.data.quoteSnapshot);
      const quoteSnapshot = isVerifiedQuoteSnapshot(verified) ? verified : request.data.quoteSnapshot;
      const orderDraft = await orderDraftPort.createOrderDraft({ ...request.data, quoteSnapshot });
      const response = createOrderDraftResponseSchema.safeParse(orderDraft);
      if (!response.success) {
        sendInvalidResponse(res);
        return;
      }

      sendBffSuccess(res, {
        ...response.data,
        orderDraft: {
          ...response.data.orderDraft,
          quoteSnapshot: projectPublicQuoteSnapshot(response.data.orderDraft.quoteSnapshot),
        },
      }, {
        contractVersion: COMMERCE_CONTRACT_VERSION,
      });
    } catch (error) {
      if (error instanceof CommerceNotEnabledError) {
        sendBffError(
          res,
          "UPSTREAM_UNAVAILABLE",
          "Commerce order draft persistence is not configured",
          {
            details: {
              feature: "order_draft",
              requiredBoundary: "commerce_create_order_draft_with_outbox",
            },
          },
        );
        return;
      }

      if (error instanceof CommerceOrderDraftConflictError) {
        sendBffError(res, "CONFLICT", error.message, {
          details: error.details,
        });
        return;
      }

      if (error instanceof CommerceOrderDraftPriceChangedError) {
        sendBffError(res, "CONFLICT", error.message, {
          details: error.details,
        });
        return;
      }

      if (error instanceof CommerceOrderDraftUnsupportedMoneyError) {
        sendBffError(res, "CONFLICT", error.message, {
          details: { reason: error.reason },
        });
        return;
      }

      if (error instanceof CommerceOrderDraftInvalidResponseError) {
        sendInvalidResponse(res);
        return;
      }

      if (error instanceof CommerceQuoteSnapshotError) {
        sendBffError(res, "BAD_REQUEST", error.message, {
          details: {
            code: error.code,
            ...error.details,
          },
        });
        return;
      }

      if (error instanceof CommerceOrderDraftPersistenceError) {
        sendBffError(res, "UPSTREAM_UNAVAILABLE", "Commerce order draft failed");
        return;
      }

      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Commerce order draft failed");
    }
  };
}

function isVerifiedQuoteSnapshot(
  value: CreateQuoteResponse | void,
): value is CreateQuoteResponse {
  return value !== undefined;
}

function sendInvalidResponse(res: VercelResponse): void {
  sendBffError(res, "INVALID_RESPONSE", "Commerce order draft returned invalid response");
}
