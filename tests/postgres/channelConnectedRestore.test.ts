import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, type QueryConfig } from "pg";
import { expect, it } from "vitest";
import { selectPlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { captureConnectedNativeStore, type ConnectedNativeStoreCapture } from "../../server/adapters/postgres/connectedStoreCapture.js";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedPostgresStartupOptions, type QualifiedPostgresInstallation } from "../../server/adapters/postgres/qualifiedInstall.js";
import { channelPurchaseFixture } from "../helpers/channelPurchaseFixture.js";
import { closePostgres, postgresSetupTimeoutMs, runPostgresContainer, waitForPostgresTcpReady } from "../helpers/postgresContainer.js";

const selection: QualifiedPostgresInstallation = { generation: "qualified-v2", roleMode: "installer-managed",
  migrationLogin: "channel_restore_owner", bootstrapLogin: "postgres", runtimeLogin: "channel_restore_runtime", restoreLogin: "channel_restore_login" };
const manifest = selectPlatformMigrationManifest(JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")),
  "qualified-v2", { migrationIsBootstrap: false, hasRestore: true });

async function install(label: string) {
  const container = await runPostgresContainer({ name: `m17-connected-${label}-${process.pid}`, password: "synthetic-channel-restore" });
  const pools: Pool[] = [];
  try {
    expect(await waitForPostgresTcpReady(container.connectionString)).toBe(true);
    const pool = (connectionString: string) => { const p = new Pool({ connectionString }); pools.push(p); return p; };
    const bootstrap = pool(container.connectionString);
    await bootstrap.query(`CREATE ROLE channel_restore_owner LOGIN INHERIT SUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-channel-restore';
      ALTER DATABASE postgres OWNER TO channel_restore_owner;
      CREATE ROLE channel_restore_runtime LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-channel-restore';
      CREATE ROLE channel_restore_login LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-channel-restore'`);
    const url = new URL(container.connectionString); url.username = selection.migrationLogin;
    url.searchParams.set("options", qualifiedPostgresStartupOptions(selection));
    const owner = pool(url.toString());
    const runner = createPostgresMigrationRunner({ connectionString: url.toString() }, { installation: selection, poolFactory: () => owner });
    expect((await runner.apply()).applied).toHaveLength(1 + manifest.forward.length);
    return { container, pools, owner };
  } catch (error) { await closePostgres(container, pools); throw error; }
}
async function capture(owner: Pool, sourceId: string) {
  return captureConnectedNativeStore({ sourceId, catalogueId: manifest.objectInventorySha256, maximumRows: 10000, maximumBytes: 64 * 1024 * 1024,
    source: { async withSnapshot(work) {
      const client = await owner.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const result = await work({ query: (sql, values) => client.query(sql, values ? [...values] : undefined) });
        await client.query("COMMIT"); return result;
      } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    } } });
}
function withOutboxRow(packet: ConnectedNativeStoreCapture, row: string): ConnectedNativeStoreCapture {
  const copy = structuredClone(packet);
  copy.compatible.tables.find(table => table.table === "outbox_events")!.rows = [row];
  const hash = (body: unknown) => createHash("sha256").update(JSON.stringify(body)).digest("hex");
  const { sha256: _inner, ...inner } = copy.compatible; copy.compatible.sha256 = hash(inner);
  const { sha256: _outer, ...outer } = copy; copy.sha256 = hash(outer);
  return copy;
}

