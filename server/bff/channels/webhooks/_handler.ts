import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import { sendBffError } from "../../../_lib/bff/response.js";
import { readRawBody, timingSafeStringEqual } from "../../../_lib/payment/webhookSignature.js";
import { noopSettlementAllowed } from "../../../_lib/observability/environment.js";
import {
  createChannelWebhookHandler,
  emptyChannelWebhookPort,
} from "../../../domains/channels/channelWebhookHandler.js";
import type { ChannelOrderSourcePort } from "../../../../src/domains/channels/ports.js";
import { PLATFORM_ACCEPTED_CURRENCIES } from "../../../../src/lib/currency/platformCurrency.js";
import {
  createChannelWebhookPort,
  resolveChannelOrderSource,
} from "../../../runtime/channelIngest/channelIngestComposition.js";
import { resolveChannelIngestStoreBinding } from "../../../runtime/channelIngest/channelIngestStoreBinding.js";

// The one channel-webhook route shape, parameterised by connector kind.
//
// This factory exists because the SECOND connector is the whole point of the port: a route per
// connector that each re-derived the guard order would be four chances to get the order wrong. It
// is a factory rather than a shared mutable router precisely so each connector still has its own
// mounted path, its own metadata row and its own catalogue entrypoint.
//
// EVERY FAILURE PATH GOES THROUGH THE SAME HANDLER WITH A FAIL-CLOSED PORT, exactly as the OmniPack
// route does. The empty port is not decoration: it means a delivery that arrives while the feature
// is off, on the wrong method, or without a token is answered by code that physically cannot write,
// so a future edit that mis-orders a guard degrades into a thrown error rather than a silent write.

const FAIL_CLOSED_CONNECTOR: Pick<ChannelOrderSourcePort, "normalizeWebhook"> = {
  async normalizeWebhook() {
    throw new Error("channel_webhook_connector_unavailable");
  },
};

export function createChannelWebhookRoute(connectorKind: string) {
  return function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (!channelIngestWebhookEnabled()) return failClosed(connectorKind)(req, res);
    if (req.method !== "POST") return failClosed(connectorKind)(req, res);

    const webhookToken = process.env.CHANNEL_WEBHOOK_TOKEN;
    if (!webhookToken) {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Channel webhook is not configured", {
        details: { feature: "channel-ingest-webhook", connectorKind, reason: "webhook_token_required" },
      });
      return Promise.resolve();
    }
    if (!verifyChannelWebhookToken(req, webhookToken)) return failClosed(connectorKind)(req, res);

    // A simulator is admitted only where a simulated settlement may be believed. The registry
    // refuses it again on the way out, so this is the first of two independent checks.
    const simulatorAllowed = noopSettlementAllowed(process.env);
    let connector: ChannelOrderSourcePort;
    try {
      connector = resolveChannelOrderSource(connectorKind, simulatorAllowed);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Channel connector is not available here", {
        details: { feature: "channel-ingest-webhook", connectorKind, reason: "connector_unavailable" },
      });
      return Promise.resolve();
    }

    const resolution = resolveChannelIngestStoreBinding(process.env);
    if (!resolution.binding) {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Channel ingest store is not configured", {
        details: { feature: "channel-ingest-webhook", connectorKind, reason: resolution.error },
      });
      return Promise.resolve();
    }

    return resolution.binding.run((context) =>
      createChannelWebhookHandler({
        connectorKind,
        enabled: channelIngestWebhookEnabled,
        verifyToken: () => true,
        connector,
        port: createChannelWebhookPort({
          store: context.store,
          channels: context.channels,
          rails: context.rails,
          acceptedCurrencies: PLATFORM_ACCEPTED_CURRENCIES,
          noopSettlementForbidden: !simulatorAllowed,
        }),
        readRawBody,
      })(req, res),
    );
  };
}

function failClosed(connectorKind: string) {
  return createChannelWebhookHandler({
    connectorKind,
    enabled: channelIngestWebhookEnabled,
    verifyToken: () => false,
    connector: FAIL_CLOSED_CONNECTOR,
    port: emptyChannelWebhookPort(),
    readRawBody: async () => "",
  });
}

export function channelIngestWebhookEnabled(): boolean {
  return process.env.CHANNEL_INGEST_WEBHOOK_ENABLED === "true";
}

/** Bearer or bare header, compared in constant time, and false whenever no token is configured. */
export function verifyChannelWebhookToken(req: VercelRequest, expectedToken: string | undefined): boolean {
  if (!expectedToken) return false;
  const authorization = readHeader(req, "authorization");
  if (timingSafeStringEqual(authorization ?? "", `Bearer ${expectedToken}`)) return true;
  return timingSafeStringEqual(readHeader(req, "x-channel-webhook-token") ?? "", expectedToken);
}

function readHeader(req: VercelRequest, name: string): string | null {
  const value = req.headers?.[name];
  if (typeof value === "string") return value;
  return Array.isArray(value) && typeof value[0] === "string" ? value[0] : null;
}
