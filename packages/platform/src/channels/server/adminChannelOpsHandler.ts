import { channelOrderOpsResponseSchema } from "../opsSchemas.js";
import { createBffResponder, type BffResponder } from "../../bff/index.js";
import type { HttpRequest, HttpResponse } from "../../http/index.js";

// Read-only operator projection. Resolve the channel before reading its ledger and quarantine count.

export interface ChannelOpsOrderContext {
  channelId: string;
  slug: string;
  displayName: string;
  status: string;
}

export interface ChannelOpsIngestRow {
  ledgerId: string;
  status: string;
  externalOrderRef: string;
  externalOrderRevision: string | null;
  lastError: string | null;
  updatedAt: string;
}

export interface AdminChannelOpsReadPort {
  /** The selling surface this order came from, or null for a storefront order. */
  readOrderChannel(orderId: string): Promise<ChannelOpsOrderContext | null>;
  /** The ingest ledger row that built this order, or null when none points at it. */
  readOrderIngest(orderId: string): Promise<ChannelOpsIngestRow | null>;
  /** Open rows in one channel's quarantine drawer. */
  countOpenQuarantine(channelId: string): Promise<number>;
}

export interface AdminChannelOpsHandlerDeps {
  readPort: AdminChannelOpsReadPort;
  authorizeAdmin: () => Promise<{ ok: boolean; userId?: string }>;
  enabled: boolean;
  responder?: BffResponder;
}

export function createAdminChannelOpsHandler(deps: AdminChannelOpsHandlerDeps) {
  const responder = deps.responder ?? createBffResponder();
  const { sendBffError } = responder;
  return async function handler(req: HttpRequest, res: HttpResponse): Promise<void> {
    if (req.method !== "GET") {
      sendBffError(res, "BAD_REQUEST", "Channel order operations is a read", {
        details: { reason: "method_not_allowed" },
      });
      return;
    }
    if (!deps.enabled) {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Channel operations are disabled", {
        details: { reason: "feature_flag_disabled" },
      });
      return;
    }

    const authorized = await deps.authorizeAdmin();
    if (!authorized.ok) {
      sendBffError(res, "FORBIDDEN", "Admin session required");
      return;
    }

    const orderId = readOrderId(req);
    if (!orderId) {
      sendBffError(res, "BAD_REQUEST", "orderId is required", {
        details: { reason: "order_id_required" },
      });
      return;
    }

    const channel = await deps.readPort.readOrderChannel(orderId);
    if (!channel) {
      // A storefront order. Answered, not refused.
      sendValidated(res, responder, {
        contractVersion: "channels.ops.v1",
        orderId,
        channel: null,
        ingest: null,
        openQuarantineCount: 0,
      });
      return;
    }

    const [ingest, openQuarantineCount] = await Promise.all([
      deps.readPort.readOrderIngest(orderId),
      deps.readPort.countOpenQuarantine(channel.channelId),
    ]);

    sendValidated(res, responder, {
      contractVersion: "channels.ops.v1",
      orderId,
      channel: { slug: channel.slug, displayName: channel.displayName, status: channel.status },
      ingest,
      openQuarantineCount,
    });
  };
}

/**
 * Validated on the way out, like every other admin read here. A response that does not satisfy its
 * own contract is a bug on this side, so it is refused as one rather than shipped to a panel that
 * would then have to defend itself against its own server.
 */
function sendValidated(res: HttpResponse, responder: BffResponder, payload: unknown): void {
  const { sendBffError, sendBffSuccess } = responder;
  const parsed = channelOrderOpsResponseSchema.safeParse(payload);
  if (!parsed.success) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Invalid channel operations response");
    return;
  }
  sendBffSuccess(res, parsed.data);
}

function readOrderId(req: HttpRequest): string | null {
  const raw = (req.query as Record<string, unknown> | undefined)?.orderId;
  const value = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : null;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
