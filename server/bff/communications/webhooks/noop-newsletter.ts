import { withObservedRoute } from "../../../_lib/observability/route.js";
import { readRawBody } from "../../../_lib/payment/webhookSignature.js";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import { sendBffError } from "../../../_lib/bff/response.js";
import { createSupabaseDataGateway } from "../../../adapters/supabase/dataGateway.js";
import {
  readSupabaseDataGatewayEnv,
  type SupabaseDataGatewayEnv,
} from "../../../adapters/supabase/dataGatewayClientFactory.js";
import {
  createNewsletterWebhookHandler,
  type NewsletterWebhookPort,
  type NormalizedNewsletterWebhookEvent,
} from "../../../domains/communications/newsletterWebhookHandler.js";
import { createSupabaseNewsletterWebhookPort } from "../../../adapters/supabase/communications/newsletterWebhookPort.js";
import { verifyNoopNewsletterWebhookSignature } from "../../../infra/noop_newsletter/webhookVerifier.js";
import type { DataGatewayPort } from "../../../../src/domains/platform-runtime/ports.js";

export const config = { api: { bodyParser: false } };

function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!newsletterWebhooksEnabled()) {
    return createNewsletterWebhookHandler({
      providerKind: "noop_newsletter",
      enabled: newsletterWebhooksEnabled,
      verifyAndNormalize: async () => {
        throw new Error("Newsletter webhook disabled");
      },
      port: emptyPort(),
    })(req, res);
  }

  const env = readEnv();
  if (!env) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Newsletter webhook is not configured", {
      details: { feature: "communication-newsletter-webhook", provider: "noop_newsletter" },
    });
    return Promise.resolve();
  }

  const port = createGatewayNewsletterWebhookPort(createSupabaseDataGateway(env.gatewayEnv));

  return createNewsletterWebhookHandler({
    providerKind: "noop_newsletter",
    enabled: newsletterWebhooksEnabled,
    verifyAndNormalize: (request) => verifyAndNormalizeNoopWebhook(request, env.webhookSecret),
    port,
  })(req, res);
}

async function verifyAndNormalizeNoopWebhook(
  req: VercelRequest,
  secret: string,
): Promise<NormalizedNewsletterWebhookEvent> {
  const rawBody = await readRawBody(req);
  if (!verifyNoopNewsletterWebhookSignature({ req, rawBody, secret })) {
    throw new Error("invalid signature");
  }
  const payload = JSON.parse(rawBody) as Record<string, unknown>;
  const eventType = readEventType(payload.type);
  const email = readString(payload.email);
  return {
    providerKind: "noop_newsletter",
    providerEventId: readString(payload.id) ?? `noop:${eventType}:${email ?? "unknown"}`,
    eventType,
    email,
    remoteProfileId: readString(payload.remoteProfileId),
    remoteListId: readString(payload.remoteListId),
    purpose: readPurpose(payload.purpose),
    explicitOptInEvidence: payload.explicitOptInEvidence === true,
    doubleOptInStatus: readDoubleOptInStatus(payload.doubleOptInStatus),
    occurredAt: readString(payload.occurredAt),
    rawPayload: payload,
  };
}

function newsletterWebhooksEnabled(): boolean {
  return process.env.COMMUNICATION_NEWSLETTER_WEBHOOKS_ENABLED === "true";
}

function readEnv(): {
  gatewayEnv: SupabaseDataGatewayEnv;
  webhookSecret: string;
} | null {
  const gatewayEnv = readSupabaseDataGatewayEnv();
  const webhookSecret = process.env.COMMUNICATION_NOOP_NEWSLETTER_WEBHOOK_SECRET;
  return gatewayEnv && webhookSecret
    ? { gatewayEnv, webhookSecret }
    : null;
}

function emptyPort() {
  return {
    async recordProviderEvent(): Promise<never> {
      throw new Error("Newsletter webhook port unavailable");
    },
    async recordPermission(): Promise<never> {
      throw new Error("Newsletter webhook port unavailable");
    },
    async markProviderEvent(): Promise<never> {
      throw new Error("Newsletter webhook port unavailable");
    },
  };
}

function createGatewayNewsletterWebhookPort(gateway: DataGatewayPort): NewsletterWebhookPort {
  let port: NewsletterWebhookPort | null = null;
  async function getPort(): Promise<NewsletterWebhookPort> {
    if (!port) {
      port = await gateway.asService(async (client) =>
        createSupabaseNewsletterWebhookPort(client as never)
      );
    }
    return port;
  }

  return {
    async recordProviderEvent(input) {
      return (await getPort()).recordProviderEvent(input);
    },
    async recordPermission(input) {
      return (await getPort()).recordPermission(input);
    },
    async markProviderEvent(input) {
      return (await getPort()).markProviderEvent(input);
    },
  };
}

function readEventType(value: unknown): NormalizedNewsletterWebhookEvent["eventType"] {
  const raw = readString(value);
  if (
    raw === "subscribe" ||
    raw === "unsubscribe" ||
    raw === "suppress" ||
    raw === "complaint" ||
    raw === "bounce" ||
    raw === "email_change" ||
    raw === "profile_update" ||
    raw === "ignored"
  ) {
    return raw;
  }
  return "ignored";
}

function readPurpose(value: unknown): NormalizedNewsletterWebhookEvent["purpose"] {
  const raw = readString(value);
  if (raw === "marketing_launch_offer" || raw === "marketing_newsletter") return raw;
  return null;
}

function readDoubleOptInStatus(
  value: unknown,
): NormalizedNewsletterWebhookEvent["doubleOptInStatus"] {
  const raw = readString(value);
  if (raw === "confirmed" || raw === "pending") return raw;
  return "unknown";
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export default withObservedRoute({
  route: "/api/bff/communications/webhooks/noop-newsletter",
  domain: "communications",
  surface: "webhook",
  risk: "provider",
}, handler);
