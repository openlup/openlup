import { createHash } from "node:crypto";
import { canonicalJson } from "../../canonicalJson.js";
import { CHANNEL_CONTROL_JSON_LIMITS } from "../../channelRegistryContracts.js";
import { CHANNEL_INGEST_ORDERED_STATUSES, CHANNEL_INGEST_HALTED_STATUSES } from "../../channelIngestStorePort.js";
import { z } from "zod";
import { channelControlIdSchema as id, channelControlRefSchema as ref } from "../../channelRegistryContracts.js";
import { channelPurchaseCaptureSchema, channelPurchaseCaptureReadSchema, channelPullPageSchema,
  channelPullPageReadSchema, channelPullCursorReceiptSchema, type ChannelPurchaseCapture, type ChannelPullPage } from "../../channelPurchaseSourceContracts.js";
import { ChannelControlError } from "../channelPurchasedIngestStep.js";
import type { ChannelRailsRpc, ChannelRailsError } from "../channelIngestRails.js";

/** Exact donor command identity limits, including hostile-object refusal. */
export function canonicalChannelSource(value: unknown): string {
  return canonicalJson(value, CHANNEL_CONTROL_JSON_LIMITS);
}
export function channelSourceDigest(text: string): string { return createHash("sha256").update(text, "utf8").digest("hex"); }
function decode<T>(schema: z.ZodType<T>, value: unknown): T {
  try { canonicalChannelSource(value); return schema.parse(value); }
  catch { throw new ChannelControlError("response_invalid"); }
}
function unpack<T>(schema: z.ZodType<T>, text: string, digest: string): T {
  try {
    if (channelSourceDigest(text) !== digest) throw new Error();
    const value = decode(schema, JSON.parse(text));
    if (canonicalChannelSource(value) !== text) throw new Error();
    return value;
  } catch { throw new ChannelControlError("response_invalid"); }
}
const ledgerSchema = z.object({ ingest: z.object({ id,
  status: z.enum([...CHANNEL_INGEST_ORDERED_STATUSES, ...CHANNEL_INGEST_HALTED_STATUSES]),
  orderId: id.nullable(), clientId: id.nullable(), shippingAddressId: id.nullable(), paymentIntentId: id.nullable(),
  externalOrderRevision: z.string().max(64).nullable(), conflict: z.literal("revision_conflict").nullable(),
  eventReplayed: z.boolean(), replayed: z.boolean(),
}).passthrough() }).passthrough();
const pageRecorded = z.object({ pagePacketId: id, inputDigest: z.string().regex(/^[0-9a-f]{64}$/u) }).strict();
const progressCommitted = z.object({ outcome: z.enum(["applied", "replayed"]), result: channelPullCursorReceiptSchema }).strict();
function failure(error: ChannelRailsError): Error {
  if (/insufficient_available_stock|allocation_incomplete/u.test(error.message ?? "")) {
    return Object.assign(new Error(error.message), { code: error.code });
  }
  if (error.message === "channel_purchase_physical_unavailable") return new Error("channel_purchase_physical_unavailable");
  return new ChannelControlError(error.code === "42501" ? "authority_denied" : error.code === "22023" ? "command_invalid"
    : ["P0001", "23505", "23514", "40001"].includes(error.code ?? "") ? "input_conflict" : "store_unavailable");
}
/** The same capture/page/CAS contract uses a service RPC or a host's parameterized SQL executor. */
export function createChannelPurchasedSourceStore(options: { client: ChannelRailsRpc; actorId: string; rail: "managed" | "portable" }) {
  const actorId = id.parse(options.actorId);
  function actor(value: string) { if (value !== actorId) throw new ChannelControlError("authority_denied"); }
  async function call(name: string, args: Record<string, unknown>): Promise<unknown> {
    let result;
    try { result = await options.client.rpc(name, args); }
    catch { throw new ChannelControlError("store_unavailable"); }
    if (result.error) throw failure(result.error);
    return result.data;
  }
  function authored<T>(schema: z.ZodType<T>, value: unknown): T {
    try { canonicalChannelSource(value); return schema.parse(value); }
    catch { throw new ChannelControlError("command_invalid"); }
  }
  return {
    readiness: { sourceCapture: true, settledIngest: options.rail === "managed", privacyLifecycle: "unavailable" } as const,
    async originalConversion(input: { ledgerId: string; externalLineRef: string; jobRunId: string; canonicalText: string | null }) {
      const value = await call("channel_purchase_conversion_command", { p_ledger_id: id.parse(input.ledgerId),
        p_external_line_ref: ref.parse(input.externalLineRef), p_actor_id: actorId, p_job_run_id: id.parse(input.jobRunId), p_command_text: input.canonicalText });
      if (value !== null && typeof value !== "string") throw new ChannelControlError("response_invalid");
      return value as string | null;
    },
    async recordCapture(input: ChannelPurchaseCapture) {
      const value = authored(channelPurchaseCaptureSchema, input); actor(value.execution.actorId);
      if (value.normalizedDigest !== channelSourceDigest(canonicalChannelSource(value.normalized)) || value.normalized.payloadDigest !== value.rawSourceDigest) {
        throw new ChannelControlError("command_invalid");
      }
      const text = canonicalChannelSource(value);
      const result = await call("channel_ingest_record_inbound_event", { p_channel_id: value.scope.channelId,
        p_external_order_ref: value.externalOrderRef, p_external_order_revision: value.externalOrderRevision,
        p_provider_event_id: value.providerEventId, p_normalized: value.normalized, p_capture_text: text, p_capture_digest: channelSourceDigest(text) });
      decode(ledgerSchema, result);
      return result;
    },
    async readCapture(input: { channelId: string; providerEventId: string; actorId: string }) {
      actor(input.actorId);
      const channelId = authored(id, input.channelId), providerEventId = authored(ref, input.providerEventId);
      const response = await call("channel_ingest_capture_read", { p_channel_id: channelId, p_provider_event_id: providerEventId, p_actor_id: actorId });
      if (response === null) return null;
      const packet = decode(channelPurchaseCaptureReadSchema, response);
      const capture = unpack(channelPurchaseCaptureSchema, packet.canonicalText, packet.inputDigest);
      if (capture.scope.channelId !== channelId || capture.providerEventId !== providerEventId ||
        capture.normalizedDigest !== channelSourceDigest(canonicalChannelSource(capture.normalized)) || capture.normalized.payloadDigest !== capture.rawSourceDigest) {
        throw new ChannelControlError("response_invalid");
      }
      return { ledgerId: packet.ledgerId, capture };
    },
    async recordPage(input: ChannelPullPage) {
      const value = authored(channelPullPageSchema, input); actor(value.execution.actorId);
      const text = canonicalChannelSource(value), digest = channelSourceDigest(text);
      const result = decode(pageRecorded, await call("channel_pull_page_record", { p_connection_id: value.scope.connectionId,
        p_actor_id: actorId, p_job_run_id: value.execution.jobRunId, p_page_packet_id: value.pagePacketId, p_canonical_text: text, p_input_digest: digest }));
      if (result.pagePacketId !== value.pagePacketId || result.inputDigest !== digest) throw new ChannelControlError("response_invalid");
      return result;
    },
    async readPage(input: { connectionId: string; pagePacketId: string; actorId: string; inputDigest: string }) {
      actor(input.actorId);
      const response = await call("channel_pull_page_read", { p_connection_id: authored(id, input.connectionId),
        p_page_packet_id: authored(id, input.pagePacketId), p_actor_id: actorId, p_input_digest: authored(z.string().regex(/^[0-9a-f]{64}$/u), input.inputDigest) });
      if (response === null) return null;
      const result = decode(channelPullPageReadSchema, response), page = unpack(channelPullPageSchema, result.canonicalText, result.inputDigest);
      if (result.inputDigest !== input.inputDigest || page.pagePacketId !== input.pagePacketId || page.scope.connectionId !== input.connectionId ||
        (result.cursorReceipt && (result.cursorReceipt.pagePacketId !== page.pagePacketId ||
          canonicalChannelSource(result.cursorReceipt.before) !== canonicalChannelSource(page.expected) ||
          canonicalChannelSource(result.cursorReceipt.after) !== canonicalChannelSource(page.next)))) throw new ChannelControlError("response_invalid");
      return { page, cursorReceipt: result.cursorReceipt };
    },
    async commitPage(input: ChannelPullPage) {
      const page = authored(channelPullPageSchema, input); actor(page.execution.actorId);
      const result = decode(progressCommitted, await call("channel_pull_progress_commit", { p_connection_id: page.scope.connectionId,
        p_actor_id: actorId, p_job_run_id: page.execution.jobRunId, p_page_packet_id: page.pagePacketId,
        p_expected_cursor: page.expected.cursor, p_expected_watermark: page.expected.watermark, p_expected_generation: page.expected.generation,
        p_next_cursor: page.next.cursor, p_next_watermark: page.next.watermark }));
      if (result.result.pagePacketId !== page.pagePacketId || canonicalChannelSource(result.result.before) !== canonicalChannelSource(page.expected) ||
        canonicalChannelSource(result.result.after) !== canonicalChannelSource(page.next)) throw new ChannelControlError("response_invalid");
      return result;
    },
  };
}
export const createManagedChannelPurchasedSourceStore = (input: { serviceClient: ChannelRailsRpc; actorId: string }) =>
  createChannelPurchasedSourceStore({ client: input.serviceClient, actorId: input.actorId, rail: "managed" });