it("preserves unknown-trigger refusal and rejects channel source outbox rows with atomic rollback", async () => {
  const source = await install("source");
  let target: Awaited<ReturnType<typeof install>> | undefined;
  try {
    target = await install("target");
    await source.owner.query("INSERT INTO public.clients(email,lifecycle_stage) VALUES('channel-restore@example.invalid','lead')");
    await source.owner.query(`INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload,metadata)
      VALUES('synthetic','10000000-0000-4000-8000-000000000001','synthetic.retained','channel-restore-source','{}','{}')`);
    const packet = await capture(source.owner, "channel-source"), freshTarget = await capture(target.owner, "channel-target");
    const input = { owner: target.owner, installation: selection, packet, freshTarget };
    const before = await capture(target.owner, "channel-target");
    const data = (value: ConnectedNativeStoreCapture) => ({ compatible: value.compatible.tables, owned: value.owned, outside: value.outsideProfileCensus });
    try {
      await target.owner.query(`CREATE TRIGGER channel_restore_unknown BEFORE INSERT ON public.outbox_events
        FOR EACH ROW EXECUTE FUNCTION public.channel_purchase_guard()`);
      await expect(restoreConnectedNativeStore(input)).rejects.toMatchObject({ code: "schema_conflict" });
      expect(data(await capture(target.owner, "channel-target"))).toEqual(data(before));
    } finally { await target.owner.query("DROP TRIGGER IF EXISTS channel_restore_unknown ON public.outbox_events"); }
    const fixtureClient = await source.owner.connect();
    let validRows: { event_type: string; value: string }[];
    try {
      await fixtureClient.query("BEGIN");
      const fixture = await channelPurchaseFixture(fixtureClient, "portable");
      await fixture.source.recordPage(fixture.page);
      await fixture.source.recordCapture(fixture.capture);
      validRows = (await fixtureClient.query<{ event_type: string; value: string }>(`SELECT event_type,to_jsonb(o)::text AS value
        FROM public.outbox_events o WHERE event_type IN ('channel.purchase-source.v1','channel.purchase-line.v1','channel.pull-page.v1') ORDER BY event_type`)).rows;
    } finally { await fixtureClient.query("ROLLBACK"); fixtureClient.release(); }
    expect(validRows.map(row => row.event_type)).toEqual(["channel.pull-page.v1", "channel.purchase-line.v1", "channel.purchase-source.v1"]);
    for (const row of validRows) {
      let insertedClient = false, attemptedProtectedInsert = false;
      const observedOwner = { async connect() {
        const client = await target!.owner.connect();
        return { async query(sql: string | QueryConfig, values?: unknown[]) {
          const text = typeof sql === "string" ? sql : sql.text;
          if (text.startsWith('INSERT INTO public."outbox_events"')) attemptedProtectedInsert = true;
          const result = typeof sql === "string" ? await client.query(sql, values) : await client.query(sql);
          if (text.includes("SELECT public.client_import_retained_row")) insertedClient = true;
          return result;
        }, release: (destroy?: boolean) => client.release(destroy) };
      } } as unknown as Pool;
      await expect(restoreConnectedNativeStore({ ...input, owner: observedOwner, packet: withOutboxRow(packet, row.value) }))
        .rejects.toMatchObject({ code: "unsupported_table", table: "outbox_events" });
      expect(insertedClient).toBe(true);
      expect(attemptedProtectedInsert).toBe(false);
      const ordinary = await target.owner.connect();
      try {
        await ordinary.query("BEGIN; SET LOCAL ROLE channel_restore_runtime");
        await expect(ordinary.query(`INSERT INTO public.outbox_events SELECT * FROM pg_catalog.jsonb_populate_record(NULL::public.outbox_events,$1::jsonb)`, [row.value]))
          .rejects.toMatchObject({ code: "P0001", message: "channel_purchase_source_immutable" });
      } finally { await ordinary.query("ROLLBACK"); ordinary.release(); }


      expect(data(await capture(target.owner, "channel-target"))).toEqual(data(before));
    }
    // The finite ordinary graph must succeed without disabling the admitted trigger.
    expect((await restoreConnectedNativeStore(input)).replayed).toBe(false);
    expect((await target.owner.query("SELECT email FROM public.clients")).rows).toEqual([{ email: "channel-restore@example.invalid" }]);
    expect((await restoreConnectedNativeStore(input)).replayed).toBe(true);
  } finally {
    if (target) await closePostgres(target.container, target.pools);
    await closePostgres(source.container, source.pools);
  }
}, postgresSetupTimeoutMs * 2);
