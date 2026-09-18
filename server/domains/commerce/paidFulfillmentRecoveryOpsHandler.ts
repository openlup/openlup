import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { sendBffError, sendBffSuccess, sendMethodNotAllowed } from "../../_lib/bff/response.js";
import { COMMERCE_CONTRACT_VERSION } from "../../../src/domains/commerce/types.js";
import {
  adminPaidFulfillmentRecoveryExecuteResponseSchema,
  adminPaidFulfillmentRecoveryPreviewResponseSchema,
  adminPaidFulfillmentRecoveryRequestSchema,
  type AdminPaidFulfillmentRecoveryExecuteRequest,
  type AdminPaidFulfillmentRecoveryPreviewRequest,
  type AdminPaidFulfillmentRecoveryPreviewResponse,
} from "../../../src/domains/commerce/recoveryOpsContracts.js";
import type {
  PaidFulfillmentDispatchRefRow,
  PaidFulfillmentOrderEvidenceRow,
  PaidFulfillmentOrderRow,
  PaidFulfillmentOutboxEventRow,
} from "./paidFulfillmentRecovery.js";
import {
  collectPaidFulfillmentRecoveryCandidates,
} from "./paidFulfillmentRecovery.js";
import type { AdminAuthResult, BaseDeps } from "./commerceOmsHandlers.js";

export interface PaidFulfillmentRecoveryReadPort {
  readRecoveryInputs(input: {
    minimumAgeSeconds: number;
    limit: number;
    now: Date;
    orderIds?: string[];
  }): Promise<{
    orders: PaidFulfillmentOrderRow[];
    fulfillmentOrders: PaidFulfillmentOrderEvidenceRow[];
    omnipackDispatchRefs?: PaidFulfillmentDispatchRefRow[];
    orderPaidOutboxEvents: PaidFulfillmentOutboxEventRow[];
  }>;
}

export interface PaidFulfillmentRecoveryExecutePort {
  requeueDiscardedOrderPaidOutboxEvents(input: {
    eventIds: string[];
    requeuedBy: string;
    reason: string;
    limit?: number;
  }): Promise<{ requeuedCount: number; eventIds: string[] }>;
}

export type PaidFulfillmentRecoveryOpsPort =
  & PaidFulfillmentRecoveryReadPort
  & PaidFulfillmentRecoveryExecutePort;

export function createAdminPaidFulfillmentRecoveryOpsHandler({
  authorizeAdmin,
  recoveryPort,
  mutationsEnabled,
  now = () => new Date(),
}: BaseDeps & {
  recoveryPort: PaidFulfillmentRecoveryOpsPort;
  mutationsEnabled: () => boolean;
  now?: () => Date;
}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
    const auth = await authorizeRecoveryAdmin(req, res, authorizeAdmin);
    if (!auth) return;

    const request = adminPaidFulfillmentRecoveryRequestSchema.safeParse(req.body ?? {});
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid paid fulfillment recovery request", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      if (request.data.operation === "preview") {
        await sendPreview(res, recoveryPort, request.data, now());
        return;
      }
      if (!mutationsEnabled()) {
        sendBffError(res, "FORBIDDEN", "Paid fulfillment recovery mutations are not enabled");
        return;
      }
      await sendExecute(res, recoveryPort, request.data, auth.userId, now());
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Paid fulfillment recovery operation failed");
    }
  };
}

async function authorizeRecoveryAdmin(
  req: VercelRequest,
  res: VercelResponse,
  authorizeAdmin: (req: VercelRequest) => Promise<AdminAuthResult>,
): Promise<{ userId: string } | null> {
  const auth = await authorizeAdmin(req);
  if (auth.ok === false) {
    sendBffError(res, auth.code, auth.message);
    return null;
  }
  return { userId: auth.userId };
}

async function sendPreview(
  res: VercelResponse,
  recoveryPort: PaidFulfillmentRecoveryReadPort,
  request: AdminPaidFulfillmentRecoveryPreviewRequest,
  now: Date,
): Promise<void> {
  const input = await recoveryPort.readRecoveryInputs({
    minimumAgeSeconds: request.minimumAgeSeconds,
    limit: request.limit,
    now,
    orderIds: request.orderIds,
  });
  const plan = collectPaidFulfillmentRecoveryCandidates({
    ...input,
    now,
    minimumAgeSeconds: request.minimumAgeSeconds,
  });
  const response: AdminPaidFulfillmentRecoveryPreviewResponse = {
    contractVersion: COMMERCE_CONTRACT_VERSION,
    checkedOrders: plan.checkedOrders,
    candidates: plan.candidates.slice(0, request.limit),
  };
  const parsed = adminPaidFulfillmentRecoveryPreviewResponseSchema.safeParse(response);
  if (!parsed.success) {
    sendBffError(res, "INVALID_RESPONSE", "Paid fulfillment recovery preview returned invalid response");
    return;
  }
  sendBffSuccess(res, parsed.data);
}

async function sendExecute(
  res: VercelResponse,
  recoveryPort: PaidFulfillmentRecoveryOpsPort,
  request: AdminPaidFulfillmentRecoveryExecuteRequest,
  actorUserId: string,
  now: Date,
): Promise<void> {
  const input = await recoveryPort.readRecoveryInputs({
    minimumAgeSeconds: request.minimumAgeSeconds,
    limit: 100,
    now,
    orderIds: request.orderIds,
  });
  const currentPlan = collectPaidFulfillmentRecoveryCandidates({
    ...input,
    now,
    minimumAgeSeconds: request.minimumAgeSeconds,
  });
  const safeEventIds = new Set(
    currentPlan.candidates
      .filter((candidate) =>
        candidate.recommendedAction === "requeue_discarded_order_paid_outbox"
        && candidate.recoveryPosture === "automatic_local_requeue_safe"
        && candidate.reason === "order_paid_outbox_discarded"
        && candidate.fulfillmentOrderId === null
        && candidate.outboxEventId
      )
      .map((candidate) => candidate.outboxEventId as string),
  );
  const unsafeEventIds = request.eventIds.filter((eventId) => !safeEventIds.has(eventId));
  if (unsafeEventIds.length > 0) {
    sendBffError(res, "CONFLICT", "Paid fulfillment recovery state is no longer safe for local requeue", {
      details: { unsafeEventIds },
    });
    return;
  }
  const result = await recoveryPort.requeueDiscardedOrderPaidOutboxEvents({
    eventIds: request.eventIds,
    requeuedBy: actorUserId,
    reason: request.reason,
    limit: request.eventIds.length,
  });
  const response = adminPaidFulfillmentRecoveryExecuteResponseSchema.safeParse({
    contractVersion: COMMERCE_CONTRACT_VERSION,
    action: request.action,
    ...result,
  });
  if (!response.success) {
    sendBffError(res, "INVALID_RESPONSE", "Paid fulfillment recovery execute returned invalid response");
    return;
  }
  sendBffSuccess(res, response.data);
}
