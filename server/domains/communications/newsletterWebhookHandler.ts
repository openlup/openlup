import {
  processNewsletterWebhookEvent,
} from "@openlup/platform/communications";
import type { NewsletterWebhookEvent } from "@openlup/platform/communications/contracts";
import { sendBffError, sendBffSuccess, sendMethodNotAllowed } from "../../_lib/bff/response.js";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import type { NewsletterWebhookPort } from "@openlup/platform/communications/contracts";

export { processNewsletterWebhookEvent } from "@openlup/platform/communications";
export type { NewsletterWebhookProcessResult } from "@openlup/platform/communications";
export type { NewsletterWebhookPort, NormalizedNewsletterWebhookEvent, NewsletterWebhookEventType } from "@openlup/platform/communications/contracts";

export interface NewsletterWebhookHandlerDeps {
  providerKind: string;
  enabled: () => boolean;
  verifyAndNormalize: (req: VercelRequest) => Promise<NewsletterWebhookEvent>;
  port: NewsletterWebhookPort;
}

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
