// Owned fixture process for the existing application binding. Installation and
// grants are prerequisites supplied by its caller; this actor never creates them.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { Pool, TypeOverrides, type PoolClient } from "pg";
import { createPostgresGatewayTypeOverrides, type PgQueryExecutor } from "@openlup/platform/data";
import { createOrderReviewRawUploadHandler, createPostgresOrderReviewMediaPort } from "@openlup/platform/commerce/server";
import type { HttpRequest, HttpResponse } from "@openlup/platform/http";
import { OrderReviewMediaObjectStore } from "../../../server/adapters/filesystem/orderReviewMediaObjectStore.js";
import { resolveOrderReviewRuntimeBinding } from "../../../server/runtime/commerce/orderReviewBinding.js";

export interface M14ApplicationInput {
  connectionString: string;
  runtimeLogin: string;
  database: string;
  control: string;
  startupDelete: { actorRef: string; mediaRef: string };
}

const input = JSON.parse(readFileSync("/control/input.json", "utf8")) as M14ApplicationInput;
const boot = randomUUID(), started = performance.now();
let sequence = 0, accepting = true;
const observations: Record<string, unknown>[] = [];
function record(kind: string, detail: Record<string, unknown> = {}) {
  const event = { sequence: ++sequence, elapsedMs: Math.round(performance.now() - started), kind, ...detail };
  observations.push(event);
  appendFileSync("/control/events.jsonl", `${JSON.stringify(event)}\n`, { mode: 0o600 });
  writeFileSync("/control/status.next", JSON.stringify({ boot, node: process.version,
    uid: process.getuid?.(), gid: process.getgid?.(), accepting, observations }), { mode: 0o600 });
  renameSync("/control/status.next", "/control/status.json");
}
function code(error: unknown) {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "fixture_error";
}

assert.equal(process.version, "v24.21.0");
assert.match(input.runtimeLogin, /^[a-z_][a-z0-9_]{0,62}$/);
assert.match(input.control, /^[0-9a-f-]{36}$/);
const selected = new URL(input.connectionString);
assert.equal(selected.hostname, "source-db");
assert.equal(selected.port, "5432");
assert.equal(decodeURIComponent(selected.username), input.runtimeLogin);
assert.equal(decodeURIComponent(selected.pathname.slice(1)), input.database);
const pool = new Pool({ connectionString: input.connectionString, max: 8,
  application_name: `m14-app:${boot}`,
  connectionTimeoutMillis: 2_000, query_timeout: 3_000,
  types: createPostgresGatewayTypeOverrides(TypeOverrides) });

