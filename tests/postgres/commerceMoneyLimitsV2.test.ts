import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  bindCommerceMoneyLimitsV2Reader, inspectCommerceMoneyLimitsV2, installCommerceMoneyLimitsV2,
  type CommerceMoneyLimitsV2, type InstallLimitsInput, type LimitsTuple,
} from "@openlup/platform/commerce/server";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";
import { captureStoreJourney, journeySelection, storeJourneyResources, type JourneyInstallation } from "../helpers/storeJourney.js";

const resources = storeJourneyResources();
let store: JourneyInstallation;
beforeAll(async () => { store = await resources.installation("money-limits"); }, postgresSetupTimeoutMs);
afterAll(() => resources.close(), postgresTeardownTimeoutMs);

const setting = "commerce.money_limits.v2";
const table = "public.commerce_money_limits_v2";
const signature = "public.commerce_money_limits_read_v2(text,text,text,text,text,text,text)";
const validate = "SELECT public.commerce_money_limits_v2_validate($1::jsonb) AS value";
const scopedRead = "SELECT * FROM public.commerce_money_limits_read_v2($1,$2,$3,$4,$5,$6,$7)";
const keys = ["installationRef", "channelKey", "methodKey", "providerKey", "accountRef", "mode", "currency"] as const;
const tuple = (installationRef: string): LimitsTuple => ({
  installationRef, channelKey: "online", methodKey: "card", providerKey: "processor-a",
  accountRef: "merchant-a", mode: "test", currency: "EUR",
});
const value = (installationRef: string): CommerceMoneyLimitsV2 => ({
  ...tuple(installationRef), schemaVersion: 2, profileRef: "standard", minMinor: 0, maxMinor: 100, active: true,
});
const coordinates = (scope: LimitsTuple) => keys.map(key => scope[key]);
const invalid = (field: string) => ({ kind: "refused", code: "money_limits_invalid_input", field,
  remedy: "Correct the indicated field using the documented payment limits input." });
const conflict = { kind: "refused", code: "money_limits_revision_conflict", field: "/expectedRevision",
  remedy: "Inspect the tuple with the owner binding. Retry the initial insert if absent, or deliberately resubmit the intended change with the observed revision." };
const exhausted = { kind: "refused", code: "money_limits_revision_exhausted", field: "/expectedRevision",
  remedy: "Have the installation owner qualify a replacement rail." };
const unavailable = "money_limits_operation_unavailable";
const checklist = "Check the native app binding, driver setup, database connection and TLS, operation-role privileges, and installed migrations. Then retry the same operation.";
const unbound = { code: "money_limits_reader_unbound", path: ["paymentLimits"],
  rule: "Connected show requires owner inspection for the intended installation and rail.",
  hint: "Supply the native owner inspection in the app's settings binding.",
  remediation: { retry: true, action: "Bind the native owner inspection to the intended installation and rail, then retry connected show." } };
const inspectionUnavailable = { code: unavailable, path: ["inspection"], rule: "The native payment limits inspection could not complete.",
  hint: "Check the installation and its owner connection.", remediation: { retry: true, action: checklist } };

function exact(actual: object, expected: object, prototype = Object.prototype) {
  expect(Reflect.ownKeys(actual).filter(key => key !== "stack")).toEqual(expect.arrayContaining(Reflect.ownKeys(expected)));
  expect(Reflect.ownKeys(actual).filter(key => key !== "stack")).toHaveLength(Reflect.ownKeys(expected).length);
  for (const key of Reflect.ownKeys(expected)) expect(Reflect.get(actual, key)).toStrictEqual(Reflect.get(expected, key));
  expect(Object.getPrototypeOf(actual)).toBe(prototype);
}

async function transaction<T>(pool: Pool, work: (db: PoolClient) => Promise<T>) {
  const db = await pool.connect();
  try { await db.query("BEGIN"); return await work(db); }
  finally { await db.query("ROLLBACK"); db.release(); }
}

async function scratch<T>(work: (directory: string) => Promise<T>) {
  const parent = join(process.cwd(), ".context", "scratch");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "payment-limits-"));
  try { return await work(directory); }
  finally { await rm(directory, { force: true, recursive: true }); }
}

