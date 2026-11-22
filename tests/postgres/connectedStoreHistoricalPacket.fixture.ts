import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { ConnectedNativeStoreCapture } from "../../server/adapters/postgres/connectedStoreCapture.js";

const editQuotes = "subscription_edit_quotes";
const coverageRevisions = "tax_coverage_revisions";
const removed: Record<string, readonly string[]> = {
  subscription_lines: ["catalog_sku_revision_id"],
  commerce_orders: ["catalog_acceptance", "catalog_basket", "catalog_receipt_key"],
  subscription_events: ["catalog_acceptance", "catalog_basket"],
  subscription_renewal_terms: ["catalog_acceptance"],
  subscription_renewal_operations: ["catalog_acceptance", "catalog_acceptance_fingerprint"],
};

export function sealConnectedCapture(capture: ConnectedNativeStoreCapture) {
  const { sha256: _compatibleDigest, ...compatible } = capture.compatible;
  capture.compatible.sha256 = createHash("sha256").update(JSON.stringify(compatible)).digest("hex");
  const { sha256: _captureDigest, ...body } = capture;
  capture.sha256 = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  return capture;
}

// The feature fixtures seed the current schema. Project their captures to the
// predecessor format; the upgrade witness separately captures actual old schemas.
export async function projectHistoricalCapture(db: Pool, current: ConnectedNativeStoreCapture, catalogueId: string, predatesLedger = false) {
  const packet = structuredClone(current);
  const coverage = packet.owned.find(entry => entry.table === coverageRevisions);
  if (!coverage || coverage.rows.length) throw new Error("Historical captures require an empty tax coverage history");
  const quotes = packet.owned.find(entry => entry.table === editQuotes);
  if (!quotes || quotes.rows.length) throw new Error("Historical captures require an empty edit quote table");
  packet.owned = packet.owned.filter(entry => entry.table !== coverageRevisions && entry.table !== editQuotes);
  const relation = `public.${editQuotes}`;
  const { rows: [{ owner }] } = await db.query<{ owner: string }>(
    "SELECT pg_catalog.pg_get_userbyid(relowner) AS owner FROM pg_catalog.pg_class WHERE oid=$1::regclass", [relation]);
  packet.emptyOutsideProfile.push(relation);
  packet.outsideProfileCensus.push({ relation, owner, disposition: "unsupported-empty", rows: "0" });
  if (predatesLedger) packet.compatible.tables = packet.compatible.tables.filter(entry => entry.table !== "commerce_checkout_attempt_ledger");
  for (const table of [...packet.compatible.tables, ...packet.owned]) {
    const columns = removed[table.table];
    if (!columns) continue;
    table.columns = table.columns.filter(column => !columns.includes(column.name));
    if (table.rows.length) {
      const { rows } = await db.query<{ row: string }>(`SELECT (value::jsonb - $2::text[])::text AS row
        FROM unnest($1::text[]) WITH ORDINALITY AS retained(value, ordinal) ORDER BY ordinal`, [table.rows, columns]);
      table.rows = rows.map(({ row }) => row);
    }
  }
  packet.compatible.catalogueId = catalogueId;
  return sealConnectedCapture(packet);
}
