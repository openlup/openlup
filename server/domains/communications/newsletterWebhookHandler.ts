import type {
  NewsletterMarketingPurpose,
  NewsletterWebhookEvent,
  NewsletterWebhookEventType,
} from "../../../src/domains/communications/newsletterIntegrationContracts.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";

export type { NewsletterWebhookEventType };
export type NormalizedNewsletterWebhookEvent = NewsletterWebhookEvent;

export interface NewsletterWebhookPort {
  recordProviderEvent(input: NewsletterWebhookEvent & {
    state: "unknown" | "granted" | "denied" | "suppressed" | null;
    processingStatus: "received" | "ignored";
  }): Promise<{ providerEventId: string; contactId: string | null; inserted: boolean }>;
  recordPermission(input: {
    contactId: string;
    providerKind: string;
    providerEventId: string;
    purpose: NewsletterMarketingPurpose;
    state: "granted" | "suppressed";
    reason: string;
    metadata: Record<string, unknown>;
  }): Promise<void>;
  markProviderEvent(input: {
    providerEventId: string;
    status: "processed" | "ignored" | "failed";
    metadata: Record<string, unknown>;
  }): Promise<void>;
}

export interface NewsletterWebhookHandlerDeps {
  providerKind: string;
  enabled: () => boolean;
  verifyAndNormalize: (req: VercelRequest) => Promise<NewsletterWebhookEvent>;
  port: NewsletterWebhookPort;
}

export interface NewsletterWebhookProcessResult {
  provider: string;
  providerEventId: string;
  replayed?: boolean;
  status?: "processed" | "ignored";
  reason?: string;
  localState?: "granted" | "suppressed";
}

const MARKETING_PURPOSES = ["marketing_launch_offer", "marketing_newsletter"] as const;

export function createNewsletterWebhookHandler({
  providerKind,
  enabled,
  verifyAndNormalize,
  port,
}: NewsletterWebhookHandlerDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
    if (!enabled()) {
      sendBffError(res, "FORBIDDEN", "Newsletter webhooks are disabled", {
        details: { provider: providerKind, reason: "feature_flag_disabled" },
      });
      return;
    }

    let event: NewsletterWebhookEvent;
    try {
      event = await verifyAndNormalize(req);
    } catch {
      sendBffError(res, "BAD_REQUEST", "Invalid newsletter webhook signature or payload");
      return;
    }

    if (event.providerKind !== providerKind) {
      sendBffError(res, "BAD_REQUEST", "Newsletter webhook route mismatch");
      return;
    }

    sendBffSuccess(res, await processNewsletterWebhookEvent({ providerKind, event, port }));
  };
}

export async function processNewsletterWebhookEvent(input: {
  providerKind: string;
  event: NewsletterWebhookEvent;
  port: NewsletterWebhookPort;
}): Promise<NewsletterWebhookProcessResult> {
  const { providerKind, event, port } = input;
  const action = localAction(event);
  const providerEvent = await port.recordProviderEvent({
    ...event,
    state: action.state,
    processingStatus: action.kind === "ignore" ? "ignored" : "received",
  });

  if (!providerEvent.inserted) {
    return { provider: providerKind, providerEventId: event.providerEventId, replayed: true };
  }

  if (action.kind === "ignore" || !providerEvent.contactId) {
    await port.markProviderEvent({
      providerEventId: providerEvent.providerEventId,
      status: "ignored",
      metadata: { reason: action.reason },
    });
    return {
      provider: providerKind,
      providerEventId: event.providerEventId,
      status: "ignored",
      reason: action.reason,
    };
  }

  for (const purpose of event.purpose ? [event.purpose] : MARKETING_PURPOSES) {
    await port.recordPermission({
      contactId: providerEvent.contactId,
      providerKind,
      providerEventId: event.providerEventId,
      purpose,
      state: action.state,
      reason: action.reason,
      metadata: {
        source: "newsletter_provider_webhook",
        providerKind,
        providerEventId: event.providerEventId,
        remoteProfileId: event.remoteProfileId,
        remoteListId: event.remoteListId,
        doubleOptInStatus: event.doubleOptInStatus,
        explicitOptInEvidence: event.explicitOptInEvidence,
      },
    });
  }

  await port.markProviderEvent({
    providerEventId: providerEvent.providerEventId,
    status: "processed",
    metadata: { localState: action.state, reason: action.reason },
  });

  return {
    provider: providerKind,
    providerEventId: event.providerEventId,
    status: "processed",
    localState: action.state,
  };
}

function localAction(
  event: NewsletterWebhookEvent,
): { kind: "apply"; state: "granted" | "suppressed"; reason: string } | {
  kind: "ignore";
  state: null;
  reason: string;
} {
  if (["unsubscribe", "suppress", "complaint"].includes(event.eventType)) {
    return { kind: "apply", state: "suppressed", reason: `provider_${event.eventType}` };
  }
  if (event.eventType === "subscribe") {
    if (event.explicitOptInEvidence || event.doubleOptInStatus === "confirmed") {
      return { kind: "apply", state: "granted", reason: "provider_verified_opt_in" };
    }
    return { kind: "ignore", state: null, reason: "provider_subscribe_without_verified_opt_in" };
  }
  return { kind: "ignore", state: null, reason: "provider_event_not_permission_mutating" };
}