const maxRef = "😀".repeat(50);
const referenceFields = [...keys.slice(0, 5), "profileRef"] as const;
const maxValue = { ...value(maxRef), channelKey: maxRef, methodKey: maxRef, providerKey: maxRef, accountRef: maxRef, profileRef: maxRef,
  minMinor: Number.MAX_SAFE_INTEGER, maxMinor: Number.MAX_SAFE_INTEGER };
const corpus: { patch: object; field: string }[] = [
  { patch: { schemaVersion: 1 }, field: "/schemaVersion" },
  ...referenceFields.flatMap(field => ["", maxRef + "a", 12, undefined].map(ref => ({ patch: { [field]: ref }, field: "/" + field }))),
  ...["prod", "TEST", "tes", "lïve", null].map(mode => ({ patch: { mode }, field: "/mode" })),
  ...["eur", "EU", "EURO", "ÉUR", "EU1", "EUR\n", null].map(currency => ({ patch: { currency }, field: "/currency" })),
  ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "0", null].map(minMinor => ({ patch: { minMinor }, field: "/minMinor" })),
  ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", null].map(maxMinor => ({ patch: { maxMinor }, field: "/maxMinor" })),
  { patch: { minMinor: 2, maxMinor: 1 }, field: "/maxMinor" },
  ...["true", 1, null, undefined].map(active => ({ patch: { active }, field: "/active" })),
  { patch: { extra: "unexpected" }, field: "/" },
];

it("admits the same bounded payment terms in TypeScript and PostgreSQL", async () => {
  const noQuery = vi.fn(async () => { throw new Error("Invalid input reached PostgreSQL."); });
  const invalidSqlValues = corpus.map(({ patch, field }) => ({ doc: { ...value("invalid"), ...patch }, field }));
  // Temporarily disabled the closed validator in a disposable database.
  await transaction(store.owner, async db => {
    await db.query(`CREATE OR REPLACE FUNCTION public.commerce_money_limits_v2_validate(p_document jsonb)
      RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS 'SELECT p_document'`);
    for (const { doc } of invalidSqlValues) await expect(db.query(validate, [JSON.stringify(doc)])).resolves.toHaveProperty("rowCount", 1);
  });
  for (const { doc, field } of invalidSqlValues) {
    exact(await installCommerceMoneyLimitsV2({ query: noQuery }, { value: doc, expectedRevision: null }),
      invalid(field === "/" ? "/value" : "/value" + field));
    await expect(store.owner.query(validate, [JSON.stringify(doc)])).rejects.toMatchObject({
      code: "22023", message: "money_limits_invalid_input", detail: field,
    });
  }
  for (const field of referenceFields) for (const malformed of ["a\u0000", "a\uD800", "a\uDC00"]) {
    const doc = { ...value("encoding"), [field]: malformed };
    exact(await installCommerceMoneyLimitsV2({ query: noQuery }, { value: doc, expectedRevision: null }), invalid("/value/" + field));
    // JSONB itself refuses unrepresentable strings before a strict wire validator can run.
    await expect(store.owner.query(validate, [JSON.stringify(doc)])).rejects.toMatchObject({ code: expect.stringMatching(/^(22P02|22P05)$/u) });
  }
  for (const expectedRevision of [0, -1, 1.5, 2147483648, "1", undefined, Infinity]) {
    exact(await installCommerceMoneyLimitsV2({ query: noQuery }, { value: value("invalid"), expectedRevision } as InstallLimitsInput), invalid("/expectedRevision"));
  }
  for (const input of [null, [], new Date(), { value: [], expectedRevision: null }, { value: value("invalid"), expectedRevision: null, extra: 1 }]) {
    exact(await installCommerceMoneyLimitsV2({ query: noQuery }, input as InstallLimitsInput), invalid(input && "value" in input && Array.isArray(input.value) ? "/value" : "/"));
  }
  expect(noQuery).not.toHaveBeenCalled();
  const { schemaVersion: _version, profileRef: _profile, minMinor: _min, maxMinor: _max, active: _active, ...maxTuple } = maxValue;
  expect(Buffer.byteLength(coordinates(maxTuple).join(""))).toBe(1007);
  for (const doc of [maxValue, { ...value("x"), channelKey: "x", methodKey: "x", providerKey: "x", accountRef: "x",
    profileRef: "x", maxMinor: 1, mode: "live", active: false }]) {
    await expect(store.owner.query(validate, [JSON.stringify(doc)])).resolves.toMatchObject({ rows: [{ value: doc }] });
    expect(await installCommerceMoneyLimitsV2(store.owner, { value: doc, expectedRevision: null })).toEqual({ kind: "installed", value: doc, revision: 1 });
  }
  const bound = bindCommerceMoneyLimitsV2Reader(store.runtime, maxTuple);
  maxTuple.accountRef = "changed-after-binding";
  expect(await bound()).toEqual({ present: true, value: maxValue, revision: 1 });
  exact(await installCommerceMoneyLimitsV2(store.owner, { value: { ...maxValue, accountRef: maxRef + "a" }, expectedRevision: null }), invalid("/value/accountRef"));
}, postgresSetupTimeoutMs);

