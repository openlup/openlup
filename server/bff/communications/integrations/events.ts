import { sendBffError, sendBffSuccess, sendMethodNotAllowed } from "../../../_lib/bff/response.js";
import { withObservedRoute } from "../../../_lib/observability/route.js";
import { readRawBody, WebhookBodyTooLargeError } from "../../../_lib/payment/webhookSignature.js";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import { createSupabaseDataGateway } from "../../../adapters/supabase/dataGateway.js";
import {
  readSupabaseDataGatewayEnv,
} from "../../../adapters/supabase/dataGatewayClientFactory.js";
import { processNewsletterWebhookEvent } from "../../../domains/communications/newsletterWebhookHandler.js";
import { createSupabaseNewsletterWebhookPort } from "../../../adapters/supabase/communications/newsletterWebhookPort.js";
import {
  COMMUNICATION_INTEGRATION_SIGNATURE_HEADER,
  COMMUNICATION_INTEGRATION_TIMESTAMP_HEADER,
  verifyCommunicationIntegrationEventSignature,
} from "../../../infra/communications/integrationEventSignature.js";
import {
  canonicalNewsletterWebhookEventSchema,
  normalizeCanonicalNewsletterWebhookEvent,
} from "../../../../src/domains/communications/newsletterIntegrationContracts.js";

export const config = { api: { bodyParser: false } };

async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
  const integrationSecret = process.env.COMMUNICATION_INTEGRATIONS_EVENTS_SECRET;
  if (!integrationSecret) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Communication integrations are not configured");
    return;
  }

  let rawBody: string;
  try {
    rawBody = await readRawBody(req);
  } catch (error) {
    sendBffError(
      res,
      "BAD_REQUEST",
      error instanceof WebhookBodyTooLargeError
        ? "Communication integration event body is too large"
        : "Communication integration event body is invalid",
    );
    return;
  }

  if (!verifyCommunicationIntegrationEventSignature({
    rawBody,
    signatureHeader: firstHeader(req.headers[COMMUNICATION_INTEGRATION_SIGNATURE_HEADER]),
    timestampHeader: firstHeader(req.headers[COMMUNICATION_INTEGRATION_TIMESTAMP_HEADER]),
    secret: integrationSecret,
  })) {
    sendBffError(res, "FORBIDDEN", "Communication integration event signature is invalid");
    return;
  }

  const gatewayEnv = readSupabaseDataGatewayEnv();
  if (!gatewayEnv) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Communication integrations are not configured");
    return;
  }

  const parsedJson = parseJson(rawBody);
  if (parsedJson.ok === false) {
    sendBffError(res, "BAD_REQUEST", "Invalid communication integration event", {
      details: parsedJson.error,
    });
    return;
  }

  const parsed = canonicalNewsletterWebhookEventSchema.safeParse(parsedJson.value);
  if (!parsed.success) {
    sendBffError(res, "BAD_REQUEST", "Invalid communication integration event", {
      details: parsed.error.flatten(),
    });
    return;
  }

  const event = {
    ...normalizeCanonicalNewsletterWebhookEvent(parsed.data),
    rawPayload: parsed.data.payload ?? (isRecord(parsedJson.value) ? parsedJson.value : {}),
  };
  const gateway = createSupabaseDataGateway(gatewayEnv);

  return gateway.asService(async (client) => {
    sendBffSuccess(res, await processNewsletterWebhookEvent({
      providerKind: event.providerKind,
      event,
      port: createSupabaseNewsletterWebhookPort(client as never),
    }));
  });
}

function parseJson(rawBody: string): { ok: true; value: unknown } | {
  ok: false;
  error: Record<string, unknown>;
} {
  try {
    return { ok: true, value: JSON.parse(rawBody) };
  } catch {
    return { ok: false, error: { formErrors: ["Invalid JSON"] } };
  }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export default withObservedRoute({
  route: "/api/bff/communications/integrations/events",
  domain: "communications",
  surface: "webhook",
  risk: "provider",
}, handler);
