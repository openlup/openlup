import { sendBffError, sendMethodNotAllowed } from "../../../_lib/bff/response.js";
import { withObservedRoute } from "../../../_lib/observability/route.js";
import { readRawBody, WebhookBodyTooLargeError } from "../../../_lib/payment/webhookSignature.js";
import type { HttpRequest, HttpResponse } from "../../../_lib/types/http.js";
import {
  COMMUNICATION_INTEGRATION_SIGNATURE_HEADER,
  COMMUNICATION_INTEGRATION_TIMESTAMP_HEADER,
  verifyCommunicationIntegrationEventSignature,
} from "../../../infra/communications/integrationEventSignature.js";
import { handleAcquisitionNewsletterConsent } from "./acquisitionEvidenceDirect.js";

export const config = { api: { bodyParser: false } };

async function handler(req: HttpRequest, res: HttpResponse): Promise<void> {
  if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
  const secret = process.env.COMMUNICATION_INTEGRATIONS_EVENTS_SECRET;
  if (!secret) return sendBffError(res, "UPSTREAM_UNAVAILABLE", "Acquisition consent is not configured");

  let rawBody: string;
  try {
    rawBody = await readRawBody(req);
  } catch (error) {
    return sendBffError(res, "BAD_REQUEST", error instanceof WebhookBodyTooLargeError
      ? "Acquisition consent body is too large" : "Acquisition consent body is invalid");
  }
  if (!verifyCommunicationIntegrationEventSignature({
    rawBody,
    signatureHeader: firstHeader(req.headers[COMMUNICATION_INTEGRATION_SIGNATURE_HEADER]),
    timestampHeader: firstHeader(req.headers[COMMUNICATION_INTEGRATION_TIMESTAMP_HEADER]),
    secret,
  })) return sendBffError(res, "FORBIDDEN", "Acquisition consent signature is invalid");

  let body: unknown;
  try { body = JSON.parse(rawBody); }
  catch { return sendBffError(res, "BAD_REQUEST", "Acquisition consent body is invalid"); }
  return handleAcquisitionNewsletterConsent(body, res);
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default withObservedRoute({
  route: "/api/bff/marketing/research/newsletter-consent",
  domain: "marketing",
  surface: "public",
  risk: "validation_mutation",
}, handler);