async function whileLocked(
  lock: (db: PoolClient) => Promise<unknown>, contend: (db: PoolClient) => Promise<unknown>,
) {
  const holder = await store.owner.connect(), waiter = await store.owner.connect();
  let result;
  try {
    await holder.query("BEGIN");
    await lock(holder);
    const holderPid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const waiterPid = (await waiter.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    result = contend(waiter);
    void result.catch(() => {});
    let blockers: number[] = [];
    for (let attempt = 0; attempt < 200 && !blockers.includes(holderPid); attempt++) {
      blockers = (await store.owner.query("SELECT pg_blocking_pids($1) AS pids", [waiterPid])).rows[0].pids;
      if (!blockers.includes(holderPid)) await setTimeout(10);
    }
    expect(blockers).toContain(holderPid);
    await holder.query("COMMIT");
    return await result;
  } finally {
    await holder.query("ROLLBACK");
    await result?.catch(() => {});
    holder.release(); waiter.release();
  }
}

it("decides insert, staleness and the matching revision across a conflicting writer lock", async () => {
  const scope = tuple("contended");
  const first = value(scope.installationRef), next = { ...first, maxMinor: 200 };
  const insert = (db: PoolClient) => installCommerceMoneyLimitsV2(db, { value: first, expectedRevision: null });
  exact(await whileLocked(insert, insert) as object, conflict);
  expect(await inspectCommerceMoneyLimitsV2(store.owner, scope)).toEqual({ present: true, active: true, value: first, revision: 1 });
  const change = (db: PoolClient) => installCommerceMoneyLimitsV2(db, { value: next, expectedRevision: 1 });
  exact(await whileLocked(change, change) as object, conflict);
  expect(await inspectCommerceMoneyLimitsV2(store.owner, scope)).toEqual({ present: true, active: true, value: next, revision: 2 });
  const changeThird = { ...next, maxMinor: 300 }, changeFourth = { ...next, maxMinor: 400 };
  expect(await whileLocked(db => installCommerceMoneyLimitsV2(db, { value: changeThird, expectedRevision: 2 }),
    db => installCommerceMoneyLimitsV2(db, { value: changeFourth, expectedRevision: 3 })))
    .toEqual({ kind: "installed", value: changeFourth, revision: 4 });
  exact(await installCommerceMoneyLimitsV2(store.owner, { value: { ...changeFourth, profileRef: "other" }, expectedRevision: 4 }), invalid("/value/profileRef"));

  const empty = value("absent-conflict");
  exact(await installCommerceMoneyLimitsV2(store.owner, { value: empty, expectedRevision: 1 }), conflict);
  expect(await inspectCommerceMoneyLimitsV2(store.owner, tuple(empty.installationRef))).toEqual({ present: false, active: null, value: null, revision: null });
  expect(await installCommerceMoneyLimitsV2(store.owner, { value: empty, expectedRevision: null })).toEqual({ kind: "installed", value: empty, revision: 1 });

  await store.owner.query(`INSERT INTO ${table} SELECT 'exhausted',channel_key,method_key,provider_key,account_ref,mode,currency,
    profile_ref,2147483647,min_minor,max_minor,active FROM ${table} WHERE installation_ref='contended'`);
  const last = { ...changeFourth, installationRef: "exhausted" };
  exact(await installCommerceMoneyLimitsV2(store.owner, { value: last, expectedRevision: 2147483646 }), conflict);
  exact(await installCommerceMoneyLimitsV2(store.owner, { value: last, expectedRevision: 2147483647 }), exhausted);
  expect(await inspectCommerceMoneyLimitsV2(store.owner, tuple("exhausted"))).toEqual({ present: true, active: true, value: last, revision: 2147483647 });
  const replacement = { ...last, providerKey: "processor-b" };
  expect(await installCommerceMoneyLimitsV2(store.owner, { value: replacement, expectedRevision: null })).toEqual({ kind: "installed", value: replacement, revision: 1 });
}, postgresSetupTimeoutMs);

it("discriminates the owner input, insert, stale revision and exhaustion gates in disposable builds", async () => {
  const entry = import.meta.resolve("@openlup/platform/commerce/server");
  const compiled = await readFile(new URL("commerceMoneyLimitsV2.js", entry), "utf8");
  await scratch(async directory => {
    async function mutate(name: string, old: string, replacement: string) {
      const changed = compiled.replace(old, replacement);
      expect(changed, name).not.toBe(compiled);
      const file = join(directory, name + ".mjs");
      await writeFile(file, changed);
      return (await import(/* @vite-ignore */ pathToFileURL(file).href)).installCommerceMoneyLimitsV2 as typeof installCommerceMoneyLimitsV2;
    }
    // Temporarily disabled input admission, conflict handling, the revision match and exhaustion in disposable builds.
    const noValidation = await mutate("validation", "const parsed = installSchema.safeParse(input);",
      "const parsed = {success: true, data: input};");
    const marker = new Error("Query was reached.");
    const trace = vi.fn(async () => { throw marker; });
    const invalidInput = { value: { ...value("mutant"), currency: "eur" }, expectedRevision: null };
    await expect(noValidation({ query: trace }, invalidInput)).rejects.toHaveProperty("cause", marker);
    expect(trace).toHaveBeenCalledOnce();
    exact(await installCommerceMoneyLimitsV2({ query: trace }, invalidInput), invalid("/value/currency"));
    expect(trace).toHaveBeenCalledOnce();

    const noInsertConflict = await mutate("insert-conflict", "ON CONFLICT (${keys}) DO NOTHING RETURNING revision", "RETURNING revision");
    const doc = value("mutation-cas");
    await installCommerceMoneyLimitsV2(store.owner, { value: doc, expectedRevision: null });
    await expect(noInsertConflict(store.owner, { value: doc, expectedRevision: null })).rejects.toMatchObject({ cause: { code: "23505" } });
    exact(await installCommerceMoneyLimitsV2(store.owner, { value: doc, expectedRevision: null }), conflict);
    const noRevisionMatch = await mutate("revision-match", "AND locked.revision=$2::integer", "");
    const stale = { value: { ...doc, maxMinor: 111 }, expectedRevision: 2 };
    exact(await installCommerceMoneyLimitsV2(store.owner, stale), conflict);
    expect(await noRevisionMatch(store.owner, stale)).toEqual({ kind: "installed", value: stale.value, revision: 2 });

    await store.owner.query(`INSERT INTO ${table} SELECT 'mutation-exhausted',channel_key,method_key,provider_key,account_ref,mode,currency,
      profile_ref,2147483647,min_minor,max_minor,active FROM ${table} WHERE installation_ref='mutation-cas'`);
    const noExhaustion = await mutate("revision-exhaustion", "AND locked.revision<${maxRevision}", "");
    const final = { value: value("mutation-exhausted"), expectedRevision: 2147483647 };
    await expect(noExhaustion(store.owner, final)).rejects.toMatchObject({ cause: { code: "22003" } });
    exact(await installCommerceMoneyLimitsV2(store.owner, final), exhausted);
  });
}, postgresSetupTimeoutMs);

it("protects tuple and profile identity, revision progression and deletion at the table", async () => {
  await installCommerceMoneyLimitsV2(store.owner, { value: value("guard"), expectedRevision: null });
  const statements = ["UPDATE " + table + " SET provider_key='other', revision=revision+1",
    "UPDATE " + table + " SET profile_ref='other', revision=revision+1",
    "UPDATE " + table + " SET max_minor=200", "UPDATE " + table + " SET revision=revision+2", "DELETE FROM " + table];
  for (const start of statements) {
    const sql = start + " WHERE installation_ref='guard'";
    // Temporarily disabled the mutation trigger in a disposable database.
    await transaction(store.owner, async db => {
      await db.query(`ALTER TABLE ${table} DISABLE TRIGGER commerce_money_limits_v2_guard`);
      expect((await db.query(sql)).rowCount).toBe(1);
    });
    await expect(store.owner.query(sql)).rejects.toMatchObject({ code: "55000" });
  }
  for (const revision of [0, -1, 2147483648]) {
    await expect(store.owner.query(`INSERT INTO ${table} SELECT 'bad-revision',channel_key,method_key,provider_key,account_ref,mode,currency,
      profile_ref,$1::integer,min_minor,max_minor,active FROM ${table} WHERE installation_ref='guard'`, [revision]))
      .rejects.toMatchObject({ code: revision > 2147483647 ? "22003" : "23514" });
  }
  expect(await inspectCommerceMoneyLimitsV2(store.owner, tuple("guard"))).toMatchObject({ value: value("guard"), revision: 1 });
});

it("validates a scoped active row even when a field only passed its coarse storage check", async () => {
  await installCommerceMoneyLimitsV2(store.owner, { value: value("stored-validation"), expectedRevision: null });
  const corruptScope = { ...tuple("stored-validation"), mode: "prod" };
  async function corrupt(db: PoolClient) {
    await db.query(`INSERT INTO ${table} SELECT installation_ref,channel_key,method_key,provider_key,account_ref,'prod',currency,
      profile_ref,revision,min_minor,max_minor,active FROM ${table} WHERE installation_ref='stored-validation'`);
  }
  // Temporarily disabled stored-document validation in a disposable database.
  await transaction(store.owner, async db => {
    await corrupt(db);
    const definition = (await db.query("SELECT pg_get_functiondef($1::regprocedure) AS body", [signature])).rows[0].body;
    const bypass = definition.replace(/^ {4}PERFORM public\.commerce_money_limits_v2_validate\([\s\S]+?;\n/mu, "");
    expect(bypass).not.toBe(definition);
    await db.query(bypass);
    await db.query("SET LOCAL ROLE service_role");
    expect((await db.query(scopedRead, coordinates(corruptScope))).rows).toHaveLength(1);
  });
  await transaction(store.owner, async db => {
    await corrupt(db);
    await db.query("SET LOCAL ROLE service_role");
    await expect(db.query(scopedRead, coordinates(corruptScope))).rejects.toMatchObject({
      code: "22023", message: "money_limits_invalid_input", detail: "/mode",
    });
  });
});

it("keeps the infrastructure checklist and original cause inside exact refusal boundaries", async () => {
  const cause = new Error("synthetic connection failure");
  const broken = { async query() { throw cause; } };
  const scope = tuple("infrastructure"), doc = value("infrastructure");
  for (const [field, operation] of [
    ["/installation", () => installCommerceMoneyLimitsV2(broken, { value: doc, expectedRevision: null })],
    ["/inspection", () => inspectCommerceMoneyLimitsV2(broken, scope)],
    ["/read", bindCommerceMoneyLimitsV2Reader(broken, scope)],
  ] as const) {
    const error = await operation().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    exact(error as Error, { message: unavailable, code: unavailable, field, remedy: checklist, cause }, Error.prototype);
    expect(Object.getOwnPropertyDescriptor(error, "cause")).toMatchObject({ value: cause, enumerable: false });
  }
  expect((await store.runtime.query(`SELECT has_table_privilege(current_user,$1,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS table_access,
    has_any_column_privilege(current_user,$1,'SELECT,INSERT,UPDATE,REFERENCES') AS column_access`, [table])).rows)
    .toEqual([{ table_access: false, column_access: false }]);
  await expect(store.runtime.query(validate, [JSON.stringify(doc)])).rejects.toMatchObject({ code: "42501" });
  await expect(store.runtime.query("SELECT public.commerce_money_limits_v2_guard()")).rejects.toMatchObject({ code: "42501" });
  await expect(inspectCommerceMoneyLimitsV2(store.runtime, scope)).rejects.toMatchObject({ code: unavailable, field: "/inspection", cause: { code: "42501" } });
  await expect(installCommerceMoneyLimitsV2(store.runtime, { value: doc, expectedRevision: null })).rejects.toMatchObject({
    code: unavailable, field: "/installation", cause: { code: "42501" },
  });
  await transaction(store.owner, async db => {
    await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await expect(installCommerceMoneyLimitsV2(db, { value: doc, expectedRevision: null })).rejects.toMatchObject({
      code: unavailable, field: "/installation", cause: { message: "Payment limits installation requires READ COMMITTED." },
    });
  });
  expect(await inspectCommerceMoneyLimitsV2(store.owner, scope)).toEqual({ present: false, active: null, revision: null, value: null });
});

const exec = promisify(execFile);
async function cli(binary: string, args: string[], cwd: string) {
  try { return { exit: 0, body: JSON.parse((await exec(binary, args, { cwd })).stdout) }; }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === 74 && "stdout" in error && typeof error.stdout === "string") {
      return { exit: 74, body: JSON.parse(error.stdout) };
    }
    throw new Error("The synthetic settings CLI witness did not return a settings document.");
  }
}

