
export type { ChannelOrderOpsResponse } from "./contracts/index.js";
import { z } from "zod";
export const channelOrderOpsResponseSchema = z.object({
  contractVersion: z.literal("channels.ops.v1"), orderId: z.string(),
  channel: z.object({ slug: z.string(), displayName: z.string(), status: z.string() }).nullable(),
  ingest: z.object({ ledgerId: z.string(), status: z.string(), externalOrderRef: z.string(),
    externalOrderRevision: z.string().nullable(), lastError: z.string().nullable(), updatedAt: z.string() }).nullable(),
  openQuarantineCount: z.number().int().nonnegative(),
}).strict();

export const CHANNEL_INGEST_ATTENTION_STATUSES = ["blocked_stock", "quarantined", "failed"] as const;
export function channelIngestNeedsAttention(status: string | null | undefined): boolean {
  return (CHANNEL_INGEST_ATTENTION_STATUSES as readonly string[]).includes(status ?? "");
}
