import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { captureManagedSourceGraph } from "../../server/adapters/postgres/connectedManagedRetained.js";
import { runManagedCompatPostgres } from "../helpers/managedCompatPostgres.js";
import { closePostgres, postgresSetupTimeoutMs, waitForPostgresTcpReady } from "../helpers/postgresContainer.js";

it("admits only exact dormant channel installation rows after the actual two managed forwards", async () => {
  const container = await runManagedCompatPostgres({ name: `m17-8a-actual-forward-${process.pid}`, password: "synthetic-channel-proof" });
  const owner = new Pool({ connectionString: container.connectionString.replace("postgres://postgres:", "postgres://supabase_admin:"), max: 1 });
  try {
    expect(await waitForPostgresTcpReady(container.connectionString)).toBe(true);
    await owner.query(readFileSync("scripts/public-reference/subscription-prereqs.sql", "utf8"));
    for (const role of ["postgres", "supabase_admin"]) for (const scope of ["", " IN SCHEMA public"])
      for (const kind of ["TABLES", "SEQUENCES", "FUNCTIONS"])
        await owner.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${role}${scope} REVOKE ALL ON ${kind} FROM PUBLIC,anon,authenticated,service_role`);
    const baseline = readFileSync("supabase/migrations/00000000000000_platform_schema_baseline.sql");
    expect(createHash("sha256").update(baseline).digest("hex")).toBe("fb4de62d4ccf30dca83075b41ea2769ddf74165ecd47d21875790ed5f397ccbe");
    await owner.query("SET ROLE postgres; SET search_path=public,extensions");
    await owner.query(baseline.toString().replace(/^\\(?:un)?restrict [A-Za-z0-9]+\r?$/gmu, ""));
    const capture = () => captureManagedSourceGraph({ sourceId: "m17-8a-source", maximumRows: 10000, maximumBytes: 64 * 1024 * 1024,
      source: { async withSnapshot(work) {
        const client = await owner.connect();
        try {
          await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL ROLE postgres");
          const result = await work({ query: (sql, values) => client.query(sql, values ? [...values] : undefined) });
          await client.query("COMMIT"); return result;
        } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
      } } });
    const baselineCapture = await capture();
    expect(baselineCapture.dispositions.find(row => row.relation === "public.outbox_dormant_event_types"))
      .toMatchObject({ rows: 0, disposition: "unsupported-empty", reason: "no source class mapping" });
    const before = (await owner.query("SELECT * FROM public.outbox_dormant_event_types ORDER BY event_type")).rows;
    for (const file of ["20261030121000_channel_retained_basis.sql", "20261030122000_channel_purchased_source.sql"])
      await owner.query(readFileSync(`supabase/migrations/${file}`, "utf8"));
    await owner.query("RESET ROLE; SET row_security=on; SET search_path=public,extensions");
    const after = (await owner.query("SELECT * FROM public.outbox_dormant_event_types ORDER BY event_type")).rows;
    expect(before).toEqual([]);
    expect(after.map(row => row.event_type)).toEqual(["channel.pull-page.v1", "channel.purchase-line.v1", "channel.purchase-source.v1"]);
    const installed = await capture();
    expect(installed.dispositions.find(row => row.relation === "public.outbox_dormant_event_types"))
      .toMatchObject({ rows: 3, disposition: "service-installation-history" });
    for (const sql of [
      "UPDATE public.outbox_dormant_event_types SET owner='changed-owner' WHERE event_type='channel.pull-page.v1'",
      "UPDATE public.outbox_dormant_event_types SET reason='changed reason' WHERE event_type='channel.purchase-line.v1'",
      "UPDATE public.outbox_dormant_event_types SET updated_at=created_at+interval '1 microsecond' WHERE event_type='channel.purchase-source.v1'",
      "UPDATE public.outbox_dormant_event_types SET created_at=created_at+interval '1 microsecond' WHERE event_type='channel.purchase-source.v1'",
      "UPDATE public.outbox_dormant_event_types SET created_at=created_at+interval '1 microsecond',updated_at=updated_at+interval '1 microsecond' WHERE event_type='channel.purchase-source.v1'",
      "UPDATE public.outbox_dormant_event_types SET event_type='drifted.event' WHERE event_type='channel.pull-page.v1'",
      "DELETE FROM public.outbox_dormant_event_types WHERE event_type='channel.pull-page.v1'",
      "UPDATE public.outbox_dormant_event_types SET created_at='infinity',updated_at='infinity'",

      "INSERT INTO public.outbox_dormant_event_types(event_type,owner,reason) VALUES('unknown.event','unknown','unknown registration')",
    ]) {
      // Mutations must be committed to observe them through the production snapshot.
      const original = (await owner.query("SELECT to_jsonb(t)::text AS value FROM public.outbox_dormant_event_types t")).rows;
      try {
        await owner.query(sql);
        await expect(capture()).rejects.toMatchObject({ code: "unsupported_table", table: "public.outbox_dormant_event_types" });
      } finally {
        await owner.query("DELETE FROM public.outbox_dormant_event_types");
        for (const row of original) await owner.query("INSERT INTO public.outbox_dormant_event_types SELECT * FROM jsonb_populate_record(NULL::public.outbox_dormant_event_types,$1::jsonb)", [row.value]);
      }
    }
    try {
      await owner.query("INSERT INTO public.sales_channel_connections(slug,connector_provider_kind,connector_shape,display_name) VALUES('unmapped','synthetic','direct','Unmapped')");
      await expect(capture()).rejects.toMatchObject({ code: "unsupported_table", table: "public.sales_channel_connections" });
    } finally { await owner.query("DELETE FROM public.sales_channel_connections WHERE slug='unmapped'"); }
    try {
      await owner.query("ALTER TABLE public.outbox_dormant_event_types ADD COLUMN unexpected_metadata text");
      await expect(capture()).rejects.toMatchObject({ code: "unsupported_table", table: "public.outbox_dormant_event_types" });
    } finally { await owner.query("ALTER TABLE public.outbox_dormant_event_types DROP COLUMN unexpected_metadata"); }
    await expect(capture()).resolves.toBeDefined();
  } finally { await closePostgres(container, owner); }
}, postgresSetupTimeoutMs);
