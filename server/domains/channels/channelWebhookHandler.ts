import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import type {
  ChannelOrderSourcePort,
  NormalizedWebhookResult,
} from "../../../src/domains/channels/ports.js";
import type {
  NormalizedChannelOrder,
  UnmappedChannelSignal,
} from "../../../src/domains/channels/orderContracts.js";
import type { ChannelIngestOutcome } from "./channelOrderIngestSaga.js";

// The webhook shape of channel order ingest: one authenticated delivery from one connector's far
// side becomes exactly one of four things, and none of them is an exception escaping to the caller.
//
// THE ORDER OF THE GUARDS IS THE POINT, and it is the order the OmniPack webhook handler already
// uses: method, then feature flag, then token, and only then is a single byte of the body looked
// at. A deployment that has not been given a token cannot be talked into normalizing a payload,
// because the token check happens before the connector is called at all.
//
// NORMALIZATION IS THE TRUST BOUNDARY, AND IT IS THE CONNECTOR'S. `normalizeWebhook` verifies the
// far side's signature and never throws on unknown vocabulary (B4's connector-port contract), so
// this handler's whole job is to turn its four result kinds into four honest HTTP answers:
//
//   rejected  -> refused here, nothing durable written, and the far side is told so;
//   ignored   -> acknowledged, because a delivery this connector does not model is not an error;
//   unmapped  -> QUARANTINED and then acknowledged, because an unknown wire token is operator work
//                rather than a retry, and re-delivering it forever would only deepen the drawer;
//   order     -> handed to the ingest saga, whose outcome decides the answer.
//
// A REFUSAL IS NOT AN ACKNOWLEDGEMENT. B4 left this decision to the entrypoint wave on purpose. An
// admission refusal says the DELIVERY was misrouted or the channel is misconfigured — an unknown
// slug, a sunset surface, a currency that does not match the one the operator registered. Answering
// 200 would make a channel that silently drops every order look exactly like one that works, so a
// refusal answers 409 and names itself. The far side retries, and the retries are the signal.

/**
 * Raised by composition when this deployment can reach the ledger but not every rail the saga
 * drives. It is deliberately NOT a generic fault: an order the shop cannot yet ingest must answer
 * "unavailable, come back" rather than 500, so the far side keeps the delivery instead of
 * discarding it, and so the gap reads as a configuration state rather than as a crash.
 */
