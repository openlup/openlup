import { quoteLineSchema } from "../../../../src/domains/commerce/contracts.js";
import { quoteLinesListAnchorMinor } from "../../../domains/subscription/starterPackCharge.js";
import {
  SubscriptionCycleSnapshotError,
  type SnapshotSupabaseClient,
} from "./buildSubscriptionCycleSnapshots.js";

/**
 * The renewal cycle's lines, read once.
 *
 * Both numbers a starter-pack cycle is priced from come out of the SAME read:
 * the band subtotal the order is built from, and the catalog list total the
 * delivery-2 discount is measured against. A second read for the list price
 * would let a customer package edit land between them, and the cycle would then
 * freeze one composition's subtotal against another composition's list price.
 *
 * `pricingComponents` is stripped from the parsed quote line (the cycle order
 * stores the line, not its derivation), so the list anchor is taken from the
 * raw row before that copy is made.
 */

export type QuoteLine = ReturnType<typeof quoteLineSchema.parse>;

export interface SubscriptionCycleLines {
  lines: QuoteLine[];
  /** Catalog list total of the same lines; null when a line carries no evidence. */
  listAnchorMinor: number | null;
}

interface SubscriptionLineRow {
  variant_id: string;
  qty: number;
  sort_order: number;
  line_metadata: unknown;
}

export async function loadSubscriptionCycleLines(
  client: SnapshotSupabaseClient,
  subscriptionId: string,
): Promise<SubscriptionCycleLines> {
  const { data, error } = await client
    .from("subscription_lines")
    .select("variant_id, qty, sort_order, line_metadata")
    .eq("subscription_id", subscriptionId)
    .order("sort_order", { ascending: true })
    .order("variant_id", { ascending: true });
  if (error) {
    throw new SubscriptionCycleSnapshotError(
      `subscription_lines read failed: ${error.message ?? "unknown"}`,
      subscriptionId,
      { cause: error },
    );
  }
  const rows = Array.isArray(data) ? (data as SubscriptionLineRow[]) : [];
  if (rows.length === 0) {
    throw new SubscriptionCycleSnapshotError(
      "subscription has no subscription_lines rows",
      subscriptionId,
    );
  }
  return {
    lines: rows.map((row, index) => extractQuoteLine(row, index, subscriptionId)),
    listAnchorMinor: quoteLinesListAnchorMinor(rows.map(storedQuoteLine)),
  };
}

function storedQuoteLine(row: SubscriptionLineRow): unknown {
  const snapshot = (row.line_metadata as { productSnapshot?: unknown } | null)?.productSnapshot;
  return (snapshot as { quoteLine?: unknown } | null)?.quoteLine ?? null;
}

function extractQuoteLine(
  row: SubscriptionLineRow,
  index: number,
  subscriptionId: string,
): QuoteLine {
  const metadata = row.line_metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new SubscriptionCycleSnapshotError(
      `subscription_lines[${index}].line_metadata is not an object`,
      subscriptionId,
    );
  }
  const productSnapshot = (metadata as Record<string, unknown>).productSnapshot;
  if (!productSnapshot || typeof productSnapshot !== "object" || Array.isArray(productSnapshot)) {
    throw new SubscriptionCycleSnapshotError(
      `subscription_lines[${index}].line_metadata.productSnapshot missing`,
      subscriptionId,
    );
  }
  const quoteLine = (productSnapshot as Record<string, unknown>).quoteLine;
  if (!quoteLine || typeof quoteLine !== "object" || Array.isArray(quoteLine)) {
    throw new SubscriptionCycleSnapshotError(
      `subscription_lines[${index}].line_metadata.productSnapshot.quoteLine missing`,
      subscriptionId,
    );
  }

  const candidate: Record<string, unknown> = { ...(quoteLine as Record<string, unknown>) };
  if (typeof candidate.quantity !== "number") candidate.quantity = row.qty;
  delete candidate.pricingComponents;

  const parsed = quoteLineSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new SubscriptionCycleSnapshotError(
      `subscription_lines[${index}] quoteLine failed schema validation: ${parsed.error.message}`,
      subscriptionId,
    );
  }
  return parsed.data;
}
