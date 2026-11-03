import assert from "node:assert/strict";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Pool } from "pg";
import { createPostgresDataGateway } from "@openlup/platform/data";
import { createApplication } from "./app.mjs";

test("own routes/auth with PostgreSQL success, refusal and durable replay", { timeout: 30_000 }, async () => {
  let config;
  try { config = JSON.parse(readFileSync("./app.local.json", "utf8")); }
  catch { throw new Error("test_configuration_required"); }
  assert.ok(typeof config?.databaseUrl === "string" && config.databaseUrl.trim(),
    "Set databaseUrl in app.local.json to a disposable qualified-v2 runtime login");
  const pool = new Pool({ connectionString: config.databaseUrl, max: 2 });
  const data = createPostgresDataGateway({ connectionString: "" }, { poolFactory: () => pool });
  const token = randomBytes(32).toString("hex");
  const draftId = randomUUID();
  const command = {
    schemaVersion: 1, action: "create", draftId, commandKey: `create:${randomUUID()}`, expectedRevision: 0,
    payload: { schemaVersion: 1,
      product: { id: randomUUID(), type: { key: "example:item", version: 1 }, dimensions: [],
        sharedContent: { title: "Sample item" } },
      skus: [],
    },
  };
  let server;
  let base;
  async function start() {
    server = createApplication({ pool, operatorToken: token });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;
  }
  const stop = () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  async function post(input, authorization = `Bearer ${token}`) {
    const response = await fetch(`${base}/drafts`, { method: "POST",
      headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}),
        "x-actor-id": "untrusted:operator" },
      body: JSON.stringify(input),
    });
    return { status: response.status, body: await response.json() };
  }
  async function snapshot() {
    return data.asService(async (db) => {
      const rows = {};
      for (const table of ["catalog_draft_heads", "catalog_draft_revisions", "catalog_draft_command_receipts",
        "catalog_draft_sku_reservations"]) {
        // Fixed application table names; only the fresh draft ID is request data.
        rows[table] = (await db.query(`SELECT to_jsonb(t) AS value, xmin::text AS version
          FROM public.${table} t WHERE draft_id=$1 ORDER BY to_jsonb(t)::text`, [draftId])).rows;
      }
      return rows;
    });
  }
  try {
    const { rows: [identity] } = await pool.query(`SELECT current_user, rolsuper, rolbypassrls,
      pg_get_userbyid(c.relowner)=current_user AS owns_drafts,
      current_setting('server_version_num')::int AS version
      FROM pg_roles r CROSS JOIN pg_class c
      WHERE r.rolname=current_user AND c.oid='public.catalog_draft_heads'::regclass`);
    assert.equal(identity.rolsuper, false, "The application must not use the bootstrap superuser");
    assert.equal(identity.rolbypassrls, false);
    assert.equal(identity.owns_drafts, false);
    assert.ok(identity.version >= 160000 && identity.version < 170000, "This witness selects PostgreSQL 16");
    assert.equal(await data.asService(async (db) => (await db.query("SELECT current_user")).rows[0].current_user), "service_role");
    await start();
    const empty = await snapshot();
    assert.deepEqual(await post(command, ""), { status: 401, body: { reason: "operator_required" } });
    assert.deepEqual(await post(command, `Bearer ${randomBytes(32).toString("hex")}`),
      { status: 401, body: { reason: "operator_required" } });
    assert.equal((await post({ ...command, actorId: "untrusted:operator" })).status, 422);
    assert.equal((await fetch(`${base}/unknown`)).status, 404);
    assert.equal((await fetch(`${base}/drafts`)).status, 405);
    for (const [body, status] of [["{", 400], ["x".repeat(65_537), 413]]) {
      const response = await fetch(`${base}/drafts`, { method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body });
      assert.equal(response.status, status);
      await response.arrayBuffer();
    }
    assert.deepEqual(await snapshot(), empty);

    const success = await post(command);
    assert.equal(success.status, 201);
    assert.equal(success.body.outcome, "committed");
    assert.equal(success.body.record.actorId, "app:catalog-editor");
    assert.equal(success.body.record.revision, 1);
    const committed = await snapshot();
    assert.equal(committed.catalog_draft_heads.length, 1);
    assert.equal(committed.catalog_draft_revisions.length, 1);
    assert.equal(committed.catalog_draft_command_receipts.length, 1);
    assert.equal(committed.catalog_draft_revisions[0].value.actor_id, "app:catalog-editor");
    assert.deepEqual(committed.catalog_draft_revisions[0].value.payload, command.payload);

    const changed = structuredClone(command);
    changed.payload.product.sharedContent.title = "Different item";
    assert.deepEqual(await post(changed), { status: 409,
      body: { outcome: "conflict", reason: "draft_command_key_reused" } });
    assert.deepEqual(await snapshot(), committed);

    await stop();
    await start(); // New auth/handler instances: replay must come from PostgreSQL.
    const replay = await post(command);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.outcome, "replayed");
    assert.deepEqual(replay.body.record, success.body.record);
    assert.deepEqual(await snapshot(), committed);
    console.log("PostgreSQL 16: committed; conflict refused; replayed after application restart; one durable receipt; app-owned actor");
  } finally {
    if (server?.listening) await stop();
    await pool.end();
  }
});
