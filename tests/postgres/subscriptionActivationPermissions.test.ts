import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import {
  qualifiedAdminPostgresStartupOptions, qualifiedPostgresStartupOptions,
  type QualifiedAdminPostgresInstallation, type QualifiedPostgresInstallation,
} from "../../server/adapters/postgres/qualifiedInstall.js";
import type { PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { closePostgres, postgresSetupTimeoutMs, runPostgresContainer, waitForPostgresTcpReady } from "../helpers/postgresContainer.js";
import { registerRenewal, registrationParents, seedRegistration } from "./subscriptionRegistrationFixture.js";

import {
  activationEffects, activationUnits, callCommit, callEntry, callRepair, commitNames, commitSignatures,
  entryNames, entrySignatures, expectedActivationEffects, refusal, repairName,
  seedCapturedActivation, type CapturedActivation,
} from "./subscriptionActivationFixture.js";

const manifest: PlatformMigrationManifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
const slot = manifest.forward.find(({ file }) => file.endsWith("_subscription_renewal_registration_units.sql"));
const forward = slot && readFileSync(slot.file, "utf8");
const aclSlot = manifest.forward.find(({ file }) => file.endsWith("_subscription_activation_execute_grants.sql"));
const unitsSlot = manifest.forward.find(({ file }) => file.endsWith("_subscription_activation_units.sql"));
const aclForward = aclSlot && readFileSync(aclSlot.file, "utf8");
const unitsForward = unitsSlot && readFileSync(unitsSlot.file, "utf8");
const activationParents = [...entrySignatures, ...commitSignatures];
const baseParents = [entrySignatures[0]!, commitSignatures[0]!];
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
    p.proretset, p.proargnames, p.proallargtypes, p.proargmodes, p.proargdefaults::text, p.proacl::text, p.prolang, l.lanname,
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

    const activation = activationCatalogWitness(owner, ownerName, profile !== "legacy");

    if (legacy) {
      for (const unit of [manifest.baseline, ...manifest.forward]) {
        if (unit.file === slot?.file) break;
        await bootstrap.query(readFileSync(unit.file, "utf8"));
      }
      const db = await bootstrap.connect();
      try {
        if (profile === "legacy-with-service") await verifyDefaults(db, owner, ownerName);
        await verify(db, forward ? () => db.query(forward) : undefined);
        await activation.beforeAcl(db);
        if (profile === "legacy-with-service") await verifyActivationDefaults(db, owner);
        if (aclForward && unitsForward) {
          await db.query(aclForward);
          await activation.afterAcl(db);
          await db.query(unitsForward);
          await activation.afterUnits(db);
        }
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
      if (forward || aclForward) migrator.on("connect", (db: PoolClient) => {
        const query = db.query.bind(db);
        db.query = (async (sql: string, values?: unknown[]) => {
          if (sql === aclForward) {
            await activation.beforeAcl(db);
            const result = await query(sql, values);
            await activation.afterAcl(db);
            return result;
          }
          if (sql === unitsForward) {
            const result = await query(sql, values);
            await activation.afterUnits(db);
            return result;
          }
          if (sql !== forward) return query(sql, values);
          let result;
          await verify(db, async () => { result = await query(sql, values); });
          return result;
        }) as typeof db.query;
      });
      await createPostgresMigrationRunner({ connectionString: url(ownerName) }, { installation, poolFactory: () => migrator }).apply();
      if (!forward) await verify(migrator);
      if (!aclForward) {
        const db = await migrator.connect();
        try { await activation.beforeAcl(db); }
        finally { db.release(); }
      }
      const runtime = pool(url(runtimeRole));
      await verifyCaller(runtime, bootstrap, runtimeRole, runtimeRole);
      await verifyActivationCaller(runtime, bootstrap, runtimeRole, runtimeRole);
    }

    expect(witnessed).toBe(true);
    await bootstrap.query(`CREATE ROLE ${plainRole} NOLOGIN; GRANT USAGE ON SCHEMA public TO ${plainRole};`);
    if (forward) await assertEffectiveUnits(bootstrap);
    expect((await bootstrap.query("SELECT has_schema_privilege($1,'public','USAGE') AS allowed", [plainRole])).rows)
      .toEqual([{ allowed: true }]);
    await activation.finalCatalog(bootstrap);
    const ownerDb = pool(url(ownerName));
    await verifyCaller(ownerDb, bootstrap, ownerName, ownerName);
    await verifyActivationCaller(ownerDb, bootstrap, ownerName, ownerName);
    if (profile !== "legacy") {
      const switched = new URL(url(legacy ? "postgres" : runtimeRole));
      switched.searchParams.set("options", "-c role=service_role");
      const service = pool(switched.toString());
      if (legacy) await grantIncumbentActivationAccess(bootstrap, "service_role");
      await verifyCaller(service, bootstrap, "service_role", legacy ? "postgres" : runtimeRole);
      await verifyActivationCaller(service, bootstrap, "service_role", legacy ? "postgres" : runtimeRole);
    }
  } finally { await closePostgres(container, pools); }
}, postgresSetupTimeoutMs);

