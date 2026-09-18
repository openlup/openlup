import { z } from "../../lib/validation/zod.js";

// What an operator staring at a channel-sourced order needs, and nothing else.
//
// THE QUESTION THIS ANSWERS is the one the order row cannot: an order that arrived from a selling
// surface has a SECOND life story — the ingest run that built it — and when something looks wrong
// the answer is almost always in that story rather than in the order. Where did the run stop? Did
// it stop on stock, on a refusal, or not at all? And is this one order in trouble, or is the whole
// surface backed up behind an operator queue nobody has drained?
//
// TWO FACTS, DELIBERATELY. The ledger row for THIS order, and the number of open quarantine rows
// for the channel it came from. The second is a COUNT rather than a list on purpose: the drawer has
// its own surface, and a panel that started listing rows would become a second, worse version of it
// that has to be kept in step. A count is enough to tell an operator whether to go there.
//
// AN ORDER WITH NO CHANNEL IS NOT AN ERROR. Most orders are storefront orders. The response says
// `channel: null` and the panel renders nothing, rather than the read failing or the caller having
// to know in advance which orders have a story to tell.

export const channelOrderOpsResponseSchema = z
  .object({
    contractVersion: z.literal("channels.ops.v1"),
    orderId: z.string(),
    /** Null for an order this deployment did not ingest from a selling surface. */
    channel: z
      .object({ slug: z.string(), displayName: z.string(), status: z.string() })
      .nullable(),
    /**
     * Null when the order names a channel but no ledger row points at it — which is possible for
     * an order created before the ledger existed, and is reported rather than smoothed over.
     */
    ingest: z
      .object({
        ledgerId: z.string(),
        status: z.string(),
        externalOrderRef: z.string(),
        externalOrderRevision: z.string().nullable(),
        lastError: z.string().nullable(),
        updatedAt: z.string(),
      })
      .nullable(),
    /** Open rows in the channel's quarantine drawer. Zero is a real answer. */
    openQuarantineCount: z.number().int().nonnegative(),
  })
  .strict();

export type ChannelOrderOpsResponse = z.infer<typeof channelOrderOpsResponseSchema>;

/**
 * The statuses that mean "this run stopped and is waiting for a person". Stated here so the panel
 * and any later alert read the same list, and derived from the ledger's own halted set rather than
 * from how a status happens to read.
 */
export const CHANNEL_INGEST_ATTENTION_STATUSES = [
  "blocked_stock",
  "quarantined",
  "failed",
] as const;

export function channelIngestNeedsAttention(status: string | null | undefined): boolean {
  return (CHANNEL_INGEST_ATTENTION_STATUSES as readonly string[]).includes(status ?? "");
}

/**
 * A read that could not happen because this deployment chose not to run the feature is NOT a
 * failure, and the two must not arrive at the caller as the same thing.
 *
 * The route refuses fail-closed while `CHANNEL_INGEST_WEBHOOK_ENABLED` is off, which is correct —
 * but it is a decision, not an outage, and a caller told only "503" has no way to tell them apart.
 * So the decision is carried through as a value and every other refusal keeps throwing.
 */
export type ChannelOrderOpsResult =
  | { kind: "disabled" }
  | { kind: "ok"; data: ChannelOrderOpsResponse };

/**
 * The one refusal reason that means "switched off here", spelled exactly as the route spells it.
 * Named so that a rename on the server side lands in a red test rather than in a silent panel.
 */
const CHANNEL_OPS_DISABLED_REASON = "feature_flag_disabled";

export async function getAdminChannelOrderOps(
  accessToken: string,
  orderId: string,
): Promise<ChannelOrderOpsResult> {
  const response = await fetch(
    `/api/bff/admin/channels/order-ops?orderId=${encodeURIComponent(orderId)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  const body = (await response.json()) as {
    ok?: boolean;
    data?: unknown;
    error?: { details?: unknown };
  };
  if (!response.ok || body.ok !== true) {
    // Deliberately the narrowest possible match: an exact reason on a refused envelope. Nothing
    // about the status or the error code widens it, so a genuinely broken upstream — which answers
    // 503 too — still reaches the caller as a throw and is still said out loud.
    if (readRefusalReason(body.error?.details) === CHANNEL_OPS_DISABLED_REASON) {
      return { kind: "disabled" };
    }
    throw new Error(`channel_order_ops_failed_${response.status}`);
  }
  return { kind: "ok", data: channelOrderOpsResponseSchema.parse(body.data) };
}

function readRefusalReason(details: unknown): string | null {
  if (!details || typeof details !== "object") return null;
  const reason = (details as { reason?: unknown }).reason;
  return typeof reason === "string" ? reason : null;
}
