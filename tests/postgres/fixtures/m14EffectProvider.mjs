// Owned disposable synthetic provider. This is neither a production service nor
// an implementation of real-provider revocation, search or retention semantics.
import { createServer } from "node:http";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";

const file = "/ledger/effects.json";
const control = process.argv[2];
if (!control) throw new Error("fixture_control_required");
let state = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { version: 1, oauthCalls: 0, requests: [] };
if (state.version !== 1 || !Array.isArray(state.requests)) throw new Error("fixture_ledger_invalid");
const pendingResponses = new Map();
function persist() {
  const fd = openSync(`${file}.next`, "w", 0o600);
  try { writeFileSync(fd, JSON.stringify(state)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(`${file}.next`, file);
  const directory = openSync("/ledger", "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
function event(row, delivered = false) {
  const occurredAt = delivered ? "2026-09-04T12:00:00.000Z" : "2026-09-03T12:00:00.000Z";
  const eventKey = `effect:${row.externalRef}:${delivered ? "delivered" : "accepted"}`;
  const receivedAt = new Date().toISOString();
  return {
    fact: { schemaVersion: 1, mapperVersion: "synthetic-m14-v1", factId: eventKey, providerKind: "warehouse-a",
      fulfillmentReference: row.externalRef, canonicalStatus: delivered ? "delivered" : "provider_received",
      provenance: { source: "provider_webhook", authority: "provider_asserted" }, occurredAt, receivedAt,
      rawEvent: { reference: `evidence:${randomUUID()}`, digestAlgorithm: "sha256",
        digest: createHash("sha256").update(eventKey).digest("hex") } },
    eventKind: delivered ? "order.delivered" : "shipment.accepted", eventKey, firstReceivedAt: receivedAt,
    correlation: { fulfillmentRef: row.shipmentRef, orderRef: row.orderRef, externalRef: row.externalRef,
      orderNumber: null, providerFulfillmentRef: null, parcelRef: null }, trackingRefs: [],
  };
}
function accept(row) {
  if (row.state !== "pending") throw new Error("fixture_request_already_accepted");
  row.externalRef = `external-${randomUUID()}`; // Never derived from merchant identity.
  row.state = "accepted";
  row.observations = [event(row)];
  persist(); // Durable external acceptance precedes either response disposition.
  const response = pendingResponses.get(row.requestId);
  if (row.acknowledge && response) json(response, { externalRef: row.externalRef });
  else response?.destroy();
  pendingResponses.delete(row.requestId);
}
async function body(request) {
  const chunks = []; let bytes = 0;
  for await (const chunk of request) { bytes += chunk.length; if (bytes > 8192) throw new Error("fixture_body_limit"); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function json(response, value, headers = {}) {
  response.writeHead(200, { "Content-Type": "application/json", ...headers }); response.end(JSON.stringify(value));
}
persist();
createServer((request, response) => { void (async () => {
  if (request.url === "/oauth/auth") {
    state.oauthCalls++; persist(); return json(response, { access_token: "synthetic-cached-bearer" });
  }
  if (request.url === "/effects" && request.method === "POST") {
    if (request.headers.authorization !== "Bearer synthetic-cached-bearer") { response.writeHead(401); return response.end(); }
    const input = await body(request);
    if (typeof input.key !== "string" || typeof input.shipmentRef !== "string" || typeof input.orderRef !== "string") throw new Error("fixture_command_invalid");
    const row = { requestId: randomUUID(), key: input.key, shipmentRef: input.shipmentRef,
      orderRef: input.orderRef, acknowledge: input.acknowledge === true,
      state: "pending", externalRef: null, observations: [] };
    // Every POST is separately retained. Provider idempotency cannot hide an
    // accidental duplicate create in this witness.
    state.requests.push(row); persist(); pendingResponses.set(row.requestId, response);
    if (input.hold !== true) accept(row);
    return;
  }
  if (request.headers["x-m14-control"] !== control) { response.writeHead(403); return response.end(); }
  if (request.url === "/state") return json(response, { node: process.version, ...state });
  if (request.url === "/observations") {
    const text = JSON.stringify(state.requests.flatMap(row => row.observations));
    response.writeHead(200, { "Content-Type": "application/json",
      "x-m14-signature": createHmac("sha256", control).update(text).digest("hex") });
    return response.end(text);
  }
  if ((request.url === "/release" || request.url === "/late") && request.method === "POST") {
    const input = await body(request), rows = state.requests.filter(row => row.key === input.key);
    if (rows.length !== 1) throw new Error("fixture_key_not_unique");
    const row = rows[0];
    if (request.url === "/release") accept(row);
    else {
      if (row.state !== "accepted") throw new Error("fixture_late_before_acceptance");
      if (row.observations.length !== 1) throw new Error("fixture_late_already_published");
      row.observations.push(event(row, true)); persist();
    }
    return json(response, { applied: true });
  }
  response.writeHead(404); response.end();
})().catch(() => { if (!response.headersSent) response.writeHead(500); response.end("fixture_request_failed"); }); }).listen(8080, "0.0.0.0");
