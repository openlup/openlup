import type { VercelRequest, VercelResponse } from "../server/_lib/types/vercel.js";
import { readRawBody, WebhookBodyTooLargeError } from "../server/_lib/payment/webhookSignature.js";
import {
  createSupabaseResendWebhookPort,
  type ResendWebhookSupabaseClient,
} from "../server/adapters/supabase/communications/resendWebhookPort.js";
import { createServiceClient, readSupabaseDataGatewayEnv } from "../server/adapters/supabase/dataGatewayClientFactory.js";
import {
  createResendWebhookHandler,
  type ResendWebhookPort,
} from "../server/domains/communications/resendWebhookHandler.js";
import {
  EMAIL_ENVIRONMENT_TAG_NAME,
  resolveEmailEnvironmentTag,
} from "#communications-egress-policy";
import { verifyResendWebhookSignature } from "../server/infra/resend/resendWebhookVerifier.js";

// The raw stream is the security boundary: Svix signs the original request
// bytes, not a framework-parsed JSON representation.
export const config = { api: { bodyParser: false } };

export interface ResendWebhookRouteDeps {
  webhookSecret?: string;
  readRawBody?: (request: VercelRequest) => Promise<string>;
  createPort?: () => ResendWebhookPort;
}

export function createResendWebhookRouteHandler(deps: ResendWebhookRouteDeps = {}) {
  const readBody = deps.readRawBody ?? readRawBody;
  const createPort = deps.createPort ?? createRuntimePort;
  const secret = deps.webhookSecret ?? process.env.RESEND_WEBHOOK_SECRET ?? "";
  const handle = createResendWebhookHandler({
    webhookSecret: secret,
    createPort,
    verifySignature: verifyResendWebhookSignature,
    environmentTagName: EMAIL_ENVIRONMENT_TAG_NAME,
    resolveReceiverEnvironmentTag: () => resolveEmailEnvironmentTag(process.env),
  });

  return async function resendWebhook(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method === "OPTIONS") return send(res, 200, "ok");
    let rawBody: string;
    try {
      rawBody = await readBody(req);
    } catch (error) {
      send(res, error instanceof WebhookBodyTooLargeError ? 413 : 500, { error: String(error) });
      return;
    }
    const result = await handle({
      method: req.method,
      rawBody,
      headers: {
        webhookId: firstHeader(req.headers["svix-id"]),
        timestamp: firstHeader(req.headers["svix-timestamp"]),
        signature: firstHeader(req.headers["svix-signature"]),
      },
    });
    send(res, result.status, result.body);
  };
}

function createRuntimePort(): ResendWebhookPort {
  const env = readSupabaseDataGatewayEnv();
  if (!env) throw new Error("resend_webhook_datastore_not_configured");
  return createSupabaseResendWebhookPort(createServiceClient(env) as ResendWebhookSupabaseClient);
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function send(res: VercelResponse, status: number, body: Record<string, unknown> | "ok"): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "authorization, x-client-info, apikey, content-type");
  if (body === "ok") res.status(status).send(body);
  else res.status(status).json(body);
}

export default createResendWebhookRouteHandler();
