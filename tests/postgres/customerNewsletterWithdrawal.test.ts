import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Pool } from "pg";
import { beforeAll, expect, it } from "vitest";
import { createPostgresConsentEvaluator } from "@openlup/platform/communications";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedPostgresCatalogPayload, qualifiedAdminPostgresCatalogPayload, qualifiedPostgresStartupOptions, qualifiedAdminPostgresStartupOptions, type QualifiedPostgresInstallation, type QualifiedAdminPostgresInstallation } from "../../server/adapters/postgres/qualifiedInstall.js";
import { readSelectedCatalogProjection, selectedCatalogProjectionPayload } from "../../server/adapters/postgres/selectedCatalogProjection.js";
import { closePostgres, dockerAvailable, postgresSetupTimeoutMs, runPostgresContainer, waitForPostgresTcpReady } from "../helpers/postgresContainer.js";
import { readIssuedPlatformManifest } from "../helpers/issuedPlatformCatalog.js";

const file = "db/platform/migrations/20261030110000_customer_newsletter_withdrawal.sql";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const fingerprint = (email: string) => hash(email.trim().toLowerCase());
// Derive the evaluator-accepted trim class from this Node runtime, including new Unicode versions.
const trimCandidates: string[] = [];
for (let point = 0; point <= 0x10ffff; point++) {
  const character = String.fromCodePoint(point), address = character + "reader@example.invalid";
  if (address.trim() === "reader@example.invalid") trimCandidates.push(character);
}
const sqlNormalForm = /lower\(btrim\(client\.email(?:, E'[^']*')?\)\)/u.exec(readFileSync(file, "utf8"))?.[0];
if (!sqlNormalForm) throw new Error("newsletter_normal_form_missing");
const oldAt = "2026-10-20T10:00:00.000Z", preferenceAt = "2026-10-21T10:00:00.000Z", laterAt = "2026-10-22T10:00:00.000Z";
const originalInventories = {
  legacy: "cfe3a8b4fa6216f61b1cdd5f004cb0f7a967bc01d9e18ddacb2efee74742d3b3",
  bootstrap: "c4f6bb9daa5882877149a78e13d07594b7e8653c3a3ba39f508477b072548f9b",
  separate: "624cc57789e3aaf36d0b61bdad420fc4eb0b63c2a7eb09358e5c18240ec13f82",
  managed: "c94d71fd28d5571cda30307bce4c4b48ebe0a3685c76819d8fa3b3efa8fa9ae7",
  operator: "807ea0c9b303c04c4ad3e9892ab16ee7e89acaea8b7641d1cedd4c79949fab7d",
};
const profiles = [
  { name: "legacy", generation: "legacy", mode: "installer-managed", separate: false },
  { name: "legacy-icu", generation: "legacy", mode: "installer-managed", separate: false },
  ...(["installer-managed", "operator-provisioned"] as const).flatMap(mode => [false, true].map(separate => ({ name: `qualified-v2/${mode}/${separate ? "separate" : "bootstrap"}`, generation: "qualified-v2", mode, separate }))),
  ...(["installer-managed", "operator-provisioned"] as const).map(mode => ({ name: `qualified-admin/${mode}`, generation: "qualified-admin", mode, separate: true })),
] as const;
const quote = (name: string) => { if (!/^[a-z_]+$/u.test(name)) throw new Error("invalid_fixture_role"); return `"${name}"`; };
beforeAll(async () => { if (!await dockerAvailable()) throw new Error("Newsletter withdrawal requires real PostgreSQL"); }, postgresSetupTimeoutMs);

it.each(profiles)("account newsletter withdrawal on $name", async profile => {
  const container = await runPostgresContainer({ name: `newsletter-withdrawal-${profile.generation}-${profile.mode}-${profile.separate}-${process.pid}`, password: "synthetic-conformance" });
  const pools: Pool[] = [], ports: { close(): Promise<void> }[] = [];
  let prefix: string | undefined;
  const pool = (connectionString: string, options?: string) => { const value = new Pool({ connectionString, options }); pools.push(value); return value; };
  try {
    if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Newsletter PostgreSQL unavailable");
    const databaseUrl = new URL(container.connectionString);
    if (profile.name === "legacy-icu") {
      await pool(container.connectionString).query("CREATE DATABASE newsletter_icu TEMPLATE template0 LOCALE_PROVIDER icu ICU_LOCALE 'en-US' ENCODING 'UTF8'");
      databaseUrl.pathname = "/newsletter_icu";
    }
    const owner = pool(databaseUrl.toString()), password = randomUUID();
    if (profile.name === "legacy-icu") {
      expect((await owner.query("SELECT datlocprovider AS provider,daticulocale AS locale,(SELECT collisdeterministic FROM pg_collation WHERE oid=100) AS deterministic FROM pg_database WHERE datname=current_database()")).rows).toEqual([{ provider: "i", locale: "en-US", deterministic: true }]);
      console.info("newsletter-icu-default deterministic en-US UTF8");
    }
    const login = (name: string) => { const url = new URL(databaseUrl); url.username = name; if (name !== "postgres") url.password = password; return url.toString(); };
    const m = "newsletter_m", r = "newsletter_r", s = "newsletter_s", o = "newsletter_o";
    const groups = ["anon", "authenticated", "service_role", "platform_acquisition_owner", "platform_acquisition_runtime", "openlup_retained_import_owner"];
    const admin = profile.generation === "qualified-admin", qualified = profile.generation !== "legacy";
    if (qualified && (admin || profile.separate)) {
      await owner.query(`CREATE ROLE ${quote(m)} LOGIN ${admin ? "NOINHERIT" : "INHERIT"} ${admin ? "NOSUPERUSER" : "SUPERUSER"} ${admin && profile.mode === "installer-managed" ? "CREATEROLE" : "NOCREATEROLE"} NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
      await owner.query(`ALTER DATABASE postgres OWNER TO ${quote(m)}`);
    }
    for (const name of (qualified ? [r, s] : [])) await owner.query(`CREATE ROLE ${quote(name)} LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
    if (qualified && profile.mode === "operator-provisioned") {
      if (admin) await owner.query(`CREATE ROLE ${quote(o)} LOGIN NOINHERIT NOSUPERUSER CREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
      const operator = admin ? pool(login(o)) : owner;
      for (const group of groups) {
        await owner.query(`CREATE ROLE ${quote(group)} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS`);
        if (admin) {
          await owner.query(`GRANT ${quote(group)} TO ${quote(o)} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`);
          await operator.query(`GRANT ${quote(group)} TO ${quote(m)} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE GRANTED BY ${quote(o)}`);
        }
        if (["anon", "authenticated", "service_role", "platform_acquisition_runtime"].includes(group)) await operator.query(`GRANT ${quote(group)} TO ${quote(r)} WITH ADMIN FALSE, INHERIT ${group === "service_role" ? "TRUE" : "FALSE"}, SET TRUE${admin ? ` GRANTED BY ${quote(o)}` : ""}`);
      }
    }
    const installation: { generation: "legacy" } | QualifiedPostgresInstallation | QualifiedAdminPostgresInstallation = !qualified ? { generation: "legacy" } : admin
      ? profile.mode === "installer-managed"
        ? { generation: "qualified-admin", roleMode: profile.mode, bootstrapLogin: "postgres", migrationLogin: m, runtimeLogin: r, restoreLogin: s }
        : { generation: "qualified-admin", roleMode: profile.mode, bootstrapLogin: "postgres", migrationLogin: m, runtimeLogin: r, restoreLogin: s, operatorLogin: o }
      : { generation: "qualified-v2", roleMode: profile.mode, bootstrapLogin: "postgres", migrationLogin: profile.separate ? m : "postgres", runtimeLogin: r, restoreLogin: s };
    const migrationUrl = login(installation.generation === "legacy" ? "postgres" : installation.migrationLogin);
    const startup = installation.generation === "qualified-v2" ? qualifiedPostgresStartupOptions(installation) : installation.generation === "qualified-admin" ? qualifiedAdminPostgresStartupOptions(installation) : undefined;
    const migrator = pool(migrationUrl, startup);
    const makeRunner = (root?: string) => createPostgresMigrationRunner({ connectionString: migrationUrl }, { root, installation, poolFactory: () => migrator,
      catalogProjectionPayload: async client => {
        const payload = installation.generation === "qualified-v2" ? await qualifiedPostgresCatalogPayload(client, installation, "openlup:public-platform-migrations:v1") : installation.generation === "qualified-admin" ? await qualifiedAdminPostgresCatalogPayload(client, installation, "openlup:public-platform-migrations:v1") : selectedCatalogProjectionPayload(await readSelectedCatalogProjection(client));
        console.info(`newsletter-inventory ${profile.name} ${hash(payload)}`); return payload;
      } });
    const current = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
    // The pre-withdrawal state is the named issued prefix, before any later module suffix.
    const previous = readIssuedPlatformManifest();
    expect({ legacy: previous.objectInventorySha256,
      bootstrap: previous.qualified.objectInventorySha256.bootstrapMigrator.withRestore,
      separate: previous.qualified.objectInventorySha256.separateMigrator.withRestore,
      managed: previous.qualifiedAdmin.objectInventorySha256.installerManaged,
      operator: previous.qualifiedAdmin.objectInventorySha256.operatorProvisioned }).toEqual(originalInventories);
    for (const [plan, prior] of [[current, previous], [current.qualified, previous.qualified],
      [current.qualifiedAdmin, previous.qualifiedAdmin]] as const) {
      expect(plan.forward.slice(0, prior.forward.length)).toEqual(prior.forward);
      expect(plan.forward[prior.forward.length].file).toBe(file);
    }
    prefix = mkdtempSync(join(tmpdir(), "newsletter-prefix-"));
    const entries = [previous, previous.qualified, previous.qualifiedAdmin].flatMap(plan => [plan.baseline, ...plan.forward]);
    for (const entry of entries) { const destination = join(prefix, entry.file); mkdirSync(dirname(destination), { recursive: true }); writeFileSync(destination, readFileSync(entry.file)); }
    mkdirSync(join(prefix, "config")); writeFileSync(join(prefix, "config/platform-migration-manifest.json"), JSON.stringify(previous));
    await makeRunner(prefix).apply();
    const runtime = pool(login(r));
    const evaluator = createPostgresConsentEvaluator({ connectionString: login(r) }); ports.push(evaluator);
    const actor = async (principal: string, value: boolean, now = preferenceAt) => {
      const client = await runtime.connect();
      try {
        await client.query("BEGIN"); await client.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: principal, role: "authenticated" })]); await client.query("SET LOCAL ROLE authenticated");
        expect((await client.query("SELECT current_user,auth.uid() AS principal,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser")).rows).toEqual([{ current_user: "authenticated", principal, superuser: false }]);
        const result = (await client.query("SELECT public.customer_communication_preferences_set_as_actor($1,$2) AS preferences", [value, now])).rows[0].preferences;
        await client.query("COMMIT"); return result;
      } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    };
    const subject = async (email: string | null) => { const principal = randomUUID(), id = randomUUID(); await owner.query("INSERT INTO public.clients(id,email,principal_id) VALUES($1,$2,$3)", [id, email, principal]); return { principal, id, email }; };
    const seed = async (email: string, state: string, purpose = "marketing_newsletter", at = oldAt) => owner.query("INSERT INTO public.communication_recipient_consents(recipient_fingerprint,purpose,state,captured_at,updated_at) VALUES($1,$2,$3,$4,$4) ON CONFLICT(recipient_fingerprint,purpose) DO UPDATE SET state=excluded.state,captured_at=excluded.captured_at,updated_at=excluded.updated_at", [fingerprint(email), purpose, state, at]);
    const consentRows = async (email: string) => (await owner.query("SELECT to_jsonb(c) AS row,xmin::text AS xmin,ctid::text AS ctid FROM public.communication_recipient_consents c WHERE recipient_fingerprint=$1 ORDER BY purpose", [fingerprint(email)])).rows;
    const decide = (email: string, purpose = "marketing_newsletter") => evaluator.evaluate({ email, purpose });
    const preferenceRows = async (principal: string) => (await owner.query("SELECT to_jsonb(p) AS row FROM public.customer_communication_preferences p WHERE principal_id=$1 UNION ALL SELECT to_jsonb(e) FROM public.customer_communication_preference_events e WHERE principal_id=$1", [principal])).rows;
    // Fail first against the unchanged real setter, through the actual actor role.
    const customer = await subject(" Mixed.Case@Example.invalid ");
    await seed(customer.email!, "granted");
      for (const [label, preference, state, at, purpose] of [
        ["earlier", false, "granted", oldAt, "marketing_newsletter"], ["equal", false, "granted", preferenceAt, "marketing_newsletter"], ["later", false, "granted", laterAt, "marketing_newsletter"],
        ["enabled", true, "granted", oldAt, "marketing_newsletter"], ["suppressed", false, "suppressed", oldAt, "marketing_newsletter"],
        ["other", false, "granted", oldAt, "marketing_launch_offer"],
        ["unicode-nbsp", false, "granted", oldAt, "marketing_newsletter"], ["unicode-bom", false, "granted", oldAt, "marketing_newsletter"],
      ] as const) {
        const whitespace = label === "unicode-nbsp" ? "\u00a0" : label === "unicode-bom" ? "\ufeff" : "";
        const historic = await subject(`${whitespace}historic-${label}@example.invalid${whitespace}`);
        await owner.query("INSERT INTO public.customer_communication_preferences(principal_id,marketing_newsletter_consent,revision,updated_at) VALUES($1,$2,1,$3)", [historic.principal, preference, preferenceAt]);
        await seed(historic.email!, state, purpose, at);
      }
    const beforeForward = (await owner.query("SELECT to_jsonb(c) AS row FROM public.communication_recipient_consents c ORDER BY recipient_fingerprint,purpose")).rows;
    if (existsSync(file)) await makeRunner().apply();
    expect((await owner.query("SELECT to_jsonb(c) AS row FROM public.communication_recipient_consents c ORDER BY recipient_fingerprint,purpose")).rows).toEqual(beforeForward);
    // Observe exact canonical replay before fixture-only runtime ACL composition.
    if (existsSync(file)) {
      const ledger = (await owner.query("SELECT * FROM public.platform_schema_migrations ORDER BY position")).rows;
      expect((await makeRunner().apply()).applied).toEqual([]);
      expect((await owner.query("SELECT * FROM public.platform_schema_migrations ORDER BY position")).rows).toEqual(ledger);
      expect((await owner.query("SELECT to_jsonb(c) AS row FROM public.communication_recipient_consents c ORDER BY recipient_fingerprint,purpose")).rows).toEqual(beforeForward);
    }
    const authority = (await owner.query("SELECT pg_get_userbyid(proowner) AS owner,has_table_privilege(proowner,'public.communication_recipient_consents','INSERT') AS can_insert,has_table_privilege(proowner,'public.communication_recipient_consents','UPDATE') AS can_update FROM pg_proc WHERE oid='public.customer_communication_preferences_set_as_actor(boolean,timestamptz)'::regprocedure")).rows[0];
    expect(authority).toMatchObject({ can_insert: true, can_update: true });
    console.info(`newsletter-definer-authority ${profile.name} ${authority.owner} INSERT/UPDATE PASS`);
    if (!qualified) await owner.query(`CREATE ROLE ${quote(r)} LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}'; GRANT authenticated TO ${quote(r)} WITH INHERIT FALSE, SET TRUE; GRANT SELECT,UPDATE ON public.communication_recipient_consents TO ${quote(r)}; GRANT SELECT,INSERT ON public.communication_native_policy_decisions TO ${quote(r)}`);
    expect((await decide(customer.email!)).allowed).toBe(true);
    await actor(customer.principal, false);
    expect((await consentRows(customer.email!))[0].row.state, "account opt-out must deny the evaluator's granted newsletter row").toBe("denied");
    expect(await decide(customer.email!)).toMatchObject({ allowed: false, reason: "missing_marketing_permission" });
    expect(await preferenceRows(customer.principal)).toHaveLength(2);
    expect((await owner.query("SELECT marketing_newsletter_consent FROM public.customer_communication_preference_events WHERE principal_id=$1", [customer.principal])).rows).toEqual([{ marketing_newsletter_consent: false }]);
    const unchangedDenial = await consentRows(customer.email!);
    await actor(customer.principal, false); expect(await consentRows(customer.email!)).toEqual(unchangedDenial);
    const firstPreference = await preferenceRows(customer.principal);
    await seed(customer.email!, "granted", "marketing_newsletter", laterAt); await actor(customer.principal, false, oldAt);
    expect((await consentRows(customer.email!))[0].row.state, "repeated opt-out must deny a later grant with unchanged preference").toBe("denied");
    expect(new Date((await consentRows(customer.email!))[0].row.updated_at).toISOString()).toBe(laterAt);
    expect(await preferenceRows(customer.principal)).toEqual(firstPreference);
    const withdrawn = await consentRows(customer.email!);
    expect((await actor(customer.principal, true)).marketingNewsletter.granted).toBe(true);
    expect(await consentRows(customer.email!)).toEqual(withdrawn);
    expect((await decide(customer.email!)).allowed).toBe(false);
    // Atomic consent failure cannot commit either preference or event.
    const rollback = await subject("rollback@example.invalid"); await actor(rollback.principal, true);
    const beforeFailure = await preferenceRows(rollback.principal);
    await owner.query("ALTER TABLE public.communication_recipient_consents ADD CONSTRAINT synthetic_newsletter_refusal CHECK (state <> 'denied') NOT VALID");
    try { await expect(actor(rollback.principal, false)).rejects.toMatchObject({ code: "23514" }); }
    finally { await owner.query("ALTER TABLE public.communication_recipient_consents DROP CONSTRAINT synthetic_newsletter_refusal"); }
    expect(await preferenceRows(rollback.principal)).toEqual(beforeFailure); expect(await consentRows(rollback.email!)).toEqual([]);
    const absent = await subject("absent@example.invalid"); await actor(absent.principal, false); expect((await consentRows(absent.email!))[0].row.state).toBe("denied");
    const suppressed = await subject("suppressed@example.invalid"); await seed(suppressed.email!, "suppressed"); const suppressedBefore = await consentRows(suppressed.email!);
    await actor(suppressed.principal, false); expect(await consentRows(suppressed.email!), "suppressed newsletter consent must remain byte-identical").toEqual(suppressedBefore); expect(await decide(suppressed.email!)).toMatchObject({ allowed: false, reason: "permission_suppressed" });
    for (const state of [null, "denied", "granted", "suppressed"]) {
      const optin = await subject(`optin-${state ?? "absent"}@example.invalid`); if (state) await seed(optin.email!, state);
      const before = await consentRows(optin.email!), answer = await decide(optin.email!);
      const result = await actor(optin.principal, true); expect(result.marketingNewsletter.granted).toBe(true);
      expect(await consentRows(optin.email!)).toEqual(before); expect(await decide(optin.email!)).toMatchObject({ allowed: answer.allowed, reason: answer.reason });
    }
    const other = await subject("other-purposes@example.invalid");
    for (const purpose of ["retention_marketing", "marketing_launch_offer"]) await seed(other.email!, "granted", purpose);
    const othersBefore = await consentRows(other.email!); await actor(other.principal, false);
    expect((await consentRows(other.email!)).filter(row => row.row.purpose !== "marketing_newsletter")).toEqual(othersBefore);
    expect((await decide(other.email!, "transactional")).allowed).toBe(true);
    if (profile.name === "legacy-icu") {
      const address = "reader\u0085@example.invalid", customer = await subject(address);
      await seed(address, "granted");
      const before = await decide(address); expect(before.allowed).toBe(true);
      expect((await owner.query("SELECT recipient_fingerprint FROM public.communication_native_policy_decisions WHERE id=$1", [before.decisionId])).rows[0].recipient_fingerprint).toBe(fingerprint(address));
      expect((await owner.query(`SELECT ${sqlNormalForm.replace("client.email", "$1")} AS normalized`, [address])).rows[0].normalized).toBe(address.trim().toLowerCase());
      await actor(customer.principal, false);
      expect((await consentRows(address))[0].row.state, "ICU U+0085 opt-out must deny the evaluator grant").toBe("denied");
      expect(await decide(address)).toMatchObject({ allowed: false, reason: "missing_marketing_permission" });
      console.info("newsletter-icu-withdrawal U+0085 PASS");
    }
    for (const email of ["invalid-address"]) {
      const noEmail = await subject(email);
      const refused = { name: "ConsentEvaluationUnavailableError", cause: { message: "native_communications_email_invalid" } };
      await expect(decide(email)).rejects.toMatchObject(refused);
      const decisions = (await owner.query("SELECT count(*) FROM public.communication_native_policy_decisions")).rows;
      const others = (await owner.query("SELECT to_jsonb(c) AS row FROM public.communication_recipient_consents c ORDER BY recipient_fingerprint,purpose")).rows;
      await actor(noEmail.principal, false);
      expect(await preferenceRows(noEmail.principal)).toHaveLength(2);
      expect((await preferenceRows(noEmail.principal)).map(row => row.row.marketing_newsletter_consent)).toEqual([false, false]);
      expect((await consentRows(email)).map(row => row.row)).toMatchObject([{ purpose: "marketing_newsletter", state: "denied" }]);
      expect((await owner.query("SELECT to_jsonb(c) AS row FROM public.communication_recipient_consents c WHERE recipient_fingerprint <> $1 ORDER BY recipient_fingerprint,purpose", [fingerprint(email)])).rows).toEqual(others);
      await expect(decide(email)).rejects.toMatchObject(refused);
      expect((await owner.query("SELECT count(*) FROM public.communication_native_policy_decisions")).rows).toEqual(decisions);
    }
    const unicode = await subject("ÄCCOUNT@EXAMPLE.INVALID"); await seed(unicode.email!, "granted"); await actor(unicode.principal, false);
    expect((await consentRows(unicode.email!))[0].row.state).toBe("denied"); expect((await decide(unicode.email!)).allowed).toBe(false);
    for (const character of ["\u00a0", "\ufeff"]) {
      const point = character.codePointAt(0)!.toString(16).toUpperCase();
      const address = `${character}withdrawal-${point}@example.invalid${character}`;
      const customer = await subject(address); await seed(address, "granted");
      expect((await decide(address)).allowed).toBe(true);
      await actor(customer.principal, false);
      expect.soft((await consentRows(address))[0].row.state, `Unicode U+${point} opt-out must deny the evaluator grant`).toBe("denied");
      expect.soft(await decide(address), `Unicode U+${point} evaluator must refuse after opt-out`).toMatchObject({ allowed: false, reason: "missing_marketing_permission" });
    }
    const trimCharacters: string[] = [];
    for (const character of trimCandidates) {
      const address = `${character}reader@example.invalid${character}`;
      const code = character.codePointAt(0)!.toString(16).toUpperCase();
      let decision;
      try { decision = await decide(address); }
      catch (error) {
        // Only nativeEmail's control-character refusal excludes a runtime trim candidate.
        expect(error).toMatchObject({ cause: { message: "native_communications_text_invalid" } });
        continue;
      }
      trimCharacters.push(character);
      // The real evaluator records nativeFingerprint(nativeEmail(address)); no private import or copied validation.
      const evaluatorFingerprint = (await owner.query("SELECT recipient_fingerprint FROM public.communication_native_policy_decisions WHERE id=$1", [decision.decisionId])).rows[0].recipient_fingerprint;
      expect(evaluatorFingerprint).toBe(fingerprint(address));
      for (const setting of ["on", "off"]) {
        await owner.query(`SET standard_conforming_strings = ${setting}`);
        const sqlHash = (await owner.query(`SELECT encode(sha256(convert_to(${sqlNormalForm.replace("client.email", "$1")},'UTF8')),'hex') AS fingerprint`, [address])).rows[0].fingerprint;
        expect.soft(sqlHash, `SQL/evaluator trim fingerprint parity U+${code}, standard_conforming_strings=${setting}`).toBe(evaluatorFingerprint);
      }
    }
    await owner.query("SET standard_conforming_strings = on");
    expect(trimCharacters.length).toBeGreaterThan(0);
    console.info(`newsletter-trim-class ${profile.name} count=${trimCharacters.length} codepoints=${trimCharacters.map(character => character.codePointAt(0)!.toString(16).toUpperCase()).join(",")}`);
    for (const email of [" Mixed.Case@Example.invalid ", "ÄCCOUNT@EXAMPLE.INVALID"]) {
      const sqlHash = (await owner.query(`SELECT encode(sha256(convert_to(${sqlNormalForm.replace("client.email", "$1")},'UTF8')),'hex') AS fingerprint`, [email])).rows[0].fingerprint;
      expect(sqlHash, "SQL/evaluator normalized email fingerprint parity").toBe(fingerprint(email));
      console.info(`newsletter-fingerprint-parity ${profile.name} ${email.includes("Ä") ? "non-ASCII-uppercase" : "mixed-case"} PASS`);
    }
    const denialBeforeEmailChange = await consentRows(absent.email!); await owner.query("UPDATE public.clients SET email='changed@example.invalid' WHERE id=$1", [absent.id]);
    expect(await consentRows(absent.email!)).toEqual(denialBeforeEmailChange); expect(await consentRows("changed@example.invalid")).toEqual([]);
    await seed("changed@example.invalid", "granted", "marketing_newsletter", laterAt); expect((await decide("changed@example.invalid")).allowed).toBe(true);
    if (existsSync(file)) {
      // Execute the operator's exact documented text, never a copied test variant.
      const note = readFileSync("docs/platform/DATA_AND_MIGRATIONS.md", "utf8");
      const statement = /<!-- account-newsletter-withdrawal-upgrade -->\n```sql\n([\s\S]*?)\n```/u.exec(note)?.[1]; expect(statement).toBeTruthy();
      const snapshot = async () => (await owner.query("SELECT to_jsonb(c) AS row,xmin::text AS xmin,ctid::text AS ctid FROM public.communication_recipient_consents c ORDER BY recipient_fingerprint,purpose")).rows;
      const before = await snapshot(); const update = await migrator.query(statement!); expect(update.rowCount).toBe(4);
      expect((await consentRows("historic-earlier@example.invalid"))[0].row.state).toBe("denied");
      expect((await consentRows("historic-equal@example.invalid"))[0].row.state).toBe("denied");
      for (const label of ["unicode-nbsp", "unicode-bom"]) expect((await consentRows(`historic-${label}@example.invalid`))[0].row.state).toBe("denied");
      const reconciledKeys = ["earlier", "equal", "unicode-nbsp", "unicode-bom"].map(label => fingerprint(`historic-${label}@example.invalid`));
      expect((await snapshot()).filter(row => !reconciledKeys.includes(row.row.recipient_fingerprint))).toEqual(before.filter(row => !reconciledKeys.includes(row.row.recipient_fingerprint)));
      const reconciled = await snapshot(); expect((await migrator.query(statement!)).rowCount).toBe(0); expect(await snapshot()).toEqual(reconciled);
      if (!qualified) {
        await evaluator.close(); ports.pop(); await runtime.end(); pools.splice(pools.indexOf(runtime), 1);
        await owner.query(`REVOKE authenticated FROM ${quote(r)}; REVOKE SELECT,UPDATE ON public.communication_recipient_consents FROM ${quote(r)}; REVOKE SELECT,INSERT ON public.communication_native_policy_decisions FROM ${quote(r)}; DROP ROLE ${quote(r)}`);
      }
    }
    console.info(`newsletter-withdrawal PASS ${profile.name}`);
  } finally { await closePostgres(container, pools, ports.map(port => () => port.close())); if (prefix) rmSync(prefix, { recursive: true, force: true }); }
}, postgresSetupTimeoutMs);
