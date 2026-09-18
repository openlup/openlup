import { resolveResendApiKey } from "../../server/infra/resend/resendApiKey.js";
import { resolveCronEmailBaseUrl, type EmailBaseUrlResult } from "./emailBaseUrl.js";
import { readOrderPaidFulfillmentReadiness } from "./outboxFulfillmentProvider.js";
import { readOutboxMarketingReadiness } from "./outboxMarketingReadiness.js";
import { resolveBundleId } from "../../server/domains/platform-runtime/platformKernel.js";
import { readAccountingRuntimeConfig } from "../../server/domains/accounting/accountingRuntimeConfig.js";
import type { UnsubscribeTarget } from "./unsubscribeFunctionsBaseUrl.js";

type Env = Record<string, string | undefined>;

type ReadyEmailBaseUrl = Extract<EmailBaseUrlResult, { ok: true }>;

export type OutboxHandlerGroup =
  | "transactional_email"
  | "subscription_email"
  | "marketing_email"
  | "fulfillment";

export type ReadyMarketing = {
  enabled: true;
  unsubscribeEndpointUrl: string;
  unsubscribeTarget: UnsubscribeTarget;
};

export type OutboxHandlerGroupReadiness = {
  resend: ReturnType<typeof resolveResendApiKey>;
  emailBaseUrl: ReadyEmailBaseUrl | null;
  marketing: ReadyMarketing | null;
  fulfillmentEnabled: boolean;
  disabledHandlerGroups: Partial<Record<OutboxHandlerGroup, string>>;
  readyGroups: OutboxHandlerGroup[];
  noReadyError: string | null;
};

const MARKETING_FLAGS = [
  "COMMERCE_ABANDONED_CART_ENABLED",
  "COMMERCE_BACK_IN_STOCK_ENABLED",
  "COMMERCE_REORDER_REMINDER_ENABLED",
  "COMMERCE_REVIEW_REQUEST_ENABLED",
] as const;

export function readOutboxHandlerGroupReadiness(env: Env): OutboxHandlerGroupReadiness {
  const disabledHandlerGroups: Partial<Record<OutboxHandlerGroup, string>> = {};
  const readyGroups: OutboxHandlerGroup[] = [];
  const resend = resolveResendApiKey(env);
  const emailBaseUrl = resolveCronEmailBaseUrl(env);
  const emailReady = Boolean(resend.apiKey) && emailBaseUrl.ok;
  const marketingRequested = MARKETING_FLAGS.some((flag) => env[flag] === "true");

  if (emailReady) {
    readyGroups.push("transactional_email", "subscription_email");
  } else {
    const reason = resend.apiKey
      ? emailBaseUrl.ok ? "email_runtime_not_ready" : "error" in emailBaseUrl ? emailBaseUrl.error : "email_runtime_not_ready"
      : "provider_not_configured";
    disabledHandlerGroups.transactional_email = reason;
    disabledHandlerGroups.subscription_email = reason;
  }

  let marketing: ReadyMarketing | null = null;
  if (marketingRequested) {
    const marketingReadiness = readOutboxMarketingReadiness(env);
    if (!emailReady) {
      disabledHandlerGroups.marketing_email = disabledHandlerGroups.transactional_email;
    } else if (!marketingReadiness.ok && "error" in marketingReadiness) {
      disabledHandlerGroups.marketing_email = marketingReadiness.error;
    } else if (marketingReadiness.enabled) {
      marketing = {
        enabled: true,
        unsubscribeEndpointUrl: marketingReadiness.unsubscribeEndpointUrl,
        unsubscribeTarget: marketingReadiness.unsubscribeTarget,
      };
      readyGroups.push("marketing_email");
    }
  }

  const fulfillmentEnabled = env.COMMERCE_FULFILLMENT_AUTO_DISPATCH_ENABLED === "true";
  if (fulfillmentEnabled) {
    const direct = resolveBundleId(env) === "node-postgres";
    const fulfillmentReadiness = direct && !readAccountingRuntimeConfig(env).requestEnabled
      ? { ok: false as const, error: "accounting_request_required" }
      : direct && !env.FULFILLMENT_PORT_KEY?.trim()
        ? { ok: false as const, error: "fulfillment_port_key_required" }
        : readOrderPaidFulfillmentReadiness(env);
    if (fulfillmentReadiness.ok) {
      readyGroups.push("fulfillment");
    } else if ("error" in fulfillmentReadiness) {
      disabledHandlerGroups.fulfillment = fulfillmentReadiness.error;
    }
  }

  return {
    resend,
    emailBaseUrl: emailBaseUrl.ok ? emailBaseUrl : null,
    marketing,
    fulfillmentEnabled,
    disabledHandlerGroups,
    readyGroups,
    noReadyError: readyGroups.length === 0
      ? fulfillmentEnabled
        ? disabledHandlerGroups.fulfillment ?? firstDisabledReason(disabledHandlerGroups)
        : firstDisabledReason(disabledHandlerGroups)
      : null,
  };
}

function firstDisabledReason(groups: Partial<Record<OutboxHandlerGroup, string>>): string {
  return groups.transactional_email ??
    groups.subscription_email ??
    groups.marketing_email ??
    groups.fulfillment ??
    "outbox_no_ready_handler_groups";
}
