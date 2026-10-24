import { adminCommerceOrderRequestReplacementShipmentRequestSchema, adminCommerceOrderRequestReplacementShipmentResponseSchema } from './handlerSchemas.js';
import { authorize, CommerceFulfillmentConflictError, isNativeUnsupported, type BaseDeps, type FulfillmentHandlerRequest, type FulfillmentHandlerResponder } from './handlerSupport.js';
import type { FulfillmentReplacementPort } from './contracts/replacement.js';
export function createAdminCommerceOrderRequestReplacementShipmentHandler<Response>({
  authorizeAdmin,
  respond,
  omsPort,
}: BaseDeps<Response> & {
  omsPort: FulfillmentReplacementPort;
}) {
  const { sendMethodNotAllowed } = respond;
  return async function handler(req: FulfillmentHandlerRequest, res: Response): Promise<void> {
    if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
    const auth = await authorize(req, res, authorizeAdmin, respond);
    if (!auth) return;

    const request = parseOmsRequest(res, respond, adminCommerceOrderRequestReplacementShipmentRequestSchema, req.body ?? {}, "Invalid admin commerce replacement shipment request");
    if (request === undefined) return;

    await sendOmsMutationResponse(
      res,
      respond,
      () => omsPort.requestReplacementShipment({ ...request, actorUserId: auth.userId }),
      adminCommerceOrderRequestReplacementShipmentResponseSchema,
      "Admin commerce replacement shipment returned invalid response",
      "Admin commerce replacement shipment failed",
    );
  };
}

function parseOmsRequest<Response, T>(res: Response, respond: FulfillmentHandlerResponder<Response>, schema: { safeParse(input: unknown): { success: true; data: T } | { success: false; error: { flatten(): unknown } } }, input: unknown, message: string): T | undefined {
  const request = schema.safeParse(input);
  if (!request.success) { respond.sendBffError(res, 'BAD_REQUEST', message, { details: request.error.flatten() }); return undefined; }
  return request.data;
}
async function sendOmsMutationResponse<Response>(res: Response, respond: FulfillmentHandlerResponder<Response>, action: () => Promise<unknown>, schema: typeof adminCommerceOrderRequestReplacementShipmentResponseSchema, invalidMessage: string, failureMessage: string) {
  try {
    const result = await action();
    if (isNativeUnsupported(result)) { respond.sendBffError(res, 'UPSTREAM_UNAVAILABLE', 'Native fulfillment operation unsupported', { details: result }); return; }
    const response = schema.safeParse(result);
    if (!response.success) { respond.sendBffError(res, 'INVALID_RESPONSE', invalidMessage); return; }
    respond.sendBffSuccess(res, response.data);
  } catch (error) {
    if (error instanceof CommerceFulfillmentConflictError) { respond.sendBffError(res, 'CONFLICT', error.message, { details: error.details }); return; }
    respond.sendBffError(res, 'UPSTREAM_UNAVAILABLE', failureMessage);
  }
}
