import {
CommerceFulfillmentConflictError as PackageConflictError,
createAdminCommerceFulfillmentOrdersListHandler,
} from "@openlup/platform/fulfillment";
import type { FulfillmentReplacementPort } from "@openlup/platform/fulfillment/contracts";
import { CommerceOmsConflictError,type CommerceOmsHoldPort } from "../../../src/domains/commerce/omsPorts.js";
import { sendBffError,sendBffSuccess,sendMethodNotAllowed } from "../../_lib/bff/response.js";
import type { VercelRequest,VercelResponse } from "../../_lib/types/vercel.js";

type PackageHandler = ReturnType<typeof createAdminCommerceFulfillmentOrdersListHandler<VercelResponse>>;
export const fulfillmentResponder = { sendBffError, sendBffSuccess, sendMethodNotAllowed };

/** Capture the actual Vercel request, including auth headers, per invocation. */
export function bindManagedHandler<Auth>(
  create: (authorizeOriginalRequest: () => Promise<Auth>) => PackageHandler,
  authorizeAdmin: (req: VercelRequest) => Promise<Auth>,
): (req: VercelRequest, res: VercelResponse) => Promise<void> {
  return (req, res) => create(() => authorizeAdmin(req))(req, res);
}

/** Only the seam's own private conflict crosses the package handler boundary. */
export async function withManagedConflict<Result>(
  action: () => Promise<Result>,
  Conflict: typeof CommerceOmsConflictError,
): Promise<Result> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof Conflict) {
      throw new PackageConflictError(error.message, error.details);
    }
    throw error;
  }
}

/** G18 remains one atomic managed transaction, on the incumbent receiver. */
export function managedReplacementPort(
  port: Pick<CommerceOmsHoldPort, "requestReplacementShipment">,
): FulfillmentReplacementPort {
  return {
    // Host Zod DTOs infer nullable fields as optional in the node compiler.
    // Forward the exact result; the package handler owns response validation.
    requestReplacementShipment: async input => await withManagedConflict(
      () => port.requestReplacementShipment(input), CommerceOmsConflictError,
    ) as Awaited<ReturnType<FulfillmentReplacementPort["requestReplacementShipment"]>>,
  };
}
