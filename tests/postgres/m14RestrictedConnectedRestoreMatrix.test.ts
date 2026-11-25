import { Pool, type QueryConfig } from "pg";
import { aroundEach, expect, it } from "vitest";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { closePostgres, dockerAvailable, postgresSetupTimeoutMs } from "../helpers/postgresContainer.js";
import {
  captureRestrictedStore,
  installRestrictedRestore,
  installRestrictedRestorePair,
  restrictedKeyIdentity,
} from "./m14RestrictedConnectedRestore.fixture.js";

const activeSerialFixtures = new Set<Promise<void>>();

aroundEach(async (runTest, { signal }) => {
  // Vitest can time out the case without cancelling its database work.
  await Promise.all(activeSerialFixtures);
  signal.throwIfAborted();
  await runTest();
}, postgresSetupTimeoutMs);

function trackFixture(work: () => Promise<void>) {
  const result = work();
  const drained = result.then(() => undefined, () => undefined);
  activeSerialFixtures.add(drained);
  void drained.then(() => activeSerialFixtures.delete(drained));
  return result;
}

function restoreTest(name: string, work: () => Promise<void>, timeout: number) {
  it(name, () => trackFixture(work), timeout);
}

for (const shape of ["neon", "rds"] as const) for (const mode of ["installer-managed", "operator-provisioned"] as const) {
  restoreTest(`admits ${shape}-shaped ${mode} control-plane roles before installation`, async () => {
    if (!await dockerAvailable()) throw new Error("Restricted admission requires disposable PostgreSQL 16");
    const fixture = await installRestrictedRestore(shape, mode, "admission", false);
    try {
      const provider = shape === "neon" ? "neon_superuser" : "rds_superuser";
      await fixture.pools[0]!.query(`REVOKE ${provider} FROM host_bootstrap`);
      await expect(fixture.runner.status()).rejects.toThrow("control_plane_membership_missing");
      await fixture.pools[0]!.query(`GRANT ${provider} TO host_bootstrap WITH ADMIN TRUE, INHERIT TRUE, SET TRUE`);
      await fixture.pools[0]!.query("CREATE ROLE rogue_host CREATEROLE");
      await expect(fixture.runner.status()).rejects.toThrow("outside_role_has_host_authority");
    } finally { await closePostgres(fixture.container, fixture.pools); }
  }, postgresSetupTimeoutMs);
  restoreTest(`restores a connected native graph through ${shape}-shaped ${mode} admission`, async () => {
    if (!await dockerAvailable()) throw new Error("Restricted restore requires disposable PostgreSQL 16");
    const [source, target] = await installRestrictedRestorePair(shape, mode, "source", "target");
    try {
      const { rows: [subscription] } = await source.owner.query<{ id: string }>(`WITH client AS (
        INSERT INTO public.clients(email,lifecycle_stage) VALUES('restricted@example.invalid','lead') RETURNING id
      )
      INSERT INTO public.subscriptions(client_id,cadence_days,next_cycle_at)
        SELECT id,28,'2026-11-29T12:00:00Z' FROM client RETURNING id`);
      await source.owner.query(`INSERT INTO public.subscription_edit_quotes(subscription_id,idempotency_key,request_fingerprint,
        quote_hash,expected_template_version,proposed_lines,proposed_cadence_days,current_total_minor,new_total_minor,currency_code,expires_at)
        VALUES($1,'fixture-quote',repeat('b',64),repeat('c',64),1,'[]',28,200,200,'XXX','2026-11-02')`, [subscription!.id]);
      await source.owner.query(`INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload)
        VALUES('synthetic','10000000-0000-4000-8000-000000000001','synthetic.retained','restricted-ordinary-outbox','{}')`);
      const packet = await captureRestrictedStore(source, "restricted-source");
      const quotes = packet.owned.find(entry => entry.table === "subscription_edit_quotes");
      expect(quotes!.rows).toHaveLength(1);
      const freshTarget = await captureRestrictedStore(target, "restricted-target");
      expect((await source.runner.status()).pending).toEqual([]);
      expect((await target.runner.status()).pending).toEqual([]);
      expect(packet.observation.cluster).not.toBe(freshTarget.observation.cluster);
      const provider = shape === "neon" ? "neon_superuser" : "rds_superuser";
      await target.pools[0]!.query(`GRANT ${provider} TO restore_r`);
      await expect(target.runner.status()).rejects.toThrow("protected_membership_graph_differs");
      await target.pools[0]!.query(`REVOKE ${provider} FROM restore_r`);
      const beforeKey = await restrictedKeyIdentity(target);
      const input = { owner: target.owner, installation: target.selection, packet, freshTarget };
      await target.owner.query("INSERT INTO public.commerce_settings(key,value_minor) VALUES('transfer_conflict',1)");
      await expect(restoreConnectedNativeStore(input)).rejects.toMatchObject({ code: "target_conflict" });
      await target.owner.query("DELETE FROM public.commerce_settings WHERE key='transfer_conflict'");
      expect((await target.runner.status()).pending).toEqual([]);
      expect((await restoreConnectedNativeStore(input)).replayed).toBe(false);
      expect((await target.owner.query("SELECT email FROM public.clients")).rows).toEqual([{ email: "restricted@example.invalid" }]);
      expect((await captureRestrictedStore(target, "restricted-restored")).owned.find(entry => entry.table === "subscription_edit_quotes")).toEqual(quotes);
      expect((await restoreConnectedNativeStore(input)).replayed).toBe(true);
      expect((await target.owner.query("SELECT event_type FROM public.outbox_events")).rows).toEqual([{ event_type: "synthetic.retained" }]);
      if (shape === "neon" && mode === "installer-managed") {
        // A separate administrator changes the ledger after the first exact
        // read but just before restore locks the table. Replay must recheck it.
        const root = target.pools[0]!;
        const original = (await root.query<{ sha256: string }>(
          "SELECT sha256 FROM public.platform_schema_migrations WHERE position=0")).rows[0]!.sha256;
        const changed = `${original[0] === "f" ? "e" : "f"}${original.slice(1)}`;
        let raced = false, closed = false;
        const racingOwner = { async connect() {
          const client = await target!.owner.connect();
          return {
            async query(sql: string | QueryConfig, values?: unknown[]) {
              const text = typeof sql === "string" ? sql : sql.text;
              if (!raced && text.startsWith("LOCK TABLE ") && text.includes('"public"."platform_schema_migrations"')) {
                await root.query("UPDATE public.platform_schema_migrations SET sha256=$1 WHERE position=0", [changed]);
                raced = true;
              }
              const result = typeof sql === "string" ? await client.query(sql, values) : await client.query(sql);
              if (text.startsWith("REVOKE platform_acquisition_owner")) closed = true;
              return result;
            },
            release: (destroy?: boolean) => client.release(destroy),
          };
        } } as unknown as Pool;
        try {
          await expect(restoreConnectedNativeStore({ ...input, owner: racingOwner })).rejects.toMatchObject({ code: "schema_conflict" });
          expect(raced).toBe(true);
          expect(closed).toBe(true);
        } finally {
          await root.query("UPDATE public.platform_schema_migrations SET sha256=$1 WHERE position=0", [original]);
        }
        expect((await restoreConnectedNativeStore(input)).replayed).toBe(true);
      }
      expect(await restrictedKeyIdentity(target)).toEqual(beforeKey);
      await expect(restoreConnectedNativeStore({ ...input, freshTarget: packet })).rejects.toMatchObject({ code: "invalid_input" });
      const restoreLogin = new Pool({ connectionString: (() => {
        const url = new URL(target.container.connectionString); url.username = target.selection.restoreLogin; return url.toString();
      })() });
      target.pools.push(restoreLogin);
      await expect(restoreLogin.query("UPDATE public.clients SET email='forbidden@example.invalid'")).rejects.toMatchObject({ code: "42501" });
      await expect(restoreLogin.query("SELECT * FROM acquisition_private.installation_key")).rejects.toMatchObject({ code: "42501" });
    } finally {
      await closePostgres([target.container, source.container], [...target.pools, ...source.pools]);
    }
  // About 4x the slowest hosted run (60,506 ms), rounded up to 5 s.
  }, 245_000);
}