// Same actual-session/nonowner observation used by the qualified native witness,
// narrowed to the media tables used here. This is not an installer/ACL validator.
async function runtimeClient(): Promise<PoolClient> {
  const client = await pool.connect();
  try {
    const identity = await client.query(`SELECT current_user,session_user,current_database() AS database,
      r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,
      NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid=ANY($1::regclass[])
        AND pg_catalog.pg_has_role(current_user,c.relowner,'USAGE')) AS nonowner,
      NOT pg_catalog.pg_has_role(current_user,d.datdba,'USAGE') AS database_nonowner
      FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_database d ON d.datname=current_database()
      WHERE r.rolname=current_user`, [["public.commerce_order_reviews", "public.commerce_order_review_media",
      "public.commerce_order_review_command_receipts", "public.commerce_order_review_audit"]]);
    assert.deepEqual(identity.rows, [{ current_user: input.runtimeLogin, session_user: input.runtimeLogin,
      database: input.database, rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false,
      nonowner: true, database_nonowner: true }]);
    return client;
  } catch (error) { client.release(); throw error; }
}
const statementNames = new Map([
  ["SELECT public.order_review_claim_media_reconcile($1::integer,now()) AS response", "reconcile-claim"],
  ["SELECT public.order_review_complete_media_reconcile($1::text,$2::text,$3::text,$4::integer,$5::text,$6::text,now()) AS response", "reconcile-complete"],
  ["SELECT public.order_review_record_media_stored($1::text,$2::text,$3::bigint,$4::text,$5::integer,now()) AS response", "raw-stored"],
  ["SELECT public.order_review_admin_complete_media_delete($1::text,$2::text,now()) AS response", "admin-delete-complete"],
]);
function observed(client: PoolClient): PgQueryExecutor {
  return { async query(sql, values) {
    const name = statementNames.get(sql);
    try {
      const result = await client.query(sql, values);
      if (name) record(name, { outcome: "returned", ...(name === "reconcile-claim"
        ? { tasks: Array.isArray(result.rows[0]?.response?.tasks) ? result.rows[0].response.tasks.length : null } : {}) });
      return result;
    } catch (error) { if (name) record(name, { outcome: "failed", code: code(error) }); throw error; }
  } };
}
const executor: PgQueryExecutor = { async query(sql, values) {
  const client = await runtimeClient();
  try { return await observed(client).query(sql, values); } finally { client.release(); }
} };
const transaction = { async run<T>(work: (db: PgQueryExecutor) => Promise<T>): Promise<T> {
  const client = await runtimeClient();
  try {
    await client.query("BEGIN");
    const result = await work(observed(client));
    await client.query("COMMIT");
    return result;
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
} };

async function main() {
  const admission = await runtimeClient(); admission.release();
  record("runtime-admitted", { runtimeLogin: input.runtimeLogin, database: input.database });
  // The first state-changing operation is under the injected actual R session.
  // If the canonical runtime completion is absent, this refuses before startup,
  // HTTP or storage composition. No owner retry or GRANT is available here.
  const media = createPostgresOrderReviewMediaPort(executor, transaction);
  assert(await media.prepareAdminDelete({ ...input.startupDelete, idempotencyKey: `m14-startup:${boot}` }));
  record("startup-cleanup-queued");
  const store = await OrderReviewMediaObjectStore.create("/media");
  const promoted = store.promote.bind(store), removed = store.remove.bind(store), writeTemp = store.writeTemp.bind(store);
  const entered = new Set<string>();
  async function gate(kind: "promote" | "remove", key: string) {
    const path = `/control/gate-${kind}.json`;
    if (!existsSync(path) || entered.has(kind)) return;
    const selectedGate = JSON.parse(readFileSync(path, "utf8")) as { objectKey: string };
    if (selectedGate.objectKey !== key) return;
    entered.add(kind); record(`gate-${kind}-entered`);
    // Fixture observation allowance only; the real raw handler keeps its 30s
    // deadline and the production binding keeps its natural 30s interval.
    const deadline = performance.now() + 20_000;
    while (!existsSync(`/control/release-${kind}`)) {
      if (performance.now() >= deadline) throw new Error("m14 application barrier observation deadline");
      await delay(25);
    }
    record(`gate-${kind}-released`);
  }
  store.promote = async (tempRef, objectKey) => {
    await gate("promote", objectKey);
    await promoted(tempRef, objectKey);
    record("filesystem-promoted");
  };
  store.remove = async key => {
    await gate("remove", key);
    const result = await removed(key);
    record("filesystem-remove", { removed: result });
    return result;
  };
  store.writeTemp = async (writer, body, maximumBytes, leaseExpiresAt) => writeTemp(writer, (async function* () {
    for await (const chunk of body) {
      yield chunk;
      // Reached when the real store asks for another chunk, after its write.
      record("raw-body-chunk-consumed", { bytes: chunk.byteLength });
    }
  })(), maximumBytes, leaseExpiresAt);
  const binding = await resolveOrderReviewRuntimeBinding({ PLATFORM_BUNDLE: "node-postgres",
    DATABASE_URL: input.connectionString, ORDER_REVIEW_MEDIA_ROOT: "/media" },
  { resources: { executor, transaction, close: () => pool.end() }, store });
  assert(binding);
  record("binding-composed");
  const raw = createOrderReviewRawUploadHandler({ resolveBinding: () => ({ kind: "direct", binding: binding.raw }) });
  const server = createServer((request, response) => {
    const req = request as HttpRequest, res = response as HttpResponse;
    req.query = {};
    res.status = function (status) { this.statusCode = status; return this; };
    res.json = function (body) { this.setHeader("Content-Type", "application/json"); this.end(JSON.stringify(body)); return this; };
    res.send = function (body) { if (typeof body === "string" || Buffer.isBuffer(body)) this.end(body); else this.json(body); return this; };
    res.redirect = function (statusOrUrl: number | string, url?: string) {
      this.statusCode = typeof statusOrUrl === "number" ? statusOrUrl : 302;
      this.setHeader("Location", typeof statusOrUrl === "string" ? statusOrUrl : url!); this.end(); return this;
    };
    void (async () => {
      if (req.headers["x-m14-control"] !== input.control) { res.status(403).json({ code: "FIXTURE_CONTROL_REQUIRED" }); return; }
      if (req.method === "GET" && req.url === "/fixture/status") { res.json({ boot, observations }); return; }
      if (!accepting) { res.status(503).json({ code: "FIXTURE_ADMISSION_STOPPED" }); return; }
      if (req.url === "/raw") { await raw(req, res); record("raw-http-completed", { status: res.statusCode }); return; }
      if (req.method !== "POST") { res.status(405).json({ code: "METHOD_NOT_ALLOWED" }); return; }
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of req) {
        length += chunk.length; if (length > 16_384) { res.status(413).json({ code: "FIXTURE_BODY_TOO_LARGE" }); return; }
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      switch (req.url) {
        case "/review/submit": res.json(await binding.customer.submit(body)); break;
        case "/review/media-intent": res.json(await binding.customer.createMediaIntent(body)); break;
        case "/review/media-confirm": res.json(await binding.customer.confirmMedia(body)); break;
        case "/admin/media-delete": res.json(await binding.deleteAdminMedia(body.actorRef, body.mediaRef, body.idempotencyKey)); break;
        case "/fixture/queue-delete": res.json(await media.prepareAdminDelete(body)); break;
        case "/fixture/stop-admission": accepting = false; record("admission-stopped"); res.json({ accepting }); break;
        default: res.status(404).json({ code: "NOT_FOUND" }); return;
      }
      record("fixture-http-completed", { route: req.url });
    })().catch(error => {
      record("fixture-http-failed", { code: code(error) });
      if (!res.destroyed && !res.writableEnded) res.status(503).json({ code: "FIXTURE_OPERATION_FAILED" });
    });
  });
  server.listen(8080, "0.0.0.0", () => record("http-listening"));
  // Deliberately no drain/close-as-seal endpoint: exact owned process removal is
  // the caller's terminal barrier for HTTP, timers, clients and open descriptors.
}
main().catch(async error => {
  record("startup-failed", { code: code(error) });
  await pool.end().catch(() => undefined);
  process.exitCode = 1;
});
