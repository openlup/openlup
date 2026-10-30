// Finite synthetic recipe application, bundled into each immutable OCI fixture image.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { Client, Pool } from "pg";
import { checkServerIdentity } from "node:tls";
import cron from "node-cron";
import { createServer as createTlsServer } from "node:https";
import { createBundleComposer, createNodeHost } from "@openlup/platform/composition";
import { createNodeHttpRuntime, decorateRequest, decorateResponse } from "@openlup/platform/http";
import { createCapturedTransactionalDelivery } from "@openlup/platform/communications";
import { createPostgresOutboxStore } from "@openlup/outbox/postgres";
import { readOutboxDispatchConfig, runOutboxDispatchWorker } from "@openlup/outbox";
import { createPgAdvisoryLock } from "@openlup/platform/scheduler";
import { readProcessEnvironment } from "../../../server/_lib/observability/runtimeProvenance.js";

const env = readProcessEnvironment();
const release = readFileSync("/app/release", "utf8").trim();
const database = { connectionString: env.DATABASE_URL, ssl: { ca: readFileSync("/run/ca.pem", "utf8"),
  rejectUnauthorized: true, checkServerIdentity: (_host: string, cert: Parameters<typeof checkServerIdentity>[1]) => checkServerIdentity(env.RECIPE_TLS_SERVER_NAME!, cert) } };
const pool = new Pool({ ...database, max: 3 });
const lockClient = new Client(database); await lockClient.connect();
const advisoryLock = createPgAdvisoryLock(lockClient, () => lockClient.end());
const store = createPostgresOutboxStore({ query: (sql, values) => pool.query(sql, values ? [...values] : undefined) });
const delivery = createCapturedTransactionalDelivery({ outcome: command => {
  const path = `/state/mail-${command.idempotencyKey}.json`;
  if (!existsSync(path)) writeFileSync(path, JSON.stringify(command), { mode: 0o600, flag: "wx" });
  return { state: "accepted" };
} });
const handler = { eventType: "recipe.delivery", timeoutMs: 15000, async handle(row: { id: string }) {
  await delivery.deliver({ idempotencyKey: row.id, recipientReference: "recipe-customer@example.invalid", templateReference: "recipe-notice" });
  return { kind: "processed" as const };
} };
const dispatch = () => runOutboxDispatchWorker({ store, registry: new Map([[handler.eventType, handler]]),
  knownEventTypes: [handler.eventType], config: readOutboxDispatchConfig({}) });
const state = async () => ({ release, node: process.version,
  login: (await pool.query("SELECT current_user AS login")).rows[0].login,
  events: (await pool.query("SELECT id::text,status FROM public.outbox_events WHERE event_type='recipe.delivery' ORDER BY id")).rows,
  mail: readdirSync("/state").filter(name => name.startsWith("mail-")).length,
  storage: existsSync("/state/retained.txt") ? readFileSync("/state/retained.txt", "utf8") : null });
const route = (path: string, body: (res: { json(value: unknown): unknown; setHeader(name: string, value: string): unknown; end(value?: string): unknown }) => Promise<unknown>) => ({
  path, load: async () => ({ default: async (_req: unknown, res: Parameters<typeof body>[0]) => body(res) }),
});
const runtime = createNodeHttpRuntime({ routes: [], dispatch: async () => false,
  security: { globalHeaders: [], assetCachePrefixes: [], noindexFamilies: [], noindexExacts: [], isProductionHost: () => false },
  extraEntrypoints: [
    route("/", async res => { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(`<!doctype html><html lang="en"><title>Local recipe</title><button id="refresh">Read state</button><pre id="state"></pre><script>async function read(){document.querySelector('#state').textContent=JSON.stringify(await (await fetch('/api/state')).json())}document.querySelector('#refresh').onclick=read;read()</script></html>`); }),
    route("/api/state", async res => res.json(await state())),
    route("/api/dispatch", async res => res.json(await dispatch())),
  ] });
// The deployment-owned HttpRuntimePort.listen seam supplies native TLS without a proxy.
if (env.RECIPE_HTTPS === "true") runtime.listen = async ({ port, host: bindHost }) => {
  const server = createTlsServer({ cert: readFileSync("/run/host-cert.pem"), key: readFileSync("/run/host-key.pem") },
    (req, res) => { void runtime.handle(decorateRequest(req), decorateResponse(res)); });
  runtime.server = server;
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(port, bindHost, done); });
};
const composer = createBundleComposer({ http: () => runtime });
const host = createNodeHost({ composeBundle: composer, createHttpRuntime: () => runtime,
  loadSchedulerJobs: () => [{ jobId: "recipe-delivery", path: "/api/cron/recipe-delivery", schedule: "* * * * * *" }],
  scheduledJobHandlers: () => ({ "recipe-delivery": async () => {
    if (!existsSync("/state/schedule")) return;
    if (existsSync("/state/hold")) {
      writeFileSync("/state/entered", "scheduled callback admitted");
      const deadline = Date.now() + 20000;
      while (existsSync("/state/hold")) { if (Date.now() > deadline) throw new Error("recipe_drain_release_missing"); await delay(50); }
    }
    const result = await dispatch(); if (!result.ok) throw new Error("recipe_scheduled_dispatch_failed");
  } }), log: () => {} });
const served = await host.serveNode({ env, cron, advisoryLock, port: env.RECIPE_HTTPS === "true" ? 443 : 8080 });
const bundle = composer(env);
if (!await bundle.ports.blob!.exists("retained.txt")) await bundle.ports.blob!.upload("retained.txt", Buffer.from("durable local recipe bytes"));
let stopping = false;
process.on("SIGTERM", () => {
  if (stopping) return; stopping = true;
  void served.stop().then(() => pool.end()).then(() => { process.exitCode = 0; }).catch(() => { process.exitCode = 1; });
});
