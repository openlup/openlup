import { channelOrderOpsResponseSchema } from "../../../src/domains/channels/channelOpsClient.js";
import { sendBffError, sendBffSuccess } from "../../_lib/bff/response.js";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";

// The read behind the OMS order panel: where the ingest run for this order got to, and how deep the
// operator queue is on the surface it came from.
//
// IT IS A READ, AND IT IS SHAPED SO IT CANNOT BE ANYTHING ELSE. GET only, one port with two read
// methods and no writer anywhere in reach, and a response the schema validates before it leaves.
// The route hands it a port; the port cannot mutate; there is nothing here to mis-order.
//
// WHY THE CHANNEL LOOKUP COMES FIRST. An order that names no channel is the common case, and the
// honest answer for it is a 200 with `channel: null` — not a 404, which would say the ORDER does
// not exist, and not an error, which would make a storefront order look broken. Only once a channel
// is known are the ledger row and the drawer count worth asking for, and they are asked for
// together because a panel that rendered one before the other would flicker between two truths.

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
}

export function createAdminChannelOpsHandler(deps: AdminChannelOpsHandlerDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
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
      sendValidated(res, {
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

    sendValidated(res, {
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
function sendValidated(res: VercelResponse, payload: unknown): void {
  const parsed = channelOrderOpsResponseSchema.safeParse(payload);
  if (!parsed.success) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Invalid channel operations response");
    return;
  }
  sendBffSuccess(res, parsed.data);
}

function readOrderId(req: VercelRequest): string | null {
  const raw = (req.query as Record<string, unknown> | undefined)?.orderId;
  const value = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : null;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