it("executes the install, connected show and rollback guide, then transfers exact-current terms", async () => {
  const from = await (await resources.targetTemplate("limits-recipe")).nextTarget();
  await scratch(async directory => {
    const guide = await readFile("packages/core/docs/guide/how-to/build/quote-prices.md", "utf8");
    const recipes = guide.split("## Install and inspect payment limits")[1]!;
    const code = [...recipes.matchAll(/^\x60{3}js\n([\s\S]+?)^\x60{3}$/gmu)].map(match => match[1]!);
    expect(code).toHaveLength(3);
    await symlink(join(process.cwd(), "node_modules"), join(directory, "node_modules"), "dir");
    await Promise.all(["payment-rail.mjs", "owner-task.mjs", "settings.mjs"].map((name, i) => writeFile(join(directory, name), code[i]!)));
    await writeFile(join(directory, "runtime.mjs"), `import { bindCommerceMoneyLimitsV2Reader } from "@openlup/platform/commerce/server";
      import { scope } from "./payment-rail.mjs";
      export const createSettingsBindings = ({ db }) => ({ readers: { "${setting}": bindCommerceMoneyLimitsV2Reader(db, scope) } });`);
    const runtimeOnly = await readFile(join(directory, "runtime.mjs"), "utf8");
    await writeFile(join(directory, "runtime-at-owner.mjs"), runtimeOnly.replace(setting, setting + ".owner"));
    await writeFile(join(directory, "empty.mjs"), "export const createSettingsBindings = () => ({});");
    const { scope, terms } = await import(/* @vite-ignore */ pathToFileURL(join(directory, "payment-rail.mjs")).href);
    const task = await import(/* @vite-ignore */ pathToFileURL(join(directory, "owner-task.mjs")).href);
    const url = new URL(from.ownerUrl); url.search = "";
    const binary = "./node_modules/.bin/openlup";
    const show = (...args: string[]) => cli(binary, ["settings", "show", setting, "--json", ...args], directory);
    const shellRecipe = recipes.match(/^\x60{3}sh\n([\s\S]+?)^\x60{3}$/mu)?.[1];
    expect(shellRecipe).toContain(' --database-url "$database_url" --json');
    const connected = () => cli("sh", ["-c", `database_url=$1\n${shellRecipe}`, "recipe", url.href], directory);
    const installed = bindCommerceMoneyLimitsV2Reader(from.runtime, scope);
    expect(await show()).toMatchObject({ exit: 0, body: { setting: { schemaVersion: 1, kind: "installed" }, observation: { state: "offline" } } });
    for (const binding of [[], ["--app", "./empty.mjs"], ["--app", "./runtime.mjs"], ["--app", "./runtime-at-owner.mjs"]]) {
      const refusal = await show("--database-url", from.runtimeUrl, ...binding);
      expect(refusal.exit).toBe(74);
      exact(refusal.body.refusal, unbound);
    }
    expect(await connected()).toMatchObject({ exit: 0, body: { observation: { state: "absent", value: null } } });
    expect(await installed()).toEqual({ present: false });
    expect(await task.install(from.owner)).toEqual({ kind: "installed", value: terms, revision: 1 });
    expect(await installed()).toEqual({ present: true, value: terms, revision: 1 });
    const onlyRuntime = await show("--app", "./runtime-at-owner.mjs", "--database-url", from.runtimeUrl);
    expect(onlyRuntime.exit).toBe(74);
    exact(onlyRuntime.body.refusal, unbound);
    expect(await connected()).toMatchObject({ body: { observation: { state: "override", revision: "1", value: terms } } });
    expect(await task.rollback(from.owner)).toEqual({ kind: "installed", value: { ...terms, active: false }, revision: 2 });
    expect(await connected()).toMatchObject({ body: { observation: { state: "override", revision: "2", value: { ...terms, active: false } } } });
    expect((await from.runtime.query(scopedRead, coordinates(scope))).rows).toEqual([]);
    expect(await installed()).toEqual({ present: false });
    // Temporarily disabled the active-row filter in a disposable database.
    await transaction(from.owner, async db => {
      const definition = (await db.query("SELECT pg_get_functiondef($1::regprocedure) AS body", [signature])).rows[0].body;
      const modified = definition.replace("    AND active;", ";");
      expect(modified).not.toBe(definition);
      await db.query(modified);
      await db.query("SET LOCAL ROLE service_role");
      expect((await db.query(scopedRead, coordinates(scope))).rows).toHaveLength(1);
    });
    expect(await installCommerceMoneyLimitsV2(from.owner, { value: terms, expectedRevision: 2 })).toEqual({ kind: "installed", value: terms, revision: 3 });
    expect(await installed()).toEqual({ present: true, value: terms, revision: 3 });
    expect(await bindCommerceMoneyLimitsV2Reader(from.runtime, { ...scope, accountRef: "elsewhere" })()).toEqual({ present: false });
    expect(await show("--app", "./settings.mjs", "--database-url", from.runtimeUrl))
      .toMatchObject({ exit: 74, body: { refusal: inspectionUnavailable } });

    const to = await (await resources.targetTemplate("money-limits-restore")).nextTarget();
    const packet = await captureStoreJourney(from.owner, "limits-source");
    const tableName = "commerce_money_limits_v2";
    const index = packet.owned.findIndex(entry => entry.table === tableName);
    expect(packet.owned.slice(index, index + 2).map(entry => entry.table)).toEqual([tableName, "tax_calculations"]);
    const restore = (source = packet) => restoreConnectedNativeStore({
      installation: journeySelection, owner: to.owner, packet: source, freshTarget,
    });
    const freshTarget = await captureStoreJourney(to.owner, "limits-pristine");
    const { sha256: _hash, ...body } = packet;
    const older = { ...body, compatible: { ...body.compatible, catalogueId: "0".repeat(64) } };
    const hashPacket = (data: typeof body) => ({ ...data, sha256: createHash("sha256").update(JSON.stringify(data)).digest("hex") });
    await expect(restore(hashPacket(older))).rejects.toMatchObject({ code: "schema_conflict",
      remedy: "capture the source and restore it with the same OpenLup version on a pristine target of the same profile; upgrade the source within its installed profile first if it is older" });
    const incomplete = { ...body, owned: body.owned.filter(entry => entry.table !== tableName) };
    // Temporarily disabled the captured table registration in a disposable transfer packet.
    await expect(restore(hashPacket(incomplete)))
      .rejects.toMatchObject({ code: "invalid_input" });
    expect(await restore()).toMatchObject({ replayed: false });
    expect(await restore()).toMatchObject({ replayed: true });
    expect(await inspectCommerceMoneyLimitsV2(to.owner, scope)).toEqual({ present: true, active: true, value: terms, revision: 3 });
    expect((await captureStoreJourney(to.owner, "limits-restored")).owned.find(entry => entry.table === tableName)).toEqual(packet.owned[index]);
  });
}, postgresSetupTimeoutMs);