const allowed = { execute: true, delegate: false };
const denied = { execute: false, delegate: false };
const permissionDenied = (name: string) => refusal(`permission denied for function ${name}`, "42501");
const symbol = (signature: string) => signature.slice("public.".length, signature.indexOf("("));

async function assertActivationPrivileges(db: Connection, signatures: string[], owner: string, hasService: boolean) {
  const actual = await catalog(db, signatures);
  expect(actual.map(row => row.signature)).toEqual(signatures);
  const service = (await db.query("SELECT oid FROM pg_roles WHERE rolname='service_role'")).rows[0]?.oid;
  expect(Boolean(service)).toBe(hasService);
  for (const row of actual) {
    expect(String(row.proowner), row.signature).toBe(owner);
    for (const role of ["anon", "authenticated", plainRole]) {
      if (row.effective[role]) expect(row.effective[role], `${role} effective privileges on ${row.signature}`).toEqual(denied);
    }
    if (hasService && String(service) !== owner) {
      expect(row.effective.service_role, `service_role effective privileges on ${row.signature}`).toEqual(allowed);
    }
    const grantees = [...new Set([owner, ...(hasService ? [String(service)] : [])])].sort((a, b) => Number(a) - Number(b));
    expect(row.direct, row.signature).toEqual(grantees.map(grantee => ({ grantee, grantor: owner, privilege: "EXECUTE", grantable: false })));
  }
}

function activationCatalogWitness(owner: number, ownerName: string, hasService: boolean) {
  const source = async (db: Connection) => (await db.query(`SELECT prosrc FROM unnest($1::text[])
    WITH ORDINALITY AS s(signature, position) JOIN pg_proc p ON p.oid=to_regprocedure(s.signature)
    ORDER BY s.position`, [activationParents])).rows;
  const acl = (db: Connection) => catalog(db, activationParents);
  let preimage: Awaited<ReturnType<typeof acl>>, narrowed: typeof preimage, originalSource: Awaited<ReturnType<typeof source>>;
  return {
    async beforeAcl(db: Connection) {
      preimage = await acl(db);
      originalSource = await source(db);
      expect(preimage.map(row => row.signature)).toEqual(activationParents);
      for (const row of preimage) {
        expect(row).toMatchObject({ proowner: owner, prosecdef: false, lanname: "plpgsql", provolatile: "v",
          proisstrict: false, proconfig: ["search_path=public, pg_catalog"],
          effective: { [ownerName]: { execute: true, delegate: true } } });
        if (baseParents.includes(row.signature)) {
          expect(row.proacl, row.signature).toBeNull();
          expect(row.effective.anon, row.signature).toEqual(allowed);
          expect(row.effective.authenticated, row.signature).toEqual(allowed);
        }
      }
      expect(await catalog(db, activationUnits)).toEqual([]);
    },
    async afterAcl(db: Connection) {
      narrowed = await acl(db);
      for (const [index, row] of narrowed.entries()) {
        const old = preimage[index]!;
        expect(row).toEqual(baseParents.includes(row.signature)
          ? { ...old, proacl: row.proacl, direct: row.direct, effective: row.effective }
          : old);
      }
      expect(await source(db)).toEqual(originalSource);
      await assertActivationPrivileges(db, baseParents, String(owner), hasService);
      expect(await catalog(db, activationUnits)).toEqual([]);
    },
    async afterUnits(db: Connection) {
      expect(await acl(db)).toEqual(narrowed);
      for (const row of await catalog(db, activationUnits)) {
        expect(row).toMatchObject({ proowner: owner, lanname: "plpgsql", prosecdef: false, provolatile: "v",
          proisstrict: false, proargdefaults: null, proconfig: ["search_path=public, pg_catalog"] });
      }
      await assertActivationPrivileges(db, activationUnits, String(owner), hasService);
    },
    async finalCatalog(db: Connection) {
      expect(preimage).toBeDefined();
      if (!unitsForward) return;
      expect(narrowed).toBeDefined();
      expect((await acl(db)).map(({ effective, ...row }) => row)).toEqual(narrowed.map(({ effective, ...row }) => row));
      await assertActivationPrivileges(db, [...baseParents, ...activationUnits], String(owner), hasService);
    },
  };
}

