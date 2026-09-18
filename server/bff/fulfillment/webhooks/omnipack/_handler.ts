import type { VercelRequest, VercelResponse } from "../../../../_lib/types/vercel.js";
import { sendBffError } from "../../../../_lib/bff/response.js";
import {
  createOmnipackWebhookHandler,
  verifyOmnipackWebhookToken,
  type OmnipackWebhookRouteEvent,
} from "../../../../domains/fulfillment/omnipackWebhookHandler.js";
import {
  createSupabaseOmnipackWebhookGateway,
  type SupabaseOmnipackWebhookEnv,
} from "../../../../adapters/supabase/omnipackWebhookGateway.js";
import { createSupabaseAccountingInvoicePort } from "../../../../adapters/supabase/accountingInvoicePort.js";
import { readAccountingRuntimeConfig } from "../../../../domains/accounting/accountingRuntimeConfig.js";
import { readAccountingLedgerProviderKind } from "../../../../infra/accounting/providerFactory.js";
import {
  mapOmnipackWebhookPayload,
  sanitizeOmnipackPayload,
} from "../../../../infra/omnipack/mappers.js";

export function createOmnipackWebhookRoute(expectedEvent: OmnipackWebhookRouteEvent) {
  return function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (!omnipackWebhooksEnabled()) {
      return createOmnipackWebhookHandler({
        expectedEvent,
        enabled: omnipackWebhooksEnabled,
        verifyToken: () => false,
        port: emptyPort(),
        parsePayload: (req) => parseOmnipackWebhookPayload(req, expectedEvent),
      })(req, res);
    }

    if (req.method !== "POST") {
      return createOmnipackWebhookHandler({
        expectedEvent,
        enabled: omnipackWebhooksEnabled,
        verifyToken: () => false,
        port: emptyPort(),
        parsePayload: (req) => parseOmnipackWebhookPayload(req, expectedEvent),
      })(req, res);
    }

    const env = readEnv();
    if (!env) {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "OmniPack webhook is not configured", {
        details: { feature: "omnipack-webhook", provider: "omnipack" },
      });
      return Promise.resolve();
    }

    if (!verifyOmnipackWebhookToken(req, env.webhookToken)) {
      return createOmnipackWebhookHandler({
        expectedEvent,
        enabled: omnipackWebhooksEnabled,
        verifyToken: () => false,
        port: emptyPort(),
        parsePayload: (req) => parseOmnipackWebhookPayload(req, expectedEvent),
      })(req, res);
    }

    const accountingConfig = readAccountingRuntimeConfig(process.env);
    const gateway = createSupabaseOmnipackWebhookGateway(env, {
      accountingEnabled: accountingConfig.requestEnabled && accountingConfig.issueTrigger === "handoff",
      accountingPortFactory: (client) => createSupabaseAccountingInvoicePort(client),
      accountingProviderKind: readAccountingLedgerProviderKind(process.env),
    });
    if (!gateway) {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "OmniPack webhook is not configured", {
        details: { feature: "omnipack-webhook", provider: "omnipack" },
      });
      return Promise.resolve();
    }

    return createOmnipackWebhookHandler({
      expectedEvent,
      enabled: omnipackWebhooksEnabled,
      verifyToken: () => true,
      port: gateway.port,
      parsePayload: (req) => parseOmnipackWebhookPayload(req, expectedEvent),
    })(req, res);
  };
}

async function parseOmnipackWebhookPayload(req: VercelRequest, expectedEvent: OmnipackWebhookRouteEvent) {
  const body = req.body;
  return {
    evidence: mapOmnipackWebhookPayload(body, expectedEvent),
    sanitizedPayload: sanitizeOmnipackPayload(asRecord(body)),
  };
}

function omnipackWebhooksEnabled(): boolean {
  return process.env.COMMERCE_OMNIPACK_WEBHOOKS_ENABLED === "true" &&
    process.env.OMNIPACK_PROVIDER_ENABLED === "true";
}

function readEnv(): {
  webhookToken: string;
} & SupabaseOmnipackWebhookEnv | null {
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const webhookToken = process.env.OMNIPACK_WEBHOOK_TOKEN;
  return supabaseUrl && serviceRoleKey && webhookToken
    ? { SUPABASE_URL: supabaseUrl, SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey, webhookToken }
    : null;
}

function emptyPort() {
  return {
    async ingestInboundEvent(): Promise<never> {
      throw new Error("OmniPack webhook port unavailable");
    },
    async findDispatchRef(): Promise<never> {
      throw new Error("OmniPack webhook port unavailable");
    },
    async recordStatusEvidence(): Promise<never> {
      throw new Error("OmniPack webhook port unavailable");
    },
    async recordTrackingReference(): Promise<never> {
      throw new Error("OmniPack webhook port unavailable");
    },
    async markHandedOver(): Promise<never> {
      throw new Error("OmniPack webhook port unavailable");
    },
    async markProviderStockConsumed(): Promise<never> {
      throw new Error("OmniPack webhook port unavailable");
    },
    async markInboundEventProcessed(): Promise<never> {
      throw new Error("OmniPack webhook port unavailable");
    },
  };
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
}
