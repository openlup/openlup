import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { expect, it } from "vitest";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import {
  qualifiedAdminPostgresStartupOptions, qualifiedPostgresStartupOptions,
  type QualifiedAdminPostgresInstallation, type QualifiedPostgresInstallation,
} from "../../server/adapters/postgres/qualifiedInstall.js";
import type { PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { closePostgres, postgresSetupTimeoutMs, runPostgresContainer, waitForPostgresTcpReady } from "../helpers/postgresContainer.js";
import { registerRenewal, registrationParents, seedRegistration } from "./subscriptionRegistrationFixture.js";

const manifest: PlatformMigrationManifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
const slot = manifest.forward.find(({ file }) => file.endsWith("_subscription_renewal_registration_units.sql"));
const forward = slot && readFileSync(slot.file, "utf8");
const [base, shipping] = registrationParents;
const parentSignatures = registrationParents.map(name => `public.${name}(uuid,jsonb)`);
const units = [
  "public.subscription_renewal_registration__lock(uuid)",
  `public.${base}__validate(jsonb,public.commerce_orders,public.subscription_activations)`,
  `public.${shipping}__validate(jsonb,public.commerce_orders,public.subscription_activations)`,
  "public.subscription_renewal_registration__validate_lines(jsonb)",
  `public.${shipping}__normalize(jsonb,public.subscription_activations)`,
  `public.${base}__store(uuid,jsonb,public.subscription_activations)`,
  `public.${shipping}__store(uuid,jsonb,public.subscription_activations)`,
];
const profiles = ["legacy", "legacy-with-service", "bootstrap", "separate", "admin-managed", "admin-operator"] as const;
const plainRole = "registration_plain";
const runtimeRole = "registration_runtime";
const installer = "registration_installer";
const restore = "registration_restore";
const operator = "registration_operator";
const accessRoles = ["anon", "authenticated", "service_role", plainRole, runtimeRole];
type Connection = Pool | PoolClient;

async function catalog(db: Connection, signatures: string[]) {
  return (await db.query(`SELECT s.signature, p.oid, p.proowner, p.proargtypes::text, p.prorettype,
    p.proretset, p.proargdefaults::text, p.proacl::text, p.prolang, l.lanname,
    p.prosecdef, p.provolatile, p.proisstrict, p.proconfig,
    (SELECT jsonb_agg(jsonb_build_object('grantee',a.grantee,'grantor',a.grantor,
      'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY a.grantee,a.grantor,a.privilege_type)
      FROM aclexplode(p.proacl) a) AS direct,
    (SELECT jsonb_object_agg(r.rolname, jsonb_build_object(
      'execute', has_function_privilege(r.oid,p.oid,'EXECUTE'),
      'delegate', has_function_privilege(r.oid,p.oid,'EXECUTE WITH GRANT OPTION')))
      FROM pg_roles r WHERE r.rolname=ANY($2::text[]) OR r.oid=p.proowner) AS effective
    FROM unnest($1::text[]) WITH ORDINALITY AS s(signature, position)
    JOIN pg_proc p ON p.oid=to_regprocedure(s.signature) JOIN pg_language l ON l.oid=p.prolang
    ORDER BY s.position`, [signatures, accessRoles])).rows;
}

async function assertEffectiveUnits(db: Connection) {
  const actual = await catalog(db, units);
  expect(actual.map(row => row.signature)).toEqual(units);
  for (const row of actual) {
    for (const role of accessRoles) {
      if (row.effective[role]) expect(row.effective[role], `${role} effective privileges on ${row.signature}`)
        .toEqual({ execute: false, delegate: false });
    }
  }
}

async function assertInstalledUnits(db: Connection, owner: number, ownerName: string) {
  const actual = await catalog(db, units);
  expect(actual.map(row => row.signature)).toEqual(units);
  for (const row of actual) {
    expect(row, row.signature).toMatchObject({
      proowner: owner, lanname: "plpgsql", prosecdef: false, provolatile: "v", proisstrict: false,
      proargdefaults: null, proconfig: ["search_path=pg_catalog, pg_temp"],
      effective: { [ownerName]: { execute: true, delegate: true } },
    });
    const ownerOid = String(owner);
    expect(row.direct, row.signature).toEqual([{ grantee: ownerOid, grantor: ownerOid, privilege: "EXECUTE", grantable: false }]);
  }
  await assertEffectiveUnits(db);
}

async function verifyCaller(db: Connection, seed: Pool, current: string, session: string) {
  expect((await db.query("SELECT current_user,session_user")).rows).toEqual([{ current_user: current, session_user: session }]);
  for (const parent of registrationParents) {
    const { orderId, facts } = await seedRegistration(seed);
    await expect(registerRenewal(db, parent, orderId, facts)).resolves.toEqual({ orderId, replayed: false });
    await expect(registerRenewal(db, parent, orderId, facts)).resolves.toEqual({ orderId, replayed: true });
  }
}

async function verifyDefaults(db: PoolClient, owner: number, ownerName: string) {
  await db.query("BEGIN");
  try {
    await db.query(`ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO anon,authenticated;
      ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO service_role WITH GRANT OPTION;
      CREATE FUNCTION public.registration_default_control() RETURNS integer LANGUAGE sql AS 'SELECT 1';`);
    const [control] = await catalog(db, ["public.registration_default_control()"]);
    expect(control.effective).toMatchObject({
      anon: { execute: true, delegate: false },
      authenticated: { execute: true, delegate: false },
      service_role: { execute: true, delegate: true },
    });
    if (forward) {
      await db.query("SAVEPOINT direct_defaults");
      await db.query(forward);
      await assertInstalledUnits(db, owner, ownerName);
      await db.query("ROLLBACK TO SAVEPOINT direct_defaults");
    }

    await db.query(`CREATE ROLE registration_inherited;
      GRANT registration_inherited TO anon WITH INHERIT TRUE;
      ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO registration_inherited WITH GRANT OPTION;
      CREATE FUNCTION public.registration_inherited_control() RETURNS integer LANGUAGE sql AS 'SELECT 1';`);
    const [inherited] = await catalog(db, ["public.registration_inherited_control()"]);
    expect(inherited.effective.anon).toEqual({ execute: true, delegate: true });
    if (forward) {
      await db.query(forward);
      const [unit] = await catalog(db, units);
      expect(unit.effective.anon).toEqual({ execute: true, delegate: true });
      await expect(assertEffectiveUnits(db)).rejects.toThrow(/anon effective privileges/);
    }
  } finally { await db.query("ROLLBACK"); }
}

it.each(profiles)("qualifies renewal registration ownership, ACLs and caller identities on %s", async profile => {
  const password = "synthetic-registration";
  const container = await runPostgresContainer({ name: `registration-acl-${profile}-${process.pid}`, password });
  const pools: Pool[] = [];
  const pool = (connectionString: string, options?: string) => {
    const result = new Pool({ connectionString, options });
    pools.push(result);
    return result;
  };
  try {
    expect(await waitForPostgresTcpReady(container.connectionString)).toBe(true);
    const bootstrap = pool(container.connectionString);
    const url = (name: string) => {
      const target = new URL(container.connectionString);
      target.username = name;
      return target.toString();
    };
    const legacy = profile.startsWith("legacy"), admin = profile.startsWith("admin-");
    const ownerName = admin || profile === "separate" ? installer : "postgres";
    const operatorMode = profile === "admin-operator";
    if (ownerName === installer) {
      const flags = admin ? `NOINHERIT NOSUPERUSER ${operatorMode ? "NOCREATEROLE" : "CREATEROLE"}` : "INHERIT SUPERUSER NOCREATEROLE";
      await bootstrap.query(`CREATE ROLE ${installer} LOGIN ${flags} NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}';
        ALTER DATABASE postgres OWNER TO ${installer};`);
    }
    if (!legacy) {
      for (const role of [runtimeRole, restore]) {
        await bootstrap.query(`CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
      }
    }
    if (operatorMode) {
      await bootstrap.query(`CREATE ROLE ${operator} LOGIN NOINHERIT CREATEROLE NOSUPERUSER NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
      const roleOperator = pool(url(operator));
      for (const role of ["anon", "authenticated", "service_role", "platform_acquisition_owner", "platform_acquisition_runtime", "openlup_retained_import_owner"]) {
        await bootstrap.query(`CREATE ROLE ${role} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS;
          GRANT ${role} TO ${operator} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;`);
        await roleOperator.query(`GRANT ${role} TO ${installer} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE GRANTED BY ${operator}`);
        if (["anon", "authenticated", "service_role", "platform_acquisition_runtime"].includes(role)) {
          await roleOperator.query(`GRANT ${role} TO ${runtimeRole} WITH ADMIN FALSE, INHERIT ${role === "service_role" ? "TRUE" : "FALSE"}, SET TRUE GRANTED BY ${operator}`);
        }
      }
    }
    if (profile === "legacy-with-service") await bootstrap.query("CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS");
    const owner = (await bootstrap.query("SELECT oid FROM pg_roles WHERE rolname=$1", [ownerName])).rows[0].oid;
    let witnessed = false;
    const verify = async (db: Connection, apply?: () => Promise<unknown>) => {
      const before = await catalog(db, parentSignatures);
      expect(before.map(row => row.signature)).toEqual(parentSignatures);
      for (const row of before) expect(row).toMatchObject({
        proowner: owner, prosecdef: true, lanname: "plpgsql", provolatile: "v",
        proisstrict: false, proargdefaults: null, proconfig: ["search_path=pg_catalog, pg_temp"],
      });
      expect(await catalog(db, units)).toEqual([]);
      if (apply) {
        await apply();
        expect(await catalog(db, parentSignatures)).toEqual(before);
        await assertInstalledUnits(db, owner, ownerName);
      }
      witnessed = true;
    };

    if (legacy) {
      for (const unit of [manifest.baseline, ...manifest.forward]) {
        if (unit.file === slot?.file) break;
        await bootstrap.query(readFileSync(unit.file, "utf8"));
      }
      const db = await bootstrap.connect();
      try {
        if (profile === "legacy-with-service") await verifyDefaults(db, owner, ownerName);
        await verify(db, forward ? () => db.query(forward) : undefined);
      } finally { db.release(); }
    } else {
      const principals = { migrationLogin: ownerName, bootstrapLogin: "postgres", runtimeLogin: runtimeRole, restoreLogin: restore };
      const installation: QualifiedAdminPostgresInstallation | QualifiedPostgresInstallation = admin
        ? operatorMode ? { ...principals, generation: "qualified-admin", roleMode: "operator-provisioned", operatorLogin: operator }
          : { ...principals, generation: "qualified-admin", roleMode: "installer-managed" }
        : { ...principals, generation: "qualified-v2", roleMode: "installer-managed" };
      const migrator = pool(url(ownerName), installation.generation === "qualified-admin"
        ? qualifiedAdminPostgresStartupOptions(installation) : qualifiedPostgresStartupOptions(installation));
      // Observe the migration runner's own transaction immediately around the selected forward.
      if (forward) migrator.on("connect", (db: PoolClient) => {
        const query = db.query.bind(db);
        db.query = (async (sql: string, values?: unknown[]) => {
          if (sql !== forward) return query(sql, values);
          let result;
          await verify(db, async () => { result = await query(sql, values); });
          return result;
        }) as typeof db.query;
      });
      await createPostgresMigrationRunner({ connectionString: url(ownerName) }, { installation, poolFactory: () => migrator }).apply();
      if (!forward) await verify(migrator);
      await verifyCaller(pool(url(runtimeRole)), bootstrap, runtimeRole, runtimeRole);
    }

    expect(witnessed).toBe(true);
    await bootstrap.query(`CREATE ROLE ${plainRole} NOLOGIN; GRANT USAGE ON SCHEMA public TO ${plainRole};`);
    if (forward) await assertEffectiveUnits(bootstrap);
    expect((await bootstrap.query("SELECT has_schema_privilege($1,'public','USAGE') AS allowed", [plainRole])).rows)
      .toEqual([{ allowed: true }]);
    await verifyCaller(pool(url(ownerName)), bootstrap, ownerName, ownerName);
    if (profile !== "legacy") {
      const switched = new URL(url(legacy ? "postgres" : runtimeRole));
      switched.searchParams.set("options", "-c role=service_role");
      await verifyCaller(pool(switched.toString()), bootstrap, "service_role", legacy ? "postgres" : runtimeRole);
    }
  } finally { await closePostgres(container, pools); }
}, postgresSetupTimeoutMs);