export interface ChannelSourceExecutor { query(sql: string, parameters: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }> }
export function createPostgresChannelPurchasedSourceStore(input: { executor: ChannelSourceExecutor; actorId: string }) {
  // Fixed names and exact argument insertion order are authored here, never caller SQL.
  const signatures: Record<string, readonly string[]> = {
    channel_purchase_conversion_command: ["uuid", "text", "uuid", "uuid", "text"],
    channel_ingest_record_inbound_event: ["uuid", "text", "text", "text", "jsonb", "text", "text"],
    channel_ingest_capture_read: ["uuid", "text", "uuid"], channel_pull_page_record: ["uuid", "uuid", "uuid", "uuid", "text", "text"],
    channel_pull_page_read: ["uuid", "uuid", "uuid", "text"],
    channel_pull_progress_commit: ["uuid", "uuid", "uuid", "uuid", "text", "timestamptz", "bigint", "text", "timestamptz"],
  };
  return createChannelPurchasedSourceStore({ actorId: input.actorId, rail: "portable", client: { async rpc(name, args) {
    const signature = signatures[name];
    if (!signature || signature.length !== Object.keys(args).length) throw new ChannelControlError("command_invalid");
    try {
      const result = await input.executor.query(`SELECT public.${name}(${signature.map((cast, index) => `$${index + 1}::${cast}`).join(",")}) AS result`, Object.values(args));
      return { data: result.rows[0]?.result, error: null };
    } catch (error) { return { data: null, error: error as ChannelRailsError }; }
  } } });
}
