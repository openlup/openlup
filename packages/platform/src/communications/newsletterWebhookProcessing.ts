import type { NewsletterMarketingPurpose, NewsletterWebhookEvent } from "./contracts/newsletter.js";
import type { NewsletterWebhookPort } from "./contracts/newsletterWebhook.js";
import type { CommunicationPurposeRegistry } from "./contracts/consent.js";

export interface NewsletterWebhookProcessResult {
  provider: string;
  providerEventId: string;
  replayed?: boolean;
  status?: "processed" | "ignored";
  reason?: string;
  localState?: "granted" | "suppressed";
}

const MARKETING_PURPOSES = ["marketing_launch_offer", "marketing_newsletter"] as const;

export async function processNewsletterWebhookEvent<Purpose extends string = NewsletterMarketingPurpose>(input: {
  providerKind: string;
  event: NewsletterWebhookEvent<Purpose>;
  port: NewsletterWebhookPort<Purpose | NewsletterMarketingPurpose>;
  registry?: CommunicationPurposeRegistry<Purpose>;
}): Promise<NewsletterWebhookProcessResult> {
  const { providerKind, event, port } = input;
  if (input.registry && event.purpose !== null && !input.registry.has(event.purpose)) {
    throw new Error("unregistered_communication_purpose");
  }
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

function localAction<Purpose extends string>(
  event: NewsletterWebhookEvent<Purpose>,
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
