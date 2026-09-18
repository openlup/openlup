import type { ChannelQuarantineReason } from "../../../src/domains/channels/channelIngestStorePort.js";

// One place that decides which drawer a refusal belongs in, so the saga never has to.
//
// The mapping is deliberately from the STORE's raised name, not from an error class: the refusals
// that matter are raised inside SQL, where there are no classes, and reading them by name keeps the
// database's own vocabulary as the single authority on why an order was rejected.

const REASON_BY_RAISED_NAME: ReadonlyMap<string, ChannelQuarantineReason> = new Map([
  ["channel_order_money_equation_mismatch", "money_mismatch"],
  ["channel_order_line_sum_mismatch", "money_mismatch"],
  ["channel_order_currency_mismatch", "money_mismatch"],
  ["channel_order_missing_settlement_evidence", "money_mismatch"],
  ["channel_order_unmapped_sellable", "unmapped_sellable"],
  ["channel_order_unsupported_sellable_kind", "unmapped_sellable"],
  ["channel_order_vat_unresolvable", "vat_unresolvable"],
  ["channel_order_unsupported_contract_version", "contract_parse_failed"],
]);

/**
 * A wire payload the connector could not turn into `channel.order.v1` at all. Distinct from every
 * mapping refusal below it: nothing was understood well enough to name a sellable or a total.
 */
export function contractParseQuarantine(): ChannelQuarantineReason {
  return "contract_parse_failed";
}

/**
 * The refusal a store raise represents, or `null` when the failure is not a refusal at all.
 *
 * `null` is the load-bearing return. A dropped connection, a deadlock or a permission error is a
 * TRANSIENT fault: quarantining it would file an operator ticket for something that will succeed on
 * the next attempt, and would take the order out of the retry path that should carry it. Only a
 * refusal this deployment cannot resolve by trying again earns a drawer.
 */
export function classifyQuarantineReason(error: unknown): ChannelQuarantineReason | null {
  const message = readMessage(error);
  if (!message) return null;

  for (const [raised, reason] of REASON_BY_RAISED_NAME) {
    if (message.includes(raised)) return reason;
  }
  return null;
}

/**
 * The WIRE token to file the refusal under. For a mapping refusal that is the far side's own
 * string — a sellable reference, a status token — supplied by the caller from the payload. The
 * fallback is the raised name itself, which is this deployment's vocabulary rather than the far
 * side's, and is only ever reached when the payload carried no token to blame.
 */
export function quarantineVocabulary(error: unknown, wireToken: string | null): string {
  const token = wireToken?.trim();
  if (token) return token;
  const message = readMessage(error);
  for (const raised of REASON_BY_RAISED_NAME.keys()) {
    if (message.includes(raised)) return raised;
  }
  return "unknown";
}

function readMessage(error: unknown): string {
  if (!error) return "";
  if (typeof error === "string") return error;
  if (typeof error !== "object") return "";
  const candidate = error as { message?: unknown; details?: unknown; hint?: unknown };
  return [candidate.message, candidate.details, candidate.hint]
    .filter((part): part is string => typeof part === "string")
    .join(" ");
}