export class ChannelIngestUnavailableError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Channel ingest is unavailable: ${reason}`);
    this.name = "ChannelIngestUnavailableError";
    this.reason = reason;
  }
}

export interface ChannelWebhookPort {
  /** Runs the ingest saga for one normalized order. */
  ingestOrder(order: NormalizedChannelOrder): Promise<ChannelIngestOutcome>;
  /** Files an unknown wire token in the quarantine drawer. */
  quarantineSignal(input: {
    providerEventId: string;
    signal: UnmappedChannelSignal;
  }): Promise<{ quarantineId: string }>;
}

export interface ChannelWebhookHandlerDeps {
  /** The connector kind this route speaks for; echoed in every answer for operator triage. */
  connectorKind: string;
  enabled: () => boolean;
  verifyToken: (req: VercelRequest) => boolean;
  /** Resolved by the connector registry BEFORE this handler is built. */
  connector: Pick<ChannelOrderSourcePort, "normalizeWebhook">;
  port: ChannelWebhookPort;
  readRawBody: (req: VercelRequest) => Promise<string>;
}

export function createChannelWebhookHandler(deps: ChannelWebhookHandlerDeps) {
  const { connectorKind } = deps;

  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "POST") {
      sendMethodNotAllowed(res, ["POST"]);
      return;
    }
    if (!deps.enabled()) {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Channel webhook is disabled", {
        details: { feature: "channel-ingest-webhook", connectorKind, reason: "feature_flag_disabled" },
      });
      return;
    }
    if (!deps.verifyToken(req)) {
      sendBffError(res, "FORBIDDEN", "Channel webhook token rejected", {
        details: { connectorKind, reason: "token_rejected" },
      });
      return;
    }

    let rawBody: string;
    try {
      rawBody = await deps.readRawBody(req);
    } catch {
      sendBffError(res, "BAD_REQUEST", "Channel webhook body could not be read", {
        details: { connectorKind, reason: "body_unreadable" },
      });
      return;
    }

    const normalized = await deps.connector.normalizeWebhook({
      headers: readHeaders(req),
      rawBody,
      // No timeout is imposed here: normalization is local work on bytes we already hold, and a
      // signal that could fire mid-verification would turn a rejection into a fault.
      signal: new AbortController().signal,
    });

    await answer(res, connectorKind, normalized, deps.port);
  };
}

async function answer(
  res: VercelResponse,
  connectorKind: string,
  normalized: NormalizedWebhookResult,
  port: ChannelWebhookPort,
): Promise<void> {
  if (normalized.kind === "rejected") {
    // Fails closed on the connector's own verdict. `signature` is a trust failure and `malformed`
    // is a contract failure; neither is retried into the store.
    if (normalized.reason === "signature") {
      sendBffError(res, "FORBIDDEN", "Channel webhook signature rejected", {
        details: { connectorKind, reason: "signature_rejected" },
      });
      return;
    }
    sendBffError(res, "BAD_REQUEST", "Channel webhook payload is malformed", {
      details: { connectorKind, reason: "payload_malformed" },
    });
    return;
  }

  if (normalized.kind === "ignored") {
    sendBffSuccess(res, {
      connectorKind,
      status: "ignored",
      providerEventId: normalized.providerEventId,
      reason: normalized.reason,
    });
    return;
  }

  if (normalized.kind === "unmapped") {
    const filed = await port.quarantineSignal({
      providerEventId: normalized.providerEventId,
      signal: normalized.signal,
    });
    sendBffSuccess(res, {
      connectorKind,
      status: "quarantined",
      providerEventId: normalized.providerEventId,
      reason: "unmapped_vocabulary",
      vocabulary: normalized.signal.vocabulary,
      quarantineId: filed.quarantineId,
    });
    return;
  }

  let outcome: ChannelIngestOutcome;
  try {
    outcome = await port.ingestOrder(normalized.order);
  } catch (error) {
    if (!(error instanceof ChannelIngestUnavailableError)) throw error;
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Channel ingest is not configured", {
      details: { connectorKind, reason: error.reason },
    });
    return;
  }
  if (outcome.kind === "refused") {
    sendBffError(res, "CONFLICT", "Channel webhook delivery refused", {
      details: { connectorKind, reason: outcome.refusal, detail: outcome.detail },
    });
    return;
  }

  sendBffSuccess(res, {
    connectorKind,
    status: outcome.kind,
    providerEventId: normalized.providerEventId,
    externalOrderRef: normalized.order.externalOrderRef,
    ...outcomeEvidence(outcome),
  });
}

/** The ids an operator needs to find this delivery again, per outcome. */
function outcomeEvidence(
  outcome: Exclude<ChannelIngestOutcome, { kind: "refused" }>,
): Record<string, unknown> {
  switch (outcome.kind) {
    case "settled":
      return {
        ledgerId: outcome.ledgerId,
        orderId: outcome.orderId,
        paymentIntentId: outcome.paymentIntentId,
      };
    case "replayed":
      return { ledgerId: outcome.ledgerId, orderId: outcome.orderId };
    case "blocked_stock":
      return { ledgerId: outcome.ledgerId, orderId: outcome.orderId, detail: outcome.detail };
    case "quarantined":
      return { ledgerId: outcome.ledgerId, reason: outcome.reason, detail: outcome.detail };
  }
}

function readHeaders(req: VercelRequest): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers ?? {})) {
    if (typeof value === "string") headers[name.toLowerCase()] = value;
    else if (Array.isArray(value) && typeof value[0] === "string") headers[name.toLowerCase()] = value[0];
  }
  return headers;
}

/**
 * The port every failure path is built with. It is not a stub for convenience: it is what makes a
 * disabled, unconfigured or unauthenticated delivery unable to write anything even if a later edit
 * accidentally lets it past a guard.
 */
export function emptyChannelWebhookPort(): ChannelWebhookPort {
  return {
    async ingestOrder(): Promise<never> {
      throw new Error("channel_webhook_port_unavailable");
    },
    async quarantineSignal(): Promise<never> {
      throw new Error("channel_webhook_port_unavailable");
    },
  };
}
