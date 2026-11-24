import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Pool, type PoolClient } from "pg";
import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createPostgresPrivacyStore, createPostgresPrivacyUnitOfWork } from "@openlup/platform/identity";
import { readPlatformMigrationManifest, type PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { captureConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreCapture.js";
import { composeNativePrivacy } from "../../server/runtime/auth/privacyBinding.js";
import { runManagedCompatPostgres } from "../helpers/managedCompatPostgres.js";
import { closePostgres, postgresSetupTimeoutMs } from "../helpers/postgresContainer.js";
import { createAccountMutationsTemplate } from "./customerAccountMutations.fixture.js";

const forward = "db/platform/migrations/20261125200000_identity_privacy_required_contributors.sql";
const predecessor = "db/platform/migrations/20261125130000_commerce_destination_v2_order_bindings.sql";
const table = "public.identity_privacy_required_contributors";
const reader = "public.identity_privacy_required_contributor_ids()";
const owners = ["communication-events", "customer-billing", "customer-preferences", "customer-saved-addresses",
  "destination-documents", "destination-receipts", "fulfillment-parcel-contacts", "identity", "subscriptions"];
const before = {
  legacy: "ca696d64005b2677a15b5455bb712a02549bd05bb9328a318aad51258f159418",
  bootstrap: "d48147ca30581b5e0643ea71682ba1e5d6e89c3adfa75b559698e0181348a027",
  separate: "c3acf6951151760568bec2d1347920b6a58004deadc8c3696afc55a71773f73a",
  "admin-managed": "30d00712c3144f984f58f183a3b0208251a56c5f349c1560c1a63b5ab5ce4143",
  "admin-operator": "84631c4a0bdacd47563dd39e3bbea4363e5ee59bca21622239a9ecf4b4734bda",
};
const ledger = (db: Pool) => db.query("SELECT * FROM public.platform_schema_migrations ORDER BY position").then(result => result.rows);
const required = (db: Pool | PoolClient) => db.query<{ ids: string[] }>(`SELECT ${reader} AS ids`).then(result => result.rows[0].ids);

function prepareExactPrefix(root: string) {
  const manifest = readPlatformMigrationManifest(process.cwd()) as PlatformMigrationManifest | null;
  if (manifest?.schemaVersion !== 3) throw new Error("Expected the qualified platform manifest");
  manifest.objectInventorySha256 = before.legacy;
  manifest.qualified.objectInventorySha256 = { bootstrapMigrator: { withRestore: before.bootstrap }, separateMigrator: { withRestore: before.separate } };
  manifest.qualifiedAdmin.objectInventorySha256 = { installerManaged: before["admin-managed"], operatorProvisioned: before["admin-operator"] };
  for (const plan of [manifest, manifest.qualified, manifest.qualifiedAdmin]) {
    const end = plan.forward.findIndex(unit => unit.file === predecessor);
    expect(end).toBeGreaterThanOrEqual(0);
    plan.forward = plan.forward.slice(0, end + 1);
    for (const unit of [plan.baseline, ...plan.forward]) {
      const target = join(root, unit.file);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(unit.file, target);
    }
  }
  mkdirSync(join(root, "config"));
  writeFileSync(join(root, "config/platform-migration-manifest.json"), JSON.stringify(manifest));
}

it.each(["legacy", "bootstrap", "separate", "admin-managed", "admin-operator"] as const)(
  "installs the exact privacy declaration from a fresh and exact-predecessor %s chain and replays unchanged", async profile => {
    const prefix = mkdtempSync(join(tmpdir(), "privacy-declaration-prefix-"));
    let template: Awaited<ReturnType<typeof createAccountMutationsTemplate>> | undefined;
    let previous: typeof template;
    try {
      template = await createAccountMutationsTemplate(profile, "privacy-fresh");
      const fresh = await template.clone();
      expect((await fresh.runtime.query("SELECT to_regprocedure($1) IS NOT NULL AS installed", [reader])).rows[0].installed).toBe(true);
      expect(await required(fresh.runtime)).toEqual(owners);
      expect((await fresh.runner.apply()).applied).toEqual([]);
      if (profile === "separate") {
        await fresh.migrator.query(`GRANT SELECT (contributor_id) ON TABLE ${table} TO authenticated`);
        try { await expect(fresh.runner.apply()).rejects.toThrow(/object inventory SHA-256 mismatch/u); }
        finally { await fresh.migrator.query(`REVOKE SELECT (contributor_id) ON TABLE ${table} FROM authenticated`); }
        expect((await fresh.runner.apply()).applied).toEqual([]);
      }
      prepareExactPrefix(prefix);
      previous = await createAccountMutationsTemplate(profile, "privacy-prefix", prefix);
      const upgrade = await previous.clone();
      const original = await ledger(upgrade.owner);
      expect(original.at(-1)?.catalog_path).toBe(predecessor);
      expect((await upgrade.owner.query("SELECT to_regprocedure($1) AS reader", [reader])).rows[0].reader).toBeNull();
      const contactId = randomUUID(), actor = { principalId: randomUUID() }, idempotencyKey = randomUUID();
      const subject = { kind: "contact" as const, contactId };
      await upgrade.owner.query("INSERT INTO public.clients(id,email) VALUES ($1,'subject@example.invalid')", [contactId]);
      await upgrade.owner.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES ($1,'owner@example.invalid')", [actor.principalId]);
      await upgrade.owner.query("INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at) VALUES($1,'admin','active','legacy',now())", [actor.principalId]);
      const unitOfWork = createPostgresPrivacyUnitOfWork({ connectionString: "postgresql://unused.invalid/fixture" }, { poolFactory: () => upgrade.runtime });
      const { operations } = composeNativePrivacy({ store: createPostgresPrivacyStore(), unitOfWork });
      const capture = () => captureConnectedNativeStore({ sourceId: "privacy-upgrade", catalogueId: upgrade.inventory,
        maximumRows: 10_000, maximumBytes: 64 * 1024 * 1024, source: { async withSnapshot(work) {
          const client = await upgrade.owner.connect();
          try {
            await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
            return await work({ query: (sql, values) => client.query(sql, values ? [...values] : undefined) });
          } finally { try { await client.query("ROLLBACK"); } finally { client.release(); } }
        } },
      });
      try {
        for (const call of [() => operations.export(actor, subject), () => operations.erase(actor, { subject, idempotencyKey })]) {
          await expect(call()).rejects.toMatchObject({ code: "PRIVACY_ASSESSMENT_UNAVAILABLE", facts: { fix: expect.stringContaining("EXECUTE") } });
        }
        if (profile === "separate") await expect(capture()).rejects.toMatchObject({ code: "schema_conflict" });
        expect((await upgrade.runner.apply()).applied).toContain(forward);
        expect((await ledger(upgrade.owner)).slice(0, original.length)).toEqual(original);
        expect(await required(upgrade.runtime)).toEqual(owners);
        expect((await upgrade.runner.apply()).applied).toEqual([]);
        if (profile === "separate") await expect(capture()).resolves.toMatchObject({ requiredPrivacyContributorIds: owners });
        await expect(operations.export(actor, subject)).resolves.toMatchObject({ missingContributors: [] });
        await expect(operations.erase(actor, { subject, idempotencyKey })).resolves.toMatchObject({ outcome: "ERASED" });
      } finally { await unitOfWork.close(); }
    } finally {
      await Promise.all([template?.close(), previous?.close()]);
      rmSync(prefix, { recursive: true, force: true });
    }
  }, postgresSetupTimeoutMs,
);

it.each([false, true])("checks pgTAP privileges with managed-compatible defaults (service_role %s)", async withServiceRole => {
  const container = await runManagedCompatPostgres({ name: `privacy-declaration-tap-${withServiceRole}-${process.pid}`, password: "synthetic-conformance" });
  const owner = new Pool({ connectionString: container.connectionString });
  const bootstrap = new Pool({ connectionString: container.connectionString.replace("postgres://postgres:", "postgres://supabase_admin:") });
  let db: PoolClient | undefined;
  try {
    if (!withServiceRole) await bootstrap.query("DROP OWNED BY service_role CASCADE; DROP ROLE service_role");
    const definition = readFileSync(forward, "utf8");
    const defaults = () => bootstrap.query("SELECT * FROM pg_default_acl ORDER BY oid").then(result => result.rows);
    const initialDefaults = await defaults();
    await bootstrap.query("CREATE ROLE privacy_fixture_writer NOLOGIN; GRANT privacy_fixture_writer TO postgres");

    db = await owner.connect();
    const first = `INSERT INTO ${table}(contributor_id) VALUES ('fixture-first') ON CONFLICT (contributor_id) DO NOTHING`;
    const second = `INSERT INTO ${table}(contributor_id) VALUES ('fixture-second') ON CONFLICT (contributor_id) DO NOTHING`;
    const combined = [...owners, "fixture-first", "fixture-second"].sort();
    // Owner first: the declaration's initial seed also covers that installed owner.
    await db.query("BEGIN");
    await db.query(definition.replace("('subscriptions')", "('subscriptions'), ('fixture-first')"));
    expect(await required(db)).toEqual([...owners, "fixture-first"].sort());
    for (const statement of [second, first, second]) await db.query(statement);
    expect(await required(db)).toEqual(combined);
    await db.query("ROLLBACK");
    // Declaration first: the later owner forwards append, including replay in either order.
    await db.query(definition);
    await db.query("BEGIN");
    for (const statement of [first, second, second, first]) await db.query(statement);
    expect(await required(db)).toEqual(combined);
    await db.query("ROLLBACK");
    expect(await defaults()).toEqual(initialDefaults);
    await bootstrap.query("CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions");
    const output = await db.query(readFileSync("tests/postgres/fixtures/privacyRequiredContributors.sql", "utf8"));
    const lines = (Array.isArray(output) ? output : [output]).flatMap(result => result.rows.flatMap(row => Object.values(row).map(String)));
    expect(lines.filter(line => /^(?:not ok|# Looks like)/u.test(line))).toEqual([]);
    expect(lines.filter(line => /^ok \d+/u.test(line))).toHaveLength(10);
  } finally { db?.release(); await closePostgres(container, [owner, bootstrap]); }
}, postgresSetupTimeoutMs);
