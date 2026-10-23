import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Pool } from "pg";
import { createPostgresPaymentTruthPort } from "@openlup/platform/payments";
import type { PaymentTruthEvent } from "@openlup/platform/payments/contracts";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { readSelectedCatalogProjection, selectedCatalogProjectionPayload } from "../../server/adapters/postgres/selectedCatalogProjection.js";
import type { PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { dockerAvailable, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "./postgresContainer.js";
import { fixture } from "./fulfillmentNative.js";

export const manifest: PlatformMigrationManifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
export const units = [manifest.baseline, ...manifest.forward];
// Preserve the complete installed prefix before the three M09 units.
export const prefixLength = units.findIndex(unit => unit.file.endsWith("20261022190000_invoicing_durable_duties.sql"));
export const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
export function invoicingNativeHarness() {
  let container: PostgresContainer | undefined;
  let pool: Pool;
  let prefixRoot: string | undefined;
  let freshDigest: string;
  let prefixRows: unknown[];
  let prefixHistory: unknown[];
  let resumeHistory: unknown[];
  let witness: Awaited<ReturnType<typeof fixture>>;
  let replay: { applied: readonly string[]; pending: readonly unknown[] };
  let legacyInput: PaymentTruthEvent;
  let legacyRow: unknown;
  let legacyEventId: string;
  let upgradeFiles: readonly string[];
  let historicUninvoicedOrder:string;
  return {
    get pool() { return pool; },
    get freshDigest() { return freshDigest; },
    get prefixRows() { return prefixRows; },
    get prefixHistory() { return prefixHistory; },
    get resumeHistory() { return resumeHistory; },
    get witness() { return witness; },
    get replay() { return replay; },
    get legacy() { return { input:legacyInput, row:legacyRow, eventId:legacyEventId }; },
    get historicUninvoicedOrder() { return historicUninvoicedOrder; },
    get upgradeFiles() { return upgradeFiles; },
    runner(root = process.cwd()) { return createPostgresMigrationRunner({ connectionString: container!.connectionString }, { root, poolFactory: () => pool }); },
    async start() {
      if (!await dockerAvailable()) throw new Error("M09 invariants require real PostgreSQL; skipping is not proof");
      const at = performance.now();
      container = await runPostgresContainer({ name: `m09-invoicing-${process.pid}`, password: "synthetic-conformance" });
      if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("M09 PostgreSQL TCP unavailable");
      pool = new Pool({ connectionString: container.connectionString });
      // One fresh complete install. Roll it back, including cluster-wide role
      // creation, so the immutable role bootstrap can run in the prefix proof.
      const db = await pool.connect();
      let prefixDigest: string;
      let firstForwardDigest: string;
      try {
        await db.query("BEGIN");
        for (const [position, unit] of units.entries()) {
          const bytes = readFileSync(unit.file);
          if (sha256(bytes) !== unit.sha256) throw new Error(`M09 catalogue byte drift: ${unit.file}`);
          await db.query(bytes.toString("utf8"));
          await db.query("INSERT INTO public.platform_schema_migrations(catalog_path,sha256,position) VALUES($1,$2,$3)", [unit.file, unit.sha256, position]);
          if (position === prefixLength - 1) prefixDigest = sha256(selectedCatalogProjectionPayload(await readSelectedCatalogProjection(db)));
          if (position === prefixLength) firstForwardDigest = sha256(selectedCatalogProjectionPayload(await readSelectedCatalogProjection(db)));
        }
        freshDigest = sha256(selectedCatalogProjectionPayload(await readSelectedCatalogProjection(db)));
        if (freshDigest !== manifest.objectInventorySha256) throw new Error(`M09 fresh object inventory mismatch ${freshDigest}`);
      } finally { await db.query("ROLLBACK"); db.release(); }
      prefixRoot = mkdtempSync(join(tmpdir(), "m09-prefix-"));
      for (const unit of units.slice(0, prefixLength)) {
        const path = join(prefixRoot, unit.file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, readFileSync(unit.file));
      }
      mkdirSync(join(prefixRoot, "config"));
      writeFileSync(join(prefixRoot, "config/platform-migration-manifest.json"), JSON.stringify({ ...manifest, forward: manifest.forward.slice(0, prefixLength - 1), objectInventorySha256: prefixDigest! }));
      await this.runner(prefixRoot).apply();
      witness = await fixture(pool);
      const client=randomUUID(),order=randomUUID(),intent=randomUUID();
      await pool.query("INSERT INTO public.clients(id,email) VALUES($1,$2)",[client,`${client}@example.invalid`]);
      const seed=await pool.connect();try {
        await seed.query("BEGIN");
        await seed.query("INSERT INTO public.commerce_orders(id,client_id,currency_code,total_amount_minor) VALUES($1,$2,'XXX',900)",[order,client]);
        await seed.query("INSERT INTO public.commerce_order_items(order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES($1,1,1,900,900)",[order]);
        await seed.query("INSERT INTO public.commerce_settlement_intents(id,order_id,channel_key,amount_minor,currency_code,open_idempotency_key) VALUES($1,$2,'fixture',900,'XXX',$3)",[intent,order,`legacy-open-${intent}`]);
        await seed.query("COMMIT");
      }catch(error){await seed.query("ROLLBACK");throw error;}finally{seed.release();}
      legacyInput={sourceEventId:`legacy:${intent}`,idempotencyKey:`legacy-${intent}`,settlementIntentId:intent,outcome:"captured",amountMinor:900,currency:"XXX",occurredAt:"2026-08-12T12:00:00Z",failure:null,
        evidence:{sourceKind:"accepted_event",sourceReference:`legacy:${intent}`,observedStatus:"captured",observedAt:"2026-08-12T12:00:00Z",payloadFingerprint:"a".repeat(64)}};
      const truth=createPostgresPaymentTruthPort({query:(sql,values)=>pool.query(sql,values)},{dunningTemplateSlug:"payment_failed",recoveryUrlPath:"/recover",recoveryTemplateSlug:"payment_recovered"});
      const old=await truth.ingestEvent(legacyInput);
      if(!old.effects.accountingRequested)throw new Error("Prefix must retain the original inline accounting witness");
      legacyEventId=old.event.id;legacyRow=(await pool.query("SELECT * FROM public.payment_truth_events WHERE id=$1",[old.event.id])).rows[0];
      historicUninvoicedOrder=randomUUID();const historicIntent=randomUUID();
      const historical=await pool.connect();try {
        await historical.query("BEGIN");
        await historical.query("INSERT INTO public.commerce_orders(id,client_id,currency_code,total_amount_minor) VALUES($1,$2,'XXX',900)",[historicUninvoicedOrder,client]);
        await historical.query("INSERT INTO public.commerce_order_items(order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES($1,1,1,900,900)",[historicUninvoicedOrder]);
        await historical.query("INSERT INTO public.commerce_settlement_intents(id,order_id,channel_key,amount_minor,currency_code,open_idempotency_key) VALUES($1,$2,'fixture',900,'XXX',$3)",[historicIntent,historicUninvoicedOrder,`historic-${historicIntent}`]);
        await historical.query("SELECT public.commerce_record_settlement($1,$2,'succeeded',NULL,'{}',now())",[`historic-${historicIntent}`,historicIntent]);
        await historical.query("COMMIT");
      }catch(error){await historical.query("ROLLBACK");throw error;}finally{historical.release();}
      const scaleAt=performance.now();
      await pool.query(`INSERT INTO public.commerce_settlement_transitions(intent_id,from_status,to_status,outcome,idempotency_key)
        SELECT $1,'open','succeeded','succeeded','scale-paid-'||n FROM generate_series(1,20000) n`,[historicIntent]);
      await pool.query("UPDATE public.fulfillment_shipments SET handed_over_at=now() WHERE id=$1",[witness.shipment]);
      await pool.query(`INSERT INTO public.fulfillment_shipment_operations(shipment_id,order_id,operation_type,idempotency_key,payload)
        SELECT $1,$2,'shipment_advanced','scale-handoff-'||n,'{"toStatus":"handed_over"}' FROM generate_series(1,20000) n`,[witness.shipment,witness.order]);
      console.log(`M09 scale seed paid=20000 handoff=20000 ms=${Math.round(performance.now()-scaleAt)}`);
      prefixRows = (await pool.query("SELECT * FROM public.commerce_orders WHERE id=$1", [witness.order])).rows;
      prefixHistory = (await pool.query("SELECT * FROM public.platform_schema_migrations ORDER BY position")).rows;
      // Model interruption after the first new unit, then resume the exact prefix.
      const first=units[prefixLength];const firstPath=join(prefixRoot,first.file);
      mkdirSync(dirname(firstPath),{recursive:true});writeFileSync(firstPath,readFileSync(first.file));
      writeFileSync(join(prefixRoot,"config/platform-migration-manifest.json"),JSON.stringify({...manifest,forward:manifest.forward.slice(0,prefixLength),objectInventorySha256:firstForwardDigest!}));
      const firstApplied=(await this.runner(prefixRoot).apply()).applied;
      resumeHistory=(await pool.query("SELECT * FROM public.platform_schema_migrations ORDER BY position")).rows;
      upgradeFiles = [...firstApplied,...(await this.runner().apply()).applied];
      // Capture native runner replay before semantic cases mutate fixture data.
      replay = { ...(await this.runner().apply()), pending: (await this.runner().status()).pending };
      console.log(`M09 setup fresh+prefix-upgrade ms=${Math.round(performance.now()-at)}`);
    },
    async stop() { await pool?.end(); await container?.remove(); if (prefixRoot) rmSync(prefixRoot, { recursive: true, force: true }); },
  };
}
