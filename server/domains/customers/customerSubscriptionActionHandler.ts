import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  customerSubscriptionActionResponseSchema,
  customerSubscriptionActionSchema,
} from "../../../src/domains/customers/selfServiceContracts.js";
import type { CustomerUserAuthenticationResult } from "./customerAuth.js";
import type { CustomerSubscriptionActionPort } from "./ports.js";

/**
 * Validates a cancel-survey object (present on `pause`/`cancel` actions) — the
 * generic contract validates the survey *shape*, and this injected schema enforces
 * that `reasonCode` is a member of the vertical-supplied taxonomy (E10). Optional so
 * unit tests that do not exercise the survey path can omit it; the production BFF
 * composition always supplies it via `createCancelSurveySchema(...)`.
 */
export interface CancelSurveyMembershipSchema {
  safeParse: (value: unknown) => { success: boolean; error?: { flatten: () => unknown } };
}

export interface CustomerSubscriptionActionDeps {
  subscriptionActionPort: CustomerSubscriptionActionPort;
  authenticateUser: (req: VercelRequest) => Promise<CustomerUserAuthenticationResult>;
  cancelSurveySchema?: CancelSurveyMembershipSchema;
}

export function createCustomerSubscriptionActionHandler({
  subscriptionActionPort,
  authenticateUser,
  cancelSurveySchema,
}: CustomerSubscriptionActionDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "POST") {
      sendMethodNotAllowed(res, ["POST"]);
      return;
    }

    let authentication: CustomerUserAuthenticationResult;
    try {
      authentication = await authenticateUser(req);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Customer authentication failed");
      return;
    }

    if (authentication.ok === false) {
      sendBffError(res, authentication.code, authentication.message);
      return;
    }

    const request = customerSubscriptionActionSchema.safeParse(req.body);
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid customer subscription action request", {
        details: request.error.flatten(),
      });
      return;
    }

    // The generic contract validated the survey shape; enforce reason-code membership
    // against the vertical-supplied taxonomy injected at composition (E10).
    const survey = (request.data as { survey?: unknown }).survey;
    if (cancelSurveySchema && survey !== undefined) {
      const surveyCheck = cancelSurveySchema.safeParse(survey);
      if (!surveyCheck.success) {
        sendBffError(res, "BAD_REQUEST", "Invalid customer subscription action request", {
          details: surveyCheck.error?.flatten(),
        });
        return;
      }
    }

    try {
      const result = await subscriptionActionPort.applyAction(authentication.userId, request.data);
      if (!result) {
        sendBffError(res, "FORBIDDEN", "No customer account linked to this session");
        return;
      }

      const response = customerSubscriptionActionResponseSchema.safeParse(result);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Customer subscription action returned invalid response");
        return;
      }

      sendBffSuccess(res, response.data);
    } catch (error) {
      if (error instanceof CustomerSubscriptionActionConflictError) {
        sendBffError(res, error.code, error.message, { details: error.details });
        return;
      }
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Customer subscription action failed");
    }
  };
}

export class CustomerSubscriptionActionConflictError extends Error {
  constructor(
    public readonly code: "CONFLICT" | "BAD_REQUEST" | "FORBIDDEN",
    message: string,
    // Machine-readable cause forwarded verbatim onto the BFF error envelope's
    // `details`. Error bodies are NOT parsed against a data schema by clients
    // (`BffClientError` exposes `details: unknown`), so adding it is
    // contract-safe; `message` stays unchanged for anything pinning it.
    public readonly details?: unknown,
  ) {
    super(message);
  }
}