async function grantIncumbentActivationAccess(db: Connection, role: string) {
  await db.query(`GRANT USAGE ON SCHEMA public TO ${role};
    GRANT SELECT, UPDATE ON public.commerce_orders, public.commerce_settlement_intents, public.subscription_activations TO ${role};
    GRANT SELECT, INSERT ON public.subscriptions, public.subscription_cycles, public.subscription_events TO ${role};
    GRANT SELECT ON public.subscription_paid_activation_gaps, public.commerce_order_items,
      public.commerce_order_adjustments TO ${role};
    GRANT EXECUTE ON FUNCTION public.subscription_capture_renewal_attachment(uuid),
      public.catalog_order_line_sum_acceptance(uuid,uuid,public.commerce_orders,public.commerce_orders),
      public.${repairName}(integer,timestamptz), public.subscription_activation_answer(public.subscription_activations,boolean),
      ${entrySignatures[1]}, ${commitSignatures[1]} TO ${role};`);
}

async function verifyActivationCaller(db: Connection, seed: Pool, current: string, session: string) {
  expect((await db.query("SELECT current_user,session_user")).rows).toEqual([{ current_user: current, session_user: session }]);
  for (const variant of [0, 1] as const) {
    const entry = await seedCapturedActivation(seed);
    const initial = await callEntry(db, variant, entry);
    expect(initial).toMatchObject({ state: "active", replayed: false });
    expect(await callEntry(db, variant, entry)).toEqual({ ...initial, replayed: true });
    expect(await activationEffects(seed, entry.orderId)).toEqual(expectedActivationEffects());
    const direct = await seedCapturedActivation(seed);
    expect(await callCommit(db, variant, direct)).toMatchObject({ state: "active", repaired: false });
    expect(await activationEffects(seed, direct.orderId)).toEqual(expectedActivationEffects());
  }
  const gap = await seedCapturedActivation(seed);
  expect(await callRepair(db)).toEqual({ repaired: 1, overdue: 0 });
  expect(await activationEffects(seed, gap.orderId)).toEqual(expectedActivationEffects(true));

  if (!unitsForward) return;
  const checked = await seedCapturedActivation(seed);
  const check = (fingerprint: string) => db.query(`SELECT (v_activation).state, v_payment_fingerprint,
    v_paid_at=$4::timestamptz AS exact FROM public.${symbol(activationUnits[0]!)}($1::text,$2::uuid,$3::text)`,
  [checked.key, checked.orderId, fingerprint, checked.paidAt]);
  await expect(check("invalid")).rejects.toMatchObject(refusal("subscription_activation_invalid_input"));
  expect((await check(checked.fingerprint)).rows).toEqual([{ state: "provisional", v_payment_fingerprint: checked.fingerprint, exact: true }]);
  const editCheck = (hours: number) => db.query(`SELECT public.${symbol(activationUnits[1]!)}($1::integer)`, [hours]);
  await expect(editCheck(721)).rejects.toMatchObject(refusal("subscription_activation_edit_window_invalid"));
  await editCheck(1);
  expect((await seed.query(`SELECT a.state, o.subscription_cycle_id, a.subscription_id, r.order_id AS attachment
    FROM public.subscription_activations a JOIN public.commerce_orders o ON o.id=a.order_id
    LEFT JOIN public.subscription_renewal_attachments r ON r.order_id=o.id WHERE o.id=$1`, [checked.orderId])).rows)
    .toEqual([{ state: "provisional", subscription_cycle_id: null, subscription_id: null, attachment: null }]);
  for (const variant of [0, 1] as const) {
    const direct = variant ? await seedCapturedActivation(seed) : checked;
    const functionName = symbol(activationUnits[2 + variant]!);
    if (variant) {
      await expect(callCommit(db, variant, direct, { functionName, hours: 0 }))
        .rejects.toMatchObject(refusal("subscription_activation_edit_window_invalid"));
    }
    expect(await callCommit(db, variant, direct, { functionName })).toMatchObject({ state: "active", repaired: false });
    expect(await activationEffects(seed, direct.orderId)).toEqual(expectedActivationEffects());
  }
}

async function verifyActivationDefaults(db: PoolClient, owner: number) {
  await db.query("BEGIN");
  try {
    if (aclForward) await db.query(aclForward);
    const modes = [
      ["browser_defaults", "ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO anon,authenticated", null],
      ["inherited_default", `CREATE ROLE activation_inherited; GRANT activation_inherited TO anon WITH INHERIT TRUE;
        ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO activation_inherited`, /anon effective privileges/],
      ["service_delegation", "ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO service_role WITH GRANT OPTION", /service_role effective privileges/],
    ] as const;
    for (const [name, setup, expected] of modes) {
      await db.query(`SAVEPOINT ${name}`);
      await db.query(setup);
      if (unitsForward) {
        await db.query(unitsForward);
        const qualify = assertActivationPrivileges(db, activationUnits, String(owner), true);
        if (expected) await expect(qualify).rejects.toThrow(expected);
        else await qualify;
      }
      await db.query(`ROLLBACK TO SAVEPOINT ${name}`);
    }
  } finally { await db.query("ROLLBACK"); }
}

