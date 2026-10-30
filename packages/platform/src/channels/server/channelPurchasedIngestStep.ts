import { channelPurchaseCaptureSchema, type ChannelPurchaseCapture, type ChannelPurchasedExpandedLine } from "../channelPurchaseSourceContracts.js";
import { resolveChannelPurchasedBundles, type ChannelRetainedPurchaseContext } from "./channelPurchaseResolver.js";

/** Narrow retained-resolution error; unrelated owner errors remain retryable exceptions. */
export class ChannelControlError extends Error {
  readonly code: "command_invalid" | "authority_denied" | "human_capability_unavailable" | "store_unavailable" | "response_invalid" | "input_conflict";
  constructor(code: ChannelControlError["code"]) { super(code); this.name = "ChannelControlError"; this.code = code; }
}
export function prepareChannelPurchasedRows(input: {
  capture: ChannelPurchaseCapture; contexts: readonly ChannelRetainedPurchaseContext[];
}): ChannelPurchasedExpandedLine[] {
  const capture = channelPurchaseCaptureSchema.parse(input.capture);
  const resolved = resolveChannelPurchasedBundles({ order: capture.normalized, products: capture.products,
    observed: { scope: capture.scope, namespace: capture.namespace }, contexts: input.contexts });
  if (resolved.ok === false) throw new ChannelControlError("input_conflict");
  return resolved.rows.map(row => ({ ...row.line, retained: { ...row.provenance } }));
}
export function bindChannelPurchasedRows(input: {
  capture: ChannelPurchaseCapture; contexts: readonly ChannelRetainedPurchaseContext[];
}): ChannelPurchaseCapture {
  const capture = channelPurchaseCaptureSchema.parse(input.capture);
  if (capture.retainedRows) return capture;
  return channelPurchaseCaptureSchema.parse({ ...input.capture, retainedRows: prepareChannelPurchasedRows(input) });
}
export async function consumeChannelPurchasedCapture<T>(input: {
  capture: ChannelPurchaseCapture; accepted(): Promise<string | null>; contexts(): Promise<readonly ChannelRetainedPurchaseContext[]>;
  record(capture: ChannelPurchaseCapture): Promise<string>; original(ledgerId: string): Promise<ChannelPurchaseCapture>;
  ingest(capture: ChannelPurchaseCapture, ledgerId: string): Promise<T>; unresolved(capture: ChannelPurchaseCapture, ledgerId: string): Promise<T>;
}): Promise<T> {
  let capture = channelPurchaseCaptureSchema.parse(input.capture);
  const accepted = await input.accepted();
  if (accepted === null && !capture.retainedRows) {
    try { capture = bindChannelPurchasedRows({ capture, contexts: await input.contexts() }); }
    catch (error) { if (!(error instanceof ChannelControlError) || error.code !== "input_conflict") throw error; }
  }
  const ledgerId = accepted ?? await input.record(capture);
  const original = await input.original(ledgerId);
  return original.retainedRows ? input.ingest(original, ledgerId) : input.unresolved(original, ledgerId);
}