const customRole = "activation_custom";
const customPaths = [
  { name: "base entry", call: (db: Connection, p: CapturedActivation) => callEntry(db, 0, p),
    base: baseParents, units: [activationUnits[0]!, activationUnits[2]!] },
  { name: "direct base commit", call: (db: Connection, p: CapturedActivation) => callCommit(db, 0, p),
    base: [baseParents[1]!], units: [activationUnits[2]!] },
  { name: "open gap repair", call: callRepair, base: [baseParents[1]!], units: [activationUnits[2]!] },
  { name: "opt-in entry", call: (db: Connection, p: CapturedActivation) => callEntry(db, 1, p),
    base: [], units: [activationUnits[1]!, activationUnits[0]!, activationUnits[3]!] },
  { name: "direct opt-in commit", call: (db: Connection, p: CapturedActivation) => callCommit(db, 1, p),
    base: [], units: [activationUnits[3]!, activationUnits[1]!] },
];

describe("the activation EXECUTE break and custom-role recovery", () => {
  let container: Awaited<ReturnType<typeof runPostgresContainer>>, owner: Pool, custom: Pool;
  beforeAll(async () => {
    const password = "synthetic-activation";
    container = await runPostgresContainer({ name: `activation-custom-${process.pid}`, password });
    expect(await waitForPostgresTcpReady(container.connectionString)).toBe(true);
    owner = new Pool({ connectionString: container.connectionString });
    for (const unit of [manifest.baseline, ...manifest.forward]) {
      if (unit.file === aclSlot?.file) break;
      await owner.query(readFileSync(unit.file, "utf8"));
    }
    await owner.query(`CREATE ROLE ${plainRole} NOLOGIN; CREATE ROLE ${customRole} LOGIN PASSWORD '${password}';
      GRANT USAGE ON SCHEMA public TO anon, authenticated, ${plainRole};`);
    await grantIncumbentActivationAccess(owner, customRole);
    const url = new URL(container.connectionString);
    url.username = customRole;
    custom = new Pool({ connectionString: url.toString() });
    if (aclForward) await owner.query(aclForward);
  }, postgresSetupTimeoutMs);
  afterAll(async () => { await closePostgres(container, [owner, custom].filter(Boolean)); });

  async function recover(path: typeof customPaths[number], initial: string[], needed: string[]) {
    const p = await seedCapturedActivation(owner);
    const grant = (signature: string) => owner.query(`GRANT EXECUTE ON FUNCTION ${signature} TO ${customRole};`);
    expect((await custom.query("SELECT current_user,session_user")).rows)
      .toEqual([{ current_user: customRole, session_user: customRole }]);
    const applied: string[] = [];
    try {
      for (const signature of initial) {
        await grant(signature);
        applied.push(signature);
      }
      for (const signature of needed) {
        await expect(path.call(custom, p)).rejects.toMatchObject(permissionDenied(symbol(signature)));
        await grant(signature);
        applied.push(signature);
      }
      const result = await path.call(custom, p);
      const repaired = path.call === callRepair;
      if (repaired) expect(result).toEqual({ repaired: 1, overdue: 0 });
      else expect(result).toMatchObject({ state: "active" });
      expect(await activationEffects(owner, p.orderId)).toEqual(expectedActivationEffects(repaired));
    } finally {
      for (const signature of applied) await owner.query(`REVOKE EXECUTE ON FUNCTION ${signature} FROM ${customRole};`);
    }
  }

  for (const role of ["anon", "authenticated", plainRole]) {
    it.each([0, 1])(`returns exact 42501 for ${role} on base parent %s`, async index => {
      const db = await owner.connect();
      try {
        await db.query("BEGIN");
        await db.query(`SET LOCAL ROLE ${role}`);
        const sql = index ? `SELECT public.${commitNames[0]}(NULL::public.subscription_activations,
          'fixture-key'::text,NULL::text,clock_timestamp(),false)`
          : `SELECT public.${entryNames[0]}(NULL::text,NULL::uuid,NULL::text)`;
        await expect(db.query(sql)).rejects.toMatchObject(permissionDenied(symbol(baseParents[index]!)));
      } finally { await db.query("ROLLBACK"); db.release(); }
    });
  }

  it.each(customPaths.filter(path => path.base.length))("recovers $name between the ACL and unit slots", async path => {
    await recover(path, [], path.base);
  });

  it.each(customPaths.filter(path => !path.base.length))("keeps $name working between the ACL and unit slots", async path => {
    await recover(path, [], []);
  });

  describe("after unit extraction", () => {
    beforeAll(async () => { if (unitsForward) await owner.query(unitsForward); });
    it.each(customPaths)("recovers $name through its exact unit grants", async path => {
      const grants = aclForward ? path.base : [];
      await recover(path, grants, path.units);
    });
  });
});
