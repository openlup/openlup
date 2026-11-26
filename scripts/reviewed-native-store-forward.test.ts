import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PLATFORM_BASELINE_FILE, readPlatformMigrationManifest, type PlatformMigrationManifest } from "./platform-migration-manifest.ts";
import { assertAdmittedPlatformForward } from "./oss-source-release-contract.ts";
import { waitNativeAdmission } from "./agent-review-queue.mjs";
import { captureCommittedReviewCandidate, git as reviewGit } from "./agent-review-session.mjs";
import { prepareCandidate, receiptSummary, recordReport, RECEIPT_MARKER } from "./agent-review-decide.mjs";
import { definitionPath, definitionPin, definitionSlot, definitionSql, grantPath, grantSlot, grantSql, NATIVE_STORE_GUARD_CATALOGS } from "../tests/helpers/issuedPlatformCatalog.ts";
import { nativeStoreRevokePublicMessages } from "./reviewed-platform-forward.ts";
import { assertAppendOnlyPostgresSuiteClosures, PG_SUITE_CLOSURES_PATH, renderCheckoutOwnerGrant, renderNativeStoreSettingsOwnerWindow, NATIVE_SUCCESSOR_TABLE_SQL, NATIVE_CATALOG_CONTROLS, isNativeStoreMigrationPath, assertCoLocatedForwardApproval, assertNativeStoreForward, assertReviewedPlatformForward, assertSecurityDefinerSearchPath, assertUnchangedForwardApproval, checkConstraintSha256, expectedReplacedFunctionAttrs, nativeStoreFunctionDefinitions, nativeStoreAddedForeignKeys, reviewedFunctionDefinitions, renderQualifiedSecurityDefiner, qualifiedCatalogueStorageSelectSql, sqlStatements, isExpandOnlyPlatformForward, changedForwardApprovals, readReviewedForwardRegistry, sqlSha256, type NativeStoreForwardClass, type NativeStoreSlot, type ReviewedForwardRegistry } from "./reviewed-platform-forward.ts";

const fixture = (path: string) => readFileSync(`scripts/fixtures/reviewed-native-store/${path}`);
const control = JSON.parse(fixture("registry.json").toString()) as NativeStoreForwardClass;
const before = fixture("before.sql");
const production = readReviewedForwardRegistry(readFileSync("config/reviewed-platform-forwards.json"));
const purposeDrop = "ALTER TABLE public.communication_native_sync_state DROP CONSTRAINT communication_native_sync_state_purpose_check;";
const purposeAdd = "ALTER TABLE public.communication_native_sync_state ADD CONSTRAINT communication_native_sync_state_purpose_check CHECK (purpose IN ('marketing_launch_offer','marketing_newsletter','account_gifts'));";
const g6AddColumn = "ALTER TABLE public.payment_truth_events ADD COLUMN review_required_at timestamptz;";
const g6AddCheck = "ALTER TABLE public.payment_truth_events ADD CONSTRAINT payment_truth_events_review_terminal_check CHECK (review_required_at IS NULL OR (state = 'open' AND outcome = 'captured' AND settlement_transition_id IS NULL AND settled_at IS NULL AND dunning_case_id IS NULL AND accounting_document_id IS NULL));";
const created = "public.fixture_created_1()";
const revoke = `REVOKE ALL ON FUNCTION ${created} FROM PUBLIC;`;
const block = (role: string, verb = "REVOKE ALL", signature = created) => `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN EXECUTE '${verb} ON FUNCTION ${signature} ${verb.startsWith("GRANT") ? "TO" : "FROM"} ${role};'; END IF; END; $$;`;

function registry(): ReviewedForwardRegistry {
  const value = structuredClone(production);
  // This registry is test-only; its synthetic baseline is not a production rail.
  delete value.portableReplacementForwards; delete value.portableCreationForwards;
  delete value.batchedForwards; delete value.managedCommerceForwards;
  delete value.supportAuthorityForwards; delete value.channelIngestForwards;
  value.nativeStoreForwardClass = structuredClone(control); value.nativeStoreForwards = [];
  return value;
}
function functionsInSlot(slot: NativeStoreSlot) {
  return [...slot.replacedFunctions, ...slot.createdFunctions.map(fn => ({ ...fn, beforeSha256: null }))];
}
function sql(index = 0): string {
  const slot = control.slots[index]!;
  return [
    ...functionsInSlot(slot).map(fn => `${fn.beforeSha256 ? "CREATE OR REPLACE" : "CREATE"} FUNCTION ${fn.signature.replace("(uuid)", "(p_id uuid)")} RETURNS text LANGUAGE sql SECURITY ${fn.beforeSha256 ? "INVOKER" : "DEFINER"} SET search_path = ${fn.searchPath} AS $$ SELECT 'after'; $$;`),
    ...functionsInSlot(slot).map(fn => `REVOKE ALL ON FUNCTION ${fn.signature} FROM PUBLIC;`),
    ...(index === 6 ? [purposeDrop, purposeAdd, block("authenticated", "GRANT EXECUTE", slot.createdFunctions.map(fn => fn.signature).join(", "))] : []),
  ].join("\n");
}
function bind(value: ReviewedForwardRegistry, index: number, text: string) {
  const slot = value.nativeStoreForwardClass!.slots[index]!;
  const definitions = nativeStoreFunctionDefinitions(Buffer.from(text), functionsInSlot(slot).map(fn => fn.signature), true);
  const pin = { path: slot.path, sha256: sqlSha256(text), functions: functionsInSlot(slot).map(fn => ({ signature: fn.signature, beforeSha256: fn.beforeSha256, afterSha256: definitions.get(fn.signature)! })) };
  const pins = value.nativeStoreForwards!;
  const old = pins.findIndex(entry => entry.path === pin.path);
  if (old < 0) pins.push(pin); else pins[old] = pin;
  return pin;
}
function check(text = sql(), mutate?: (value: ReviewedForwardRegistry) => void) {
  const value = registry(); bind(value, 0, text); mutate?.(value);
  assertNativeStoreForward(value, control.slots[0]!.path, Buffer.from(text), [{ path: PLATFORM_BASELINE_FILE, bytes: before }]);
}
const encode = (value: ReviewedForwardRegistry) => Buffer.from(JSON.stringify(value));

describe("checkout owner execute admission", () => {
  function candidate(text = grantSql, definitions = definitionSql) {
    const value = registry();
    value.nativeStoreForwardClass!.slots = structuredClone([definitionSlot, grantSlot]);
    value.nativeStoreForwards = [definitionPin(definitions), { path: grantPath, sha256: sqlSha256(text), functions: [] }];
    return value;
  }
  function checkGrant(value = candidate(), text = grantSql, definitions = definitionSql, drift = "") {
    return assertNativeStoreForward(value, grantPath, Buffer.from(text), [
      { path: PLATFORM_BASELINE_FILE, bytes: before }, { path: definitionPath, bytes: Buffer.from(definitions) },
      ...(drift ? [{ path: "db/platform/migrations/20990101000001_fixture.sql", bytes: Buffer.from(drift) }] : []),
    ]);
  }

  it("reserves the path without registration and renders the exact UTF-8 bytes", () => {
    const golden = "fc24419cf0dcc0be3434a2550b4e7ea1397925a97f0b2c8187005c90b96e1e9c";
    expect(isNativeStoreMigrationPath(grantPath, [])).toBe(true);
    expect(sqlSha256(renderCheckoutOwnerGrant(definitionPath, "0".repeat(64)))).toBe(golden);
    expect(checkGrant().checkoutPredecessor).toEqual({ slot: definitionSlot, pin: definitionPin() });
  });

  it.each([
    ["table grant", grantSql.replace(/GRANT EXECUTE ON FUNCTION [^;]+/u, "GRANT SELECT ON TABLE public.clients TO openlup_checkout_owner")],
    ["column grant", grantSql.replace(/GRANT EXECUTE ON FUNCTION [^;]+/u, "GRANT SELECT (id) ON TABLE public.clients TO openlup_checkout_owner")],
    ["PUBLIC", grantSql.replace("TO openlup_checkout_owner;", "TO PUBLIC;")],
    ["grant option", grantSql.replace("TO openlup_checkout_owner;", "TO openlup_checkout_owner WITH GRANT OPTION;")],
    ["membership", grantSql.replace(/GRANT EXECUTE ON FUNCTION [^;]+/u, "GRANT service_role TO openlup_checkout_owner")],
    ["revoke", grantSql.replace("GRANT EXECUTE", "REVOKE EXECUTE").replace("TO openlup_checkout_owner;", "FROM openlup_checkout_owner;")],
    ["other role", grantSql.replace("TO openlup_checkout_owner;", "TO authenticated;")],
    ["other function", grantSql.replace("catalog_admission_lock_shared()", "foreign_lock()")],
    ["overload", grantSql.replace("catalog_admission_lock_shared()", "catalog_admission_lock_shared(uuid)")],
    ["legacy guard", grantSql.replace("RETURN;", "NULL;")],
    ["rail guard", grantSql.replace("position OPERATOR(pg_catalog.=) 0 AND", "position OPERATOR(pg_catalog.>) 0 AND")],
    ["definition pin", grantSql.replace(sqlSha256(definitionSql), "1".repeat(64))],
    ["role guard", grantSql.replace("OR checkout_login.rolinherit ", "")],
    ["final LF", grantSql.trimEnd()],
  ])("refuses repinned %s without exposing repair values", (_name, text) => {
    expect(() => checkGrant(candidate(text), text)).toThrow(new RegExp(`^checkout_owner_forward_unverified: ${grantPath}\\. Replay the reviewed grant bytes after landing the rule and its definitions\\.$`, "u"));
  });

  it.each([
    "GRANT EXECUTE ON FUNCTION public.catalog_admission_lock_shared() TO authenticated;",
    "REVOKE EXECUTE ON ROUTINE public.catalog_admission_lock_shared() FROM PUBLIC;",
    "GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;",
    "ALTER FUNCTION public.catalog_admission_lock_shared() SECURITY INVOKER;",
  ])("identifies the drifting source for %s", drift => {
    const path = "db/platform/migrations/20990101000001_fixture.sql";
    expect(() => checkGrant(candidate(), grantSql, definitionSql, drift)).toThrow(`checkout_owner_predecessor_unverified: ${path}.`);
  });

  it.each(["row", "path", "order", "grantee", "extra field", "pin"])("refuses malformed %s before generic admission", kind => {
    const value = candidate(), slot = value.nativeStoreForwardClass!.slots[1]!;
    if (kind === "row") slot.row = "different-row";
    if (kind === "path") slot.path = grantPath.replace("checkout_owner_execute", "other_execute");
    if (kind === "order") slot.grantOnlyFunctions.reverse();
    if (kind === "grantee") slot.grantOnlyFunctions[0]!.grantTo.push("authenticated");
    if (kind === "extra field") slot.qualifiedPriceSetupExecute = true;
    if (kind === "pin") value.nativeStoreForwards![1]!.functions.push(definitionPin().functions[0]!);
    expect(() => readReviewedForwardRegistry(encode(value))).toThrow(/^checkout_owner_slot_invalid:/u);
  });

  it.each([
    "ALTER FUNCTION public.catalog_admission_lock_shared() SECURITY INVOKER;",
    "DROP FUNCTION public.catalog_admission_lock_shared();",
    "ALTER SCHEMA public RENAME TO private;",
    "REASSIGN OWNED BY postgres TO service_role;",
    "DROP TABLE public.clients CASCADE;",
  ])("refuses predecessor drift via %s", drift => {
    expect(() => checkGrant(candidate(), grantSql, definitionSql, drift)).toThrow(/^checkout_owner_predecessor_unverified:/u);
  });

  it("refuses an invoker definition even if the grant and after-hash match", () => {
    const definitions = definitionSql.replace("SECURITY DEFINER", "SECURITY INVOKER");
    const text = renderCheckoutOwnerGrant(definitionPath, sqlSha256(definitions));
    expect(() => checkGrant(candidate(text, definitions), text, definitions)).toThrow(/^checkout_owner_predecessor_unverified:/u);
  });

  it.each(["before", "unissued", "after", "unlisted"] as const)("checks the checkout writer replacement %s the grant", order => {
    const value = candidate();
    const binding = definitionPin().functions.at(-1)!;
    const statement = sqlStatements(definitionSql).find(sql => sql.startsWith(`CREATE FUNCTION ${binding.signature}`))!;
    const replacement = statement.replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION")
      .replace("fixture_checkout_writer_dark", "fixture_checkout_writer_replacement");
    const path = `db/platform/migrations/20990101000${order === "after" || order === "unissued" ? "200" : "050"}_checkout_writer_fixture.sql`;
    const slot = emptySlot(path);
    if (order !== "unlisted") slot.replacedFunctions.push({ signature: binding.signature,
      searchPath: "pg_catalog, pg_temp", beforeSha256: binding.afterSha256 });
    const slots = value.nativeStoreForwardClass!.slots;
    slots.push(slot);
    slots.sort((left, right) => left.path.localeCompare(right.path));
    if (order === "unlisted") value.nativeStoreForwards!.push({ path, sha256: sqlSha256(replacement), functions: [] });
    else bind(value, slots.indexOf(slot), replacement);
    value.nativeStoreForwards!.sort((left, right) => left.path.localeCompare(right.path));
    const prefix = [{ path: PLATFORM_BASELINE_FILE, bytes: before }, { path: definitionPath, bytes: Buffer.from(definitionSql) }];
    if (order === "after") prefix.push({ path: grantPath, bytes: Buffer.from(grantSql) });
    const admit = () => assertNativeStoreForward(value, path, Buffer.from(replacement), prefix);
    if (order === "after") expect(admit).not.toThrow();
    else expect(admit).toThrow(`checkout_owner_predecessor_unverified: ${path}. Issue the checkout grant unit before replacing a checkout routine.`);
  });
});

const catalogueReadTargets = ["public.catalog_offer_memberships_page(text,jsonb,integer,text)", "public.catalog_publication_activation_readiness(text[],text)"];
const catalogueReadRole = "openlup_catalog_publication";
const authorityPath = "db/platform/migrations/q2_20261123192500_catalog_publication_authority.sql";
const authoritySha256 = sqlSha256(readFileSync(authorityPath));
const roleGuard = "  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='openlup_catalog_publication')\n";
const ledgerGuard = `    AND EXISTS (SELECT 1 FROM ONLY public.platform_schema_migrations
      WHERE catalog_path OPERATOR(pg_catalog.=) '${authorityPath}'::pg_catalog.text
        AND sha256 OPERATOR(pg_catalog.=) '${authoritySha256}'::pg_catalog.text)
`;
const catalogueReadGuardRefusal = "qualified catalogue read forward must contain exactly the EXECUTE grant guarded by role existence and the authority ledger path and hash";
const catalogueReadSql = `DO $$ BEGIN
${roleGuard}${ledgerGuard}  THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.catalog_offer_memberships_page(text,jsonb,integer,text),
      public.catalog_publication_activation_readiness(text[],text) TO openlup_catalog_publication;';
  END IF;
END; $$;
`;
const catalogueReadPredecessors = ["20261124120000_catalog_publication_reads.sql", "20261124140000_catalog_publication_readiness.sql"]
  .map(file => `db/platform/migrations/${file}`);
const catalogueReadSlot: NativeStoreSlot = {
  row: "catalogue-read-grant", path: "db/platform/migrations/20990101000000_catalogue_read_grant.sql",
  replacedFunctions: [], createdFunctions: [], dataStatements: [],
  grantOnlyFunctions: catalogueReadTargets.map(signature => ({ signature, grantTo: [catalogueReadRole], revokeFrom: [] })),
};
function catalogueReadFixture() {
  const value = registry();
  value.nativeStoreForwardClass = { sealed: true, slots: [
    ...structuredClone(production.nativeStoreForwardClass!.slots.filter(slot => catalogueReadPredecessors.includes(slot.path))),
    structuredClone(catalogueReadSlot),
  ] };
  value.nativeStoreForwards = structuredClone(production.nativeStoreForwards!.filter(pin => catalogueReadPredecessors.includes(pin.path)));
  const preceding = [{ path: PLATFORM_BASELINE_FILE, bytes: before }, ...catalogueReadPredecessors.map(path => ({ path, bytes: readFileSync(path) }))];
  return { value, preceding };
}
function checkCatalogueRead(value: ReviewedForwardRegistry, preceding: { path: string; bytes: Buffer }[], text = catalogueReadSql) {
  bind(value, value.nativeStoreForwardClass!.slots.length - 1, text);
  assertNativeStoreForward(value, catalogueReadSlot.path, Buffer.from(text), preceding);
}

describe("closed native store class data", () => {
  it("keeps synthetic paths out of production and reads the exact seven-slot fixture", () => {
    expect(() => readReviewedForwardRegistry(encode(registry()))).not.toThrow();
    for (const slot of control.slots) expect(production.nativeStoreForwardClass!.slots.slice(0, 7).some(real => real.path === slot.path)).toBe(false);
    expect(control.slots).toHaveLength(7);
    const old = structuredClone(production); delete old.nativeStoreForwardClass; delete old.nativeStoreForwards;
    expect(() => readReviewedForwardRegistry(encode(old))).not.toThrow();
  });
  it.each(["eighth slot", "wrong rail", "malformed row", "wrong order", "duplicate slot", "unknown signature type", "bad before hash", "CHECK on another row"])("refuses %s", attack => {
    const value = registry(), slots = value.nativeStoreForwardClass!.slots;
    if (attack === "eighth slot") slots.push(structuredClone(slots[0]!));
    if (attack === "wrong rail") slots[0]!.path = slots[0]!.path.replace("db/platform", "supabase");
    if (attack === "malformed row") slots[0]!.row = "bad row";
    if (attack === "wrong order") slots.reverse();
    if (attack === "duplicate slot") slots[1] = structuredClone(slots[0]!);
    if (attack === "unknown signature type") slots[0]!.replacedFunctions[0]!.signature = "public.fixture_existing(regclass)";
    if (attack === "bad before hash") slots[0]!.replacedFunctions[0]!.beforeSha256 = "bad";
    if (attack === "CHECK on another row") slots[0]!.purposeCheck = slots[6]!.purposeCheck;
    expect(() => readReviewedForwardRegistry(encode(value))).toThrow(/reviewed native store/u);
  });
  it("allows unissued inventory changes and refuses slot changes after sealing", () => {
    const prior = registry(), next = registry(); next.nativeStoreForwardClass!.slots.pop();
    expect(() => changedForwardApprovals(encode(prior), encode(next))).not.toThrow();
    prior.nativeStoreForwardClass!.sealed = true;
    next.nativeStoreForwardClass!.sealed = true;
    expect(() => changedForwardApprovals(encode(prior), encode(next))).toThrow(/sealed slot prefix/u);
    const partial = registry(); partial.nativeStoreForwardClass!.slots.pop(); partial.nativeStoreForwardClass!.sealed = true;
    const added = registry(); added.nativeStoreForwardClass!.sealed = true;
    expect(() => changedForwardApprovals(encode(partial), encode(added))).not.toThrow();
    added.nativeStoreForwardClass!.sealed = false;
    expect(() => changedForwardApprovals(encode(prior), encode(added))).toThrow(/sealed slot prefix/u);
  });
  it("refuses replacing one normalized signature again without a bound predecessor", () => {
    const value = registry();
    value.nativeStoreForwardClass!.slots[1]!.replacedFunctions.push(structuredClone(control.slots[0]!.replacedFunctions[0]!));
    expect(() => readReviewedForwardRegistry(encode(value))).toThrow(/chained replacement requires a bound predecessor/u);
  });
});

describe("native store SQL shapes and pins", () => {
  it("accepts the whole seven-slot ordered chain and the widening CHECK", () => {
    const value = registry(), preceding = [{ path: PLATFORM_BASELINE_FILE, bytes: before }];
    for (let index = 0; index < 7; index++) {
      const text = sql(index), pin = bind(value, index, text);
      expect(() => assertNativeStoreForward(value, pin.path, Buffer.from(text), preceding)).not.toThrow();
      preceding.push({ path: pin.path, bytes: Buffer.from(text) });
    }
  });
  it.each([
    "CREATE TABLE public.fixture_table (id uuid, label text);",
    "CREATE INDEX fixture_index ON public.fixture_table (id);",
    "ALTER TABLE public.fixture_table ADD COLUMN note text;",
    "ALTER TABLE public.communication_native_sync_state ADD COLUMN fixture_nullable timestamptz;",
    "ALTER TABLE public.communication_native_sync_state ADD CONSTRAINT fixture_additive_check CHECK (purpose IN ('marketing_launch_offer','marketing_newsletter'));",
  ])("retains expand-only DDL: %s", statement => { expect(() => check(`${sql()}\n${statement}`)).not.toThrow(); });
  it.each(["CASCADE", "SET NULL"])("admits only a new table's foreign-key ON DELETE %s action", action => {
    const statement = `CREATE TABLE public.fixture_table (client_id uuid REFERENCES public.clients(id) ON DELETE ${action});`;
    expect(isExpandOnlyPlatformForward(statement)).toBe(false);
    expect(() => check(`${sql()}\n${statement}`)).not.toThrow();
    const normalized = statement.toLowerCase().replace("on delete", "on /* action */\n delete");
    expect(() => check(`${sql()}\n${normalized}`)).not.toThrow();
  });
  it.each([
    "ALTER TABLE public.clients ADD COLUMN other_id uuid REFERENCES public.clients(id) ON DELETE CASCADE;",
    "ALTER TABLE public.clients ADD COLUMN other_id uuid REFERENCES public.clients(id) ON DELETE SET NULL;",
    "DELETE FROM public.clients;",
    "SET search_path = public;",
    "CREATE TABLE public.fixture_table (id bigint DEFAULT nextval('public.fixture_sequence'));",
    "CREATE TABLE public.fixture_table (value text CHECK (public.fixture_check(value)));",
    "CREATE TABLE public.fixture_table (LIKE public.clients INCLUDING ALL);",
    "CREATE TABLE public.fixture_table AS SELECT id FROM public.clients;",
    "CREATE TABLE public.fixture_table AS TABLE public.clients;",
    "CREATE TABLE public.fixture_table AS VALUES (1);",
    "CREATE TABLE public.fixture_table (payload jsonb DEFAULT '{}'::jsonb);",
  ])("keeps default-mode refusals outside new-table FK actions: %s", statement => {
    expect(() => check(`${sql()}\n${statement}`)).toThrow(/reviewed native store/u);
  });
  it.each([
    ["unknown signature", () => `${sql()}\nCREATE FUNCTION public.fixture_unlisted() RETURNS text LANGUAGE sql AS $$ SELECT ''; $$;`],
    ["missing revoke", () => sql().replace(revoke, "")],
    ["PUBLIC grant", () => `${sql()}\nGRANT EXECUTE ON FUNCTION ${created} TO PUBLIC;`],
    ["grant before revoke", () => sql().replace(revoke, `GRANT EXECUTE ON FUNCTION ${created} TO authenticated;\n${revoke}`)],
    ["unpinned definer", () => sql().replace("SECURITY DEFINER SET search_path = pg_catalog, pg_temp", "SECURITY DEFINER")],
    ["drifted search path", () => sql().replace("pg_catalog, pg_temp", "public")],
    ["header comment evasion", () => sql().replace("SECURITY DEFINER", "SECURITY/**/DEFINER")],
    ["wrong creation kind", () => sql().replace("CREATE FUNCTION public.fixture_created", "CREATE OR REPLACE FUNCTION public.fixture_created")],
    ["destructive statement", () => `${sql()}\nDROP TABLE public.fixture_table;`],
    ["DROP NOT NULL", () => `${sql()}\nALTER TABLE public.fixture_table ALTER COLUMN id DROP NOT NULL;`],
    ["replacement header change", () => sql().replace("LANGUAGE sql SECURITY INVOKER", "LANGUAGE sql STABLE SECURITY INVOKER")],
    ["role statement", () => `${sql()}\nCREATE ROLE fixture_role;`],
    ["default privileges", () => `${sql()}\nALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO authenticated;`],
    ["table privilege", () => `${sql()}\nGRANT SELECT ON public.fixture_table TO authenticated;`],
    ["unlisted row change", () => `${sql()}\nUPDATE public.fixture_table SET label='changed';`],
    ["unnamed seed", () => `${sql()}\nINSERT INTO public.fixture_table (label) VALUES ('seed') ON CONFLICT DO NOTHING;`],
    ["plain DO", () => `${sql()}\nDO $$ BEGIN NULL; END; $$;`],
  ] as const)("refuses fully repinned %s", (_label, text) => { expect(() => check(text())).toThrow(/reviewed native store/u); });
  it("refuses unknown paths, before/after drift and missing predecessors", () => {
    expect(() => check(sql(), value => { value.nativeStoreForwards![0]!.path += "x"; })).toThrow(/reviewed native store/u);
    expect(() => check(sql(), value => { value.nativeStoreForwards![0]!.functions[0]!.beforeSha256 = "0".repeat(64); })).toThrow(/before-hash/u);
    expect(() => check(sql(), value => { value.nativeStoreForwardClass!.slots[0]!.replacedFunctions[0]!.beforeSha256 = "0".repeat(64); value.nativeStoreForwards![0]!.functions[0]!.beforeSha256 = "0".repeat(64); })).toThrow(/actual base function before-hash/u);
    expect(() => check(sql(), value => { value.nativeStoreForwards![0]!.functions[0]!.afterSha256 = "0".repeat(64); })).toThrow(/definition/u);
    const value = registry(), text = sql(1), pin = bind(value, 1, text);
    expect(() => assertNativeStoreForward(value, pin.path, Buffer.from(text), [{ path: PLATFORM_BASELINE_FILE, bytes: before }])).toThrow(/earlier slot/u);
    value.nativeStoreForwardClass!.slots.shift();
    expect(() => assertNativeStoreForward(value, pin.path, Buffer.from(text), [{ path: PLATFORM_BASELINE_FILE, bytes: before }])).not.toThrow();
    expect(() => check(`${sql()} `, value => { value.nativeStoreForwards![0]!.sha256 = sqlSha256(sql()); })).toThrow(/file hash/u);
  });
  it("admits only exactly named data statements", () => {
    const statement = "INSERT INTO public.fixture_table (label) VALUES ('seed') ON CONFLICT DO NOTHING;";
    expect(() => check(`${sql()}\n${statement}`, value => { value.nativeStoreForwardClass!.slots[0]!.dataStatements.push(statement); })).not.toThrow();
    expect(() => check(sql(), value => { value.nativeStoreForwardClass!.slots[0]!.dataStatements.push(statement); })).toThrow(/data statement missing/u);
  });
  it("refuses unsupported quoted preceding function DDL rather than trusting a stale preimage", () => {
    const value = registry(), text = sql(), pin = bind(value, 0, text);
    const preceding = [{ path: PLATFORM_BASELINE_FILE, bytes: before }, { path: "db/platform/migrations/20261101221999_fixture_history.sql", bytes: Buffer.from('CREATE OR REPLACE FUNCTION "public".fixture_existing(p_id uuid) RETURNS text LANGUAGE sql AS $$ SELECT \'drift\'; $$;') }];
    expect(() => assertNativeStoreForward(value, pin.path, Buffer.from(text), preceding)).toThrow(/preceding function DDL/u);
  });
  it.each(["narrowed CHECK", "different CHECK", "missing add", "preimage drift", "nonadjacent pair", "quoted intervening DDL"])("refuses %s", attack => {
    const value = registry(), preceding = [{ path: PLATFORM_BASELINE_FILE, bytes: before }];
    for (let index = 0; index < 6; index++) { const text = sql(index), pin = bind(value, index, text); preceding.push({ path: pin.path, bytes: Buffer.from(text) }); }
    let text = sql(6);
    if (attack === "narrowed CHECK") text = text.replace("'marketing_newsletter',", "");
    if (attack === "different CHECK") text = text.replaceAll("communication_native_sync_state_purpose_check", "another_check");
    if (attack === "missing add") text = text.replace(purposeAdd, "");
    if (attack === "preimage drift") value.nativeStoreForwardClass!.slots[6]!.purposeCheck!.beforeSha256 = "0".repeat(64);
    if (attack === "nonadjacent pair") text = text.replace(purposeDrop, `${purposeDrop}\nCREATE TABLE public.fixture_gap (id uuid);`);
    if (attack === "quoted intervening DDL") preceding.push({ path: "db/platform/migrations/20261101231999_fixture_history.sql", bytes: Buffer.from('ALTER TABLE "public"."communication_native_sync_state" ALTER COLUMN purpose DROP NOT NULL;') });
    const pin = bind(value, 6, text);
    expect(() => assertNativeStoreForward(value, pin.path, Buffer.from(text), preceding)).toThrow(/CHECK|closed shapes/u);
  });
  it("binds distinct production and synthetic account-consent CHECK preimages", () => {
    const slot = production.nativeStoreForwardClass!.slots.find(slot => slot.row === "G11-c")!;
    const real = sqlStatements(readFileSync("db/platform/migrations/20261019200000_communications_native_operations.sql", "utf8")).find(statement => statement.startsWith("CREATE TABLE public.communication_native_sync_state ("))!;
    expect(slot.purposeCheck).toEqual({ beforeSha256: sqlSha256(real), values: ["marketing_launch_offer", "marketing_newsletter"] });
    expect(slot.createdFunctions).toEqual([
      { signature: "public.customer_account_communication_choices_as_actor(uuid)", searchPath: "pg_catalog, pg_temp" },
      { signature: "public.customer_account_communication_choice_set_as_actor(uuid,text,boolean,text)", searchPath: "pg_catalog, pg_temp" },
      { signature: "public.subscription_register_renewal_purchase_with_shipping(uuid,jsonb)", searchPath: "pg_catalog, pg_temp" },
      { signature: "public.subscription_renewal_purchase_terms(uuid)", searchPath: "pg_catalog, pg_temp" },
    ]);
    expect(slot.dataStatements).toEqual([
      "INSERT INTO public.client_absorption_policy (table_name, disposition, note) VALUES ('subscription_stock_wait_cases', 'block', 'A frozen subscription delivery is a commercial obligation bound to its original client; never carry or rebind it when absorbing a lead.');",
      "INSERT INTO public.client_absorption_policy (table_name, disposition, note) VALUES ('identity_privacy_erasures', 'block', 'A privacy erasure is a legal process on one named record; absorption never moves or bypasses it.');",
      "INSERT INTO public.client_absorption_policy (table_name, disposition, note) VALUES ('subscription_command_receipts', 'block', 'Subscription command receipts belong to the subscriptions they answer, which already block absorption; never carry or rebind them.');",
    ]);
    const statement = sqlStatements(before.toString()).find(statement => statement.startsWith("CREATE TABLE public.communication_native_sync_state ("))!;
    expect(control.slots[6]!.purposeCheck!.beforeSha256).toBe(sqlSha256(statement));
    expect(control.slots[6]!.createdFunctions.map(fn => fn.signature)).toEqual(["public.fixture_account_choices(uuid)", "public.fixture_account_choice_set(uuid,text,boolean,text)"]);
  });
  it("uses the last preceding definition and refuses the first definition's stale pin", () => {
    const value = registry(), slot = value.nativeStoreForwardClass!.slots[0]!, signature = "public.fixture_existing(uuid)";
    slot.createdFunctions = [];
    const first = sqlStatements(before.toString()).find(s => s.startsWith("CREATE FUNCTION public.fixture_existing("))!;
    const second = first.replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION").replace("'before'", "'intermediate'");
    const after = second.replace("'intermediate'", "'after'");
    slot.replacedFunctions[0]!.beforeSha256 = sqlSha256(second); bind(value, 0, after);
    const prefix = [{ path: PLATFORM_BASELINE_FILE, bytes: before }, { path: "db/platform/migrations/20261030122100_fixture_history.sql", bytes: Buffer.from(second) }];
    expect(() => assertNativeStoreForward(value, slot.path, Buffer.from(after), prefix)).not.toThrow();
    slot.replacedFunctions[0]!.beforeSha256 = sqlSha256(first); bind(value, 0, after);
    expect(() => assertNativeStoreForward(value, slot.path, Buffer.from(after), prefix)).toThrow(/actual base function before-hash/u);
    expect(nativeStoreFunctionDefinitions(Buffer.from(`${first}\n${second}`), [signature], true).get(signature)).toBe(sqlSha256(second));
  });
  it("accepts G6 nullable ADD COLUMN plus additive CHECK on an existing prefix table", () => {
    expect(sqlStatements(before.toString()).some(statement => statement.startsWith("CREATE TABLE public.payment_truth_events ("))).toBe(true);
    for (const statement of [g6AddColumn, g6AddCheck, `${g6AddColumn}\n${g6AddCheck}`]) expect(isExpandOnlyPlatformForward(statement)).toBe(true);
    expect(() => check(`${sql()}\n${g6AddColumn}\n${g6AddCheck}`)).not.toThrow();
  });
  it.each([
    ["DROP existing CHECK", "ALTER TABLE public.payment_truth_events DROP CONSTRAINT payment_truth_events_fixture_state_check;"],
    ["replace existing CHECK", "ALTER TABLE public.payment_truth_events DROP CONSTRAINT payment_truth_events_fixture_state_check;\nALTER TABLE public.payment_truth_events ADD CONSTRAINT payment_truth_events_fixture_state_check CHECK (state IN ('open','settled','review'));"],
    ["G11-c named CHECK outside its slot", purposeDrop],
    ["DROP NOT NULL", "ALTER TABLE public.payment_truth_events ALTER COLUMN state DROP NOT NULL;"],
  ])("refuses existing-table %s", (_label, statement) => {
    expect(isExpandOnlyPlatformForward(statement)).toBe(false);
    expect(() => check(`${sql()}\n${statement}`)).toThrow(/reviewed native store/u);
  });
  it("preserves inherited admission of NOT NULL ADD COLUMN without a default", () => {
    const statement = "ALTER TABLE public.payment_truth_events ADD COLUMN fixture_required text NOT NULL;";
    expect(isExpandOnlyPlatformForward(statement)).toBe(true);
    expect(() => check(`${sql()}\n${statement}`)).not.toThrow();
  });
  it("pins the issued production prefix and finds every replacement/grant-only signature in the immutable base prefix", () => {
    const slots = production.nativeStoreForwardClass!.slots.slice(0, 7);
    expect(slots.map(slot => slot.row)).toEqual(["G6", "G2", "G4", "G3", "G7", "G8", "G11-c"]);
    expect(slots.find(slot => slot.row === "G6")!.replacedFunctions).toHaveLength(5);
    expect(slots.find(slot => slot.row === "G6")!.createdFunctions).toHaveLength(4);
    expect(slots.find(slot => slot.row === "G2")!.replacedFunctions.map(fn => fn.signature)).toEqual(["public.subscription_activation_commit(public.subscription_activations,text,text,timestamptz,boolean)"]);
    expect(slots.find(slot => slot.row === "G2")!.createdFunctions).toHaveLength(7);
    expect(slots.find(slot => slot.row === "G7")!.replacedFunctions.map(fn => fn.signature)).toEqual([
      "public.subscription_claim_due_renewal(text,text,jsonb,text,integer,timestamptz)",
      "public.commerce_prepare_subscription_renewal(uuid,uuid,timestamptz)",
      "public.fulfillment_reserve_subscription_renewal(uuid,uuid,integer,timestamptz)",
      "public.fulfillment_release_subscription_renewal(uuid,uuid,text,timestamptz)",
      "public.fulfillment_expire_subscription_renewals(timestamptz,integer)",
      "public.subscription_stock_wait_admit(jsonb,jsonb,timestamptz)",
      "public.subscription_stock_wait_recover_refusal(uuid,text,text,timestamptz)",
      "public.subscription_stock_wait_deficits(jsonb,uuid,timestamptz)",
    ]);
    expect(slots.find(slot => slot.row === "G7")!.createdFunctions).toEqual([
      { signature: "public.commerce_view_shipment_destination(uuid)", searchPath: "pg_catalog, pg_temp" },
    ]);
    expect(slots.find(slot => slot.row === "G7")!.grantOnlyFunctions).toEqual([]);
    expect(slots.find(slot => slot.row === "G8")!.replacedFunctions).toEqual([
      { signature: "public.commerce_order_emit_paid_notification()", beforeSha256: "6352247a869fda2812d3e83fbcd9b7a0bd9106d27bec22296492e06a15f78bee", searchPath: "public, pg_catalog" },
      { signature: "public.commerce_create_promoted_order_draft_with_outbox(text,jsonb,jsonb,uuid)", beforeSha256: "2dd59a4f2eb7603e2a1714a97ccfad3d078990cb8978a4db16c130ff9db43364", searchPath: "pg_catalog" },
      { signature: "public.commerce_order_assert_line_sum()", beforeSha256: "403236204ab35f1776bb1d43a0c9878872fc1547874772b7634b0216b8d837d4", searchPath: "public, pg_catalog" },
    ]);
    expect(slots.find(slot => slot.row === "G8")!.createdFunctions).toEqual([
      { signature: "public.commerce_promotion_lock_definition(text)", searchPath: "pg_catalog, pg_temp" },
    ]);
    expect(slots.find(slot => slot.row === "G8")!.grantOnlyFunctions).toHaveLength(8);
    const signatures = slots.flatMap(slot => [...functionsInSlot(slot), ...slot.grantOnlyFunctions].map(fn => fn.signature)), actual = new Map<string, string>();
    for (const file of readdirSync("db/platform/migrations").filter(file => /^\d{14}_.*\.sql$/u.test(file) && file < "20261101222000_").sort()) {
      for (const [signature, digest] of nativeStoreFunctionDefinitions(readFileSync(`db/platform/migrations/${file}`), signatures, true)) actual.set(signature, digest);
    }
    for (const slot of slots) {
      for (const fn of slot.replacedFunctions) expect(actual.get(fn.signature), fn.signature).toBe(fn.beforeSha256);
      for (const fn of slot.createdFunctions) expect(actual.has(fn.signature), fn.signature).toBe(false);
      for (const fn of slot.grantOnlyFunctions) {
        expect(actual.has(fn.signature), fn.signature).toBe(true);
        expect(fn.grantTo).toEqual(slot.row === "G7" ? [] : ["service_role"]); expect(fn.revokeFrom).toEqual(slot.row === "G7" ? ["service_role"] : []);
      }
    }
  });
});

describe("class-local normalized argument identities", () => {
  const compositeSignature = "public.fixture_composite_existing(public.fixture_row,timestamptz)";
  const compositeBefore = sqlStatements(before.toString()).find(statement => statement.startsWith("CREATE FUNCTION public.fixture_composite_existing("))!;
  const compositeAfter = compositeBefore.replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION").replace("'before'", "'after'");
  it("accepts the exact composite/table argument and timestamp alias without widening generic readers", () => {
    const value = registry(), slot = value.nativeStoreForwardClass!.slots[0]!;
    slot.replacedFunctions = [{ signature: compositeSignature, beforeSha256: sqlSha256(compositeBefore), searchPath: "pg_catalog" }]; slot.createdFunctions = [];
    bind(value, 0, compositeAfter);
    expect(() => assertNativeStoreForward(value, slot.path, Buffer.from(compositeAfter), [{ path: PLATFORM_BASELINE_FILE, bytes: before }])).not.toThrow();
    expect(nativeStoreFunctionDefinitions(Buffer.from(compositeAfter), [compositeSignature]).get(compositeSignature)).toBe(sqlSha256(compositeAfter));
    expect(() => reviewedFunctionDefinitions(Buffer.from(compositeAfter))).toThrow(/unsupported/u);
  });
  it.each([
    ["different composite type", compositeAfter.replace("PUBLIC.fixture_row", "public.other_row")],
    ["malformed qualified type", compositeAfter.replace("PUBLIC.fixture_row", "public..fixture_row")],
    ["argument order", compositeAfter.replace("p_row PUBLIC.fixture_row, p_at timestamp with time zone", "p_at timestamp with time zone, p_row public.fixture_row")],
  ])("refuses %s", (_label, text) => { expect(() => nativeStoreFunctionDefinitions(Buffer.from(text), [compositeSignature])).toThrow(/reviewed native store/u); });
  it.each(["boolean", "timestamptz", "text[]"])("refuses an unlisted %s signature in both class and unchanged generic readers", type => {
    const text = `CREATE FUNCTION public.fixture_created_1(p_value ${type}) RETURNS text LANGUAGE sql AS $$ SELECT ''; $$;`;
    expect(() => nativeStoreFunctionDefinitions(Buffer.from(text), [created])).toThrow(/unlisted signature/u);
    expect(() => reviewedFunctionDefinitions(Buffer.from(text))).toThrow(/unsupported/u);
    const value = registry(), after = `${sql()}\n${text}`; bind(value, 0, after);
    expect(() => assertNativeStoreForward(value, control.slots[0]!.path, Buffer.from(after), [{ path: PLATFORM_BASELINE_FILE, bytes: before }])).toThrow(/unlisted signature/u);
  });
  it.each(["IN", "OUT", "INOUT", "VARIADIC"])("refuses unsupported %s argument modes rather than treating them as parameter names", mode => {
    const text = `CREATE FUNCTION public.fixture_mode(${mode} uuid) RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid; $$;`;
    expect(() => nativeStoreFunctionDefinitions(Buffer.from(text), ["public.fixture_mode(uuid)"])).toThrow(/unsupported argument mode/u);
  });
});

describe("PostgreSQL identifier boundaries", () => {
  const probe = "public.fixture_probe()";
  const definition = (name = probe) => `CREATE FUNCTION ${name} RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ SELECT 'value'; $$;`;
  const run = (signature: string, statement: string, tail = `REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC;`, prefix = "") => {
    const value = registry(), slot = value.nativeStoreForwardClass!.slots[0]!;
    slot.replacedFunctions = []; slot.createdFunctions = [{ signature, searchPath: "pg_catalog, pg_temp" }];
    const text = `${prefix}\n${statement}\n${tail}`;
    // Independent raw hashes keep attacks fully repinned even if the identity reader refuses them.
    value.nativeStoreForwards = [{ path: slot.path, sha256: sqlSha256(text), functions: [{ signature, beforeSha256: null, afterSha256: sqlSha256(statement) }] }];
    assertNativeStoreForward(value, slot.path, Buffer.from(text), [{ path: PLATFORM_BASELINE_FILE, bytes: before }]);
  };
  it.each(["\u00a0", "\u2002", "\u2028", "\ufeff"])("refuses a non-ASCII identifier suffix U+%s", separator => {
    const target = probe.replace("(", `${separator}(`);
    expect(() => run(probe, definition(target), `REVOKE ALL ON FUNCTION ${target} FROM PUBLIC;`)).toThrow(/reviewed native store/u);
  });
  it.each([
    ["public.fixture_probe(uuid)", "public.fixture_probe(p_value uuid\u00a0)"],
    ["public.fixture_probe(public.fixture_row)", "public.fixture_probe(p_value public.\u00a0fixture_row)"],
    ["public.fixture_probe(public.fixture_key)", "public.fixture_probe(p_value public.fixture_\u212aey)"],
  ])("refuses a different SQL argument identity disguised as %s", (signature, target) => {
    expect(() => run(signature, definition(target))).toThrow(/reviewed native store/u);
  });
  it("refuses a function name that Unicode case-folds into the listed ASCII name", () => {
    expect(() => run("public.fixture_keep()", definition("public.fixture_\u212aeep()"))).toThrow(/reviewed native store/u);
  });
  it.each([
    `GRANT EXECUTE ON FUNCTION ${probe} TO \u017fervice_role;`,
    block("\u017fervice_role", "GRANT EXECUTE", probe),
  ])("refuses a Unicode lookalike outside the closed role list: %s", privilege => {
    expect(() => run(probe, definition(), `REVOKE ALL ON FUNCTION ${probe} FROM PUBLIC;\n${privilege}`)).toThrow(/reviewed native store/u);
  });
  it("refuses a different function in a privilege target with a Unicode suffix", () => {
    expect(() => run(probe, definition(), `REVOKE ALL ON FUNCTION ${probe} FROM PUBLIC;\n${block("service_role", "GRANT EXECUTE", probe.replace("(", "\u00a0("))}`)).toThrow(/reviewed native store/u);
  });
  it("refuses Unicode case-folding in a same-file table narrowing target", () => {
    expect(() => run(probe, definition(), `REVOKE ALL ON FUNCTION ${probe} FROM PUBLIC;\nALTER TABLE public.fixture_\u212aeep ENABLE ROW LEVEL SECURITY;`, "CREATE TABLE public.fixture_keep (id uuid);")).toThrow(/reviewed native store/u);
  });
  it("retains ASCII token whitespace and Unicode literal data", () => {
    const signature = "public.fixture_probe(text)";
    const statement = "CREATE FUNCTION public.fixture_probe(\tp_value text DEFAULT 'Żółć\u00a0')\nRETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ SELECT p_value; $$;";
    expect(() => run(signature, statement, undefined, "CREATE TABLE public.fixture_literal (label text DEFAULT 'Żółć\u00a0');")).not.toThrow();
  });
  it.each(["\u00a0", "\u2002", "\u2028", "\ufeff"])("refuses Unicode before statements with fresh pins: %s", separator => {
    expect(() => run(probe, definition(), undefined, separator)).toThrow(/reviewed native store/u);
    expect(() => run(probe, definition(), `${separator}REVOKE ALL ON FUNCTION ${probe} FROM PUBLIC;`)).toThrow(/reviewed native store/u);
  });
  it("refuses a Unicode spelling of the fixed guard relation", () => {
    const privilege = block("service_role", "GRANT EXECUTE", probe).replace("pg_roles", "pg_role\u017f");
    expect(() => run(probe, definition(), `REVOKE ALL ON FUNCTION ${probe} FROM PUBLIC;\n${privilege}`)).toThrow(/reviewed native store/u);
  });
  it("refuses Unicode keywords inside a conditional table privilege", () => {
    const privilege = "DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVO\u212aE ALL ON TABLE public.fixture_keep FROM anon;'; END IF; END; $$;";
    expect(() => run(probe, definition(), `REVOKE ALL ON FUNCTION ${probe} FROM PUBLIC;\n${privilege}`, "CREATE TABLE public.fixture_keep (id uuid);")).toThrow(/reviewed native store/u);
  });
  it.each(["create or replace FUNCTION", "Create OR Replace Function", "CREATE or REPLACE FUNCTION"])("refuses %s for a created signature", introducer => {
    expect(() => run(probe, definition().replace("CREATE FUNCTION", introducer))).toThrow(/creation\/replacement/u);
  });
  it("retains plain CREATE with case-varied keywords", () => {
    expect(() => run(probe, definition().replace("CREATE FUNCTION", "create FUNCTION"))).not.toThrow();
  });
  it.each([
    "p_kind text DEFAULT 'x,uuid DEFAULT x,text DEFAULT x,jsonb DEFAULT x,timestamptz DEFAULT x'",
    "p_key text, p_owner uuid, p_kind text DEFAULT 'x,jsonb DEFAULT x,timestamptz DEFAULT x'",
    "p_kind text DEFAULT $value$x,uuid DEFAULT x,text DEFAULT x,jsonb DEFAULT x,timestamptz DEFAULT x$value$",
  ])("refuses a listed argument count fabricated inside a default: %s", args => {
    const signature = "public.fixture_probe(text,uuid,text,jsonb,timestamptz)";
    const statement = definition(`public.fixture_probe(${args})`);
    expect(() => run(signature, statement)).toThrow(/unlisted signature/u);
  });
  it.each([
    ["text", "p_value text DEFAULT 'left,right'"],
    ["text", "p_value text DEFAULT coalesce('left,right', 'Żółć')"],
    ["text", "p_value text DEFAULT $value$Żółć,uuid DEFAULT x$value$"],
    ["text[]", "p_value text[] DEFAULT ARRAY['left,right','Żółć']"],
  ])("retains the actual %s identity with a complex default: %s", (type, args) => {
    const signature = `public.fixture_probe(${type})`;
    expect(() => run(signature, definition(`public.fixture_probe(${args})`))).not.toThrow();
  });
  it("does not treat identifier-adjacent dollars as default quote delimiters", () => {
    const args = "p_text text DEFAULT public.fixture_x$value$one(), p_owner uuid DEFAULT public.fixture_x$value$two()";
    const statement = definition(`public.fixture_probe(${args})`);
    expect(() => run("public.fixture_probe(text)", statement)).toThrow(/unlisted signature/u);
    expect(() => run("public.fixture_probe(text,uuid)", statement)).not.toThrow();
  });
  // PostgreSQL ends a standard literal at the quote after a backslash, so the escape reading of the splitter would see one
  // statement where the database runs several: here a listed function, then an operator that hides a second function.
  it("refuses a backslash in a quoted literal that hides statements from the splitter", () => {
    const statement = String.raw`CREATE FUNCTION public.cat_created(p text DEFAULT ' SET search_path = pg_catalog, pg_temp AS $q$') RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS 'select 1 --\';`;
    const hidden = String.raw`CREATE FUNCTION pg_catalog.cat_ge(oid, integer) RETURNS boolean LANGUAGE sql STABLE AS $b$ SELECT $1::bigint >= $2 AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE oid = $1 AND proname IN ($n$cat_ge$n$, $n$cat_evil$n$)) $b$;
CREATE OPERATOR pg_catalog.>= (LEFTARG = oid, RIGHTARG = integer, FUNCTION = pg_catalog.cat_ge);
CREATE FUNCTION public.cat_evil(c text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $b$ BEGIN EXECUTE c; END $b$;
SELECT ' $a$ ';
SELECT 1 AS x$a$, 2 AS y$q$;
REVOKE ALL ON FUNCTION public.cat_created(text) FROM PUBLIC;`;
    expect(() => run("public.cat_created(text)", statement, hidden)).toThrow(/backslashes in quoted literals and identifiers/u);
  });
  it.each([
    ["a single-quoted literal", "SELECT 'a\\'; SELECT 1;"],
    ["a double-quoted identifier", "SELECT 1 AS \"a\\\"; SELECT 2 AS \"b\";"],
    ["an escape string", "SELECT E'a\\n';"],
  ])("refuses a backslash in %s of a candidate", (_label, text) => {
    expect(() => sqlStatements(text, false, false, true)).toThrow(/backslashes in quoted literals and identifiers/u);
  });
  it("keeps the older reading for preceding files and other splitter modes", () => {
    expect(sqlStatements("SELECT E'a\\n';", true, false, true)).toHaveLength(1);
    expect(sqlStatements("SELECT E'a\\n';")).toHaveLength(1);
  });
  it("retains a backslash inside a dollar body", () => {
    expect(() => run(probe, definition().replace("'value'", "E'\\u0020'"))).not.toThrow();
  });
  it("hashes the complete function when a return identifier contains dollar markers", () => {
    const statement = "CREATE FUNCTION public.fixture_probe() RETURNS public.fixture_type$value$one LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $value$ SELECT NULL; $value$;";
    expect(nativeStoreFunctionDefinitions(Buffer.from(statement), [probe]).get(probe)).toBe(sqlSha256(statement));
  });
  it("retains Unicode comments and literal data around statement delimiters", () => {
    const signature = "public.fixture_probe(text)";
    const statement = "CREATE FUNCTION public.fixture_probe(p_value text DEFAULT 'left; Żółć') RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ SELECT 'right; Żółć'; $$;";
    expect(() => run(signature, statement, undefined, "-- Żółć\u00a0\n/* Żółć /* nested */ */")).not.toThrow();
  });
});

describe("grant-only existing functions", () => {
  it("admits the original qualified catalogue read grant byte for byte against the issued function pins", () => {
    expect(production.qualifiedInstallations).toContainEqual({ path: authorityPath, sha256: authoritySha256 });
    const path = "db/platform/migrations/20261124180000_catalogue_read_grant.sql";
    expect(sqlSha256(catalogueReadSql)).toBe("bf21227266ec2f3be97b1ee74597e2683fbdd86755f6157ebb888ec56d5c524a");
    const directory = "db/platform/migrations";
    const preceding = readdirSync(directory).filter(file => /^\d{14}_.*\.sql$/u.test(file))
      .map(file => `${directory}/${file}`).filter(file => file < path).sort()
      .map(path => ({ path, bytes: readFileSync(path) }));
    expect(() => assertNativeStoreForward(production, path, readFileSync(path), preceding)).not.toThrow();
  });
  it.each([
    ["missing target", (slot: NativeStoreSlot) => slot.grantOnlyFunctions.pop()],
    ["extra target", (slot: NativeStoreSlot) => slot.grantOnlyFunctions.push({ signature: "public.fixture_extra()", grantTo: [catalogueReadRole], revokeFrom: [] })],
    ["revoke capability", (slot: NativeStoreSlot) => slot.grantOnlyFunctions[0]!.revokeFrom.push("service_role")],
    ["extra slot list", (slot: NativeStoreSlot) => { slot.existingTableStatements = []; }],
  ] as const)("refuses a qualified catalogue read slot with %s", (_label, change) => {
    const { value, preceding } = catalogueReadFixture();
    change(value.nativeStoreForwardClass!.slots.at(-1)!);
    expect(() => checkCatalogueRead(value, preceding)).toThrow("qualified catalogue read slot must list exactly the two grants and no other capabilities");
  });
  it("refuses a qualified catalogue read grant with an absent predecessor slot", () => {
    const { value, preceding } = catalogueReadFixture();
    value.nativeStoreForwardClass!.slots.shift();
    value.nativeStoreForwards!.shift();
    expect(() => checkCatalogueRead(value, preceding)).toThrow(`qualified catalogue read target must resolve to its pinned predecessor: ${catalogueReadTargets[0]}`);
  });
  it("refuses a qualified catalogue read grant with an absent predecessor file", () => {
    const { value, preceding } = catalogueReadFixture();
    preceding.splice(1, 1);
    expect(() => checkCatalogueRead(value, preceding)).toThrow("requires every earlier slot landed first");
  });
  it("refuses a qualified catalogue read grant with a drifted predecessor file", () => {
    const { value, preceding } = catalogueReadFixture();
    preceding[1]!.bytes = Buffer.concat([preceding[1]!.bytes, Buffer.from("\n")]);
    expect(() => checkCatalogueRead(value, preceding)).toThrow("requires every earlier slot landed first");
  });
  it("refuses a qualified catalogue read grant with a drifted predecessor function pin", () => {
    const { value, preceding } = catalogueReadFixture();
    value.nativeStoreForwards![0]!.functions.find(fn => fn.signature === catalogueReadTargets[0])!.afterSha256 = "0".repeat(64);
    expect(() => checkCatalogueRead(value, preceding)).toThrow(`qualified catalogue read target must resolve to its pinned predecessor: ${catalogueReadTargets[0]}`);
  });
  const signature = "public.fixture_grant(text[])";
  const setup = () => {
    const value = registry(), slot = value.nativeStoreForwardClass!.slots[0]!;
    slot.replacedFunctions = []; slot.createdFunctions = [];
    slot.grantOnlyFunctions = [{ signature, grantTo: ["service_role"], revokeFrom: ["anon", "authenticated", "service_role"] }];
    return value;
  };
  const run = (value: ReviewedForwardRegistry, text: string, prefix = [{ path: PLATFORM_BASELINE_FILE, bytes: before }]) => {
    bind(value, 0, text); assertNativeStoreForward(value, control.slots[0]!.path, Buffer.from(text), prefix);
  };
  it("accepts a normalized array target with no new definition or PUBLIC revoke", () => {
    expect(() => run(setup(), block("service_role", "GRANT EXECUTE", "public.fixture_grant( pg_catalog.text [ ][ ] )"))).not.toThrow();
  });
  it.each(["anon", "authenticated", "service_role"])("admits only the pinned conditional REVOKE capability for %s", role => {
    expect(() => run(setup(), block(role, "REVOKE ALL", signature))).not.toThrow();
  });
  it.each([
    ["unlisted signature", block("service_role", "GRANT EXECUTE", "public.fixture_not_listed(text[])")],
    ["unlisted array type", block("service_role", "GRANT EXECUTE", "public.fixture_grant(uuid[])")],
    ["direct grant", `GRANT EXECUTE ON FUNCTION ${signature} TO service_role;`],
    ["direct revoke", `REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC;`],
    ["unpinned role", block("authenticated", "GRANT EXECUTE", signature)],
  ])("refuses %s", (_label, text) => { expect(() => run(setup(), text)).toThrow(/reviewed native store/u); });
  it("refuses a conditional verb outside that function's pinned role capability", () => {
    const value = setup(); value.nativeStoreForwardClass!.slots[0]!.grantOnlyFunctions[0]!.revokeFrom = [];
    expect(() => run(value, block("service_role", "REVOKE ALL", signature))).toThrow(/closed conditional role\/verb/u);
  });
  it("refuses a grant-only function absent from the base chain", () => {
    const value = setup(); value.nativeStoreForwardClass!.slots[0]!.grantOnlyFunctions[0]!.signature = "public.fixture_absent(text[])";
    expect(() => run(value, block("service_role", "GRANT EXECUTE", "public.fixture_absent(text[])"))).toThrow(/absent from base chain/u);
  });
  it.each(["replaced", "created"])("refuses overlap with the %s list", list => {
    const value = setup(), slot = value.nativeStoreForwardClass!.slots[0]!;
    if (list === "created") slot.createdFunctions.push({ signature, searchPath: "pg_catalog" });
    else slot.replacedFunctions.push({ signature, beforeSha256: sqlSha256(sqlStatements(before.toString()).find(s => s.startsWith("CREATE FUNCTION public.fixture_grant("))!), searchPath: "pg_catalog" });
    expect(() => readReviewedForwardRegistry(encode(value))).toThrow(/disjoint/u);
  });
  it("refuses redefining a grant-only function even with a freshly repinned file", () => {
    const text = "CREATE OR REPLACE FUNCTION public.fixture_grant(p_values text[]) RETURNS text LANGUAGE sql AS $$ SELECT ''; $$;";
    expect(() => run(setup(), text)).toThrow(/unlisted signature/u);
  });
  it("does not treat a function created by an earlier slot as a base-chain grant target", () => {
    const value = registry(), first = sql(), firstPin = bind(value, 0, first), slot = value.nativeStoreForwardClass!.slots[1]!;
    slot.grantOnlyFunctions.push({ signature: created, grantTo: ["service_role"], revokeFrom: [] });
    const text = `${sql(1)}\n${block("service_role", "GRANT EXECUTE", created)}`, pin = bind(value, 1, text);
    expect(() => assertNativeStoreForward(value, pin.path, Buffer.from(text), [{ path: PLATFORM_BASELINE_FILE, bytes: before }, { path: firstPin.path, bytes: Buffer.from(first) }])).toThrow(/absent from base chain/u);
  });
  it("permits a grant-only block before created functions' PUBLIC revoke, but refuses a mixed block", () => {
    const value = registry(), slot = value.nativeStoreForwardClass!.slots[0]!;
    slot.grantOnlyFunctions.push({ signature, grantTo: ["service_role"], revokeFrom: [] });
    const text = `${block("service_role", "GRANT EXECUTE", signature)}\n${sql()}`;
    expect(() => run(value, text)).not.toThrow();
    const mixed = sql().replace(revoke, () => `${block("service_role", "GRANT EXECUTE", `${signature},${created}`)}\n${revoke}`);
    expect(() => run(registryWithGrantOnly(), mixed)).toThrow(/PUBLIC revoke/u);
    function registryWithGrantOnly() { const next = registry(); next.nativeStoreForwardClass!.slots[0]!.grantOnlyFunctions = structuredClone(slot.grantOnlyFunctions); return next; }
  });
});

describe("grant-only PUBLIC revoke", () => {
  const path = "db/platform/migrations/20990101000000_revoke_public_fixture.sql";
  const signatures = ["public.fixture_narrow(text)", "public.fixture_narrow(integer)"] as const;
  const [explicit, implicit] = signatures;
  const definition = (signature: string, security = "") =>
    `CREATE FUNCTION ${signature.replace("(text)", "(p text DEFAULT 'original')")} RETURNS text LANGUAGE sql${security ? ` ${security}` : ""} AS $$ SELECT 'SECURITY DEFINER'; $$;`;
  const baseline = [definition(explicit!, "SECURITY INVOKER"), definition(implicit!)].join("\n");
  const [first, second] = signatures.map(signature => `REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC;`);
  const grant = block("service_role", "GRANT EXECUTE", signatures.join(", "));
  const sql = (...statements: string[]) => statements.join("\n");
  const positive = sql(first!, second!, grant);

  function fixture(text = positive, prefix = baseline, targets: readonly string[] = signatures) {
    const value = registry(), slot = emptySlot(path, "PublicRevoke");
    slot.grantOnlyFunctions = targets.map(signature => ({ signature, revokePublic: true, grantTo: ["service_role"], revokeFrom: [] }));
    value.nativeStoreForwardClass!.slots = [slot];
    value.baselineSha256 = sqlSha256(prefix);
    const bytes = Buffer.from(text);
    value.nativeStoreForwards = [{ path, sha256: sqlSha256(bytes), functions: [] }];
    const pin = value.nativeStoreForwards[0]!;
    const preceding = [{ path: PLATFORM_BASELINE_FILE, bytes: Buffer.from(prefix) }];
    return { value, slot, pin, preceding, admit: () => assertNativeStoreForward(readReviewedForwardRegistry(encode(value)), path, bytes, preceding) };
  }

  const messages = {
    placement: "native_store_revoke_public_placement: The flag is outside grantOnlyFunctions. Remove it from that field.",
    slot: "native_store_revoke_public_slot: The slot is outside the closed ACL-only shape. Use the documented revokePublic entry and companions.",
    base: "native_store_revoke_public_base: The target is absent from the pre-class chain. Use an existing base-chain function.",
    target: "native_store_revoke_public_target: An ACL statement names an unlisted function. Use one PUBLIC revoke per registered signature in registry order, then grant to the complete ordered list in the guarded block.",
    missing: "native_store_revoke_public_missing: A listed target lacks its direct PUBLIC revoke. Add it before the guarded grant.",
    order: "native_store_revoke_public_order: The ACL statements are out of order. Put the PUBLIC revokes in registry order before the guarded grant.",
    grant: "native_store_revoke_public_grant: The slot requires one guarded service_role EXECUTE grant. Use the documented block without grant option.",
    aclOnly: "native_store_revoke_public_acl_only: The slot contains a change outside its ACL statements. Move that change to a separate reviewed forward.",
    ordinary: "reviewed native store grant-only privilege must use its closed conditional role/verb",
  };
  function refuses(admit: () => unknown, expected: string) {
    let error: unknown;
    try { admit(); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect(Object.getPrototypeOf(error)).toBe(Error.prototype);
    expect(Reflect.ownKeys(error as Error).filter(key => key !== "stack")).toEqual(["message"]);
    expect((error as Error).message).toBe(expected);
  }

  it("admits two base invokers, explicit and implicit", () => {
    expect(() => fixture().admit()).not.toThrow();
  });
  it.each(["public.to(text)", "public.from(text)"])("admits a listed keyword-named target %s", signature => {
    const text = positive.replaceAll(explicit!, signature);
    const prefix = sql(definition(signature, "SECURITY INVOKER"), definition(implicit!));
    expect(fixture(text, prefix, [signature, implicit!]).admit).not.toThrow();
  });
  it("refuses an unlisted keyword-named guarded target", () => {
    const signature = "public.to(text)";
    const text = sql(first!, second!, grant.replace(explicit!, signature));
    refuses(fixture(text, sql(baseline, definition(signature))).admit, messages.target);
  });
  it("admits the activation ACL slot against the issued native prefix", () => {
    const slot = emptySlot("db/platform/migrations/20990101000000_revoke_public_activation_prefix_fixture.sql", "ActivationAclFixture");
    const targets = [
      "public.subscription_activate_from_captured_payment(text,uuid,text)",
      "public.subscription_activation_commit(public.subscription_activations,text,text,timestamptz,boolean)",
    ];
    slot.grantOnlyFunctions = targets.map(signature => ({ signature, revokePublic: true, grantTo: ["service_role"], revokeFrom: [] }));
    const text = sql(...targets.map(signature => `REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC;`), block("service_role", "GRANT EXECUTE", targets.join(", ")));
    const value = structuredClone(production);
    const slots = value.nativeStoreForwardClass!.slots;
    slots.push(slot);
    bind(value, slots.length - 1, text);
    const manifest = readPlatformMigrationManifest(process.cwd()) as PlatformMigrationManifest;
    const preceding = [manifest.baseline, ...manifest.forward]
      .filter(unit => unit.file < slot.path)
      .map(unit => ({ path: unit.file, bytes: readFileSync(unit.file) }));
    expect(() => assertNativeStoreForward(readReviewedForwardRegistry(encode(value)), slot.path, Buffer.from(text), preceding)).not.toThrow();
  });

  it.each<[string, (candidate: ReturnType<typeof fixture>) => unknown]>([
    ["registry root", ({ value }) => Object.assign(value, { revokePublic: true })],
    ["slot field", ({ slot }) => Object.assign(slot, { revokePublic: true })],
    ["created entry", ({ slot }) => slot.createdFunctions.push(Object.assign({ signature: "public.fixture_other()", searchPath: null }, { revokePublic: true }))],
    ["replaced entry", ({ slot }) => slot.replacedFunctions.push(Object.assign({ signature: "public.fixture_other()", searchPath: null, beforeSha256: sqlSha256(baseline) }, { revokePublic: true }))],
    ["binding inventory", ({ pin }) => pin.functions.push(Object.assign({ signature: explicit!, beforeSha256: null, afterSha256: sqlSha256(baseline) }, { revokePublic: true }))],
  ])("refuses revokePublic in a %s", (_label, mutate) => {
    const candidate = fixture();
    mutate(candidate);
    refuses(candidate.admit, messages.placement);
  });
  it.each<[string, (candidate: ReturnType<typeof fixture>) => unknown]>([
    ["false flag", ({ slot }) => Object.assign(slot.grantOnlyFunctions[0]!, { revokePublic: false })],
    ["mixed flags", ({ slot }) => delete slot.grantOnlyFunctions[0]!.revokePublic],
    ["wrong grant role", ({ slot }) => { slot.grantOnlyFunctions[0]!.grantTo = ["authenticated"]; }],
    ["revoke role", ({ slot }) => slot.grantOnlyFunctions[0]!.revokeFrom.push("anon")],
    ["created companion", ({ slot }) => slot.createdFunctions.push({ signature: "public.fixture_other()", searchPath: null })],
    ["replaced companion", ({ slot }) => slot.replacedFunctions.push({ signature: "public.fixture_other()", searchPath: null, beforeSha256: sqlSha256(baseline) })],
    ["data companion", ({ slot }) => slot.dataStatements.push("SELECT 1;")],
    ["empty optional companion", ({ slot }) => { slot.existingTableStatements = []; }],
    ["nonempty binding functions", ({ pin }) => pin.functions.push({ signature: explicit!, beforeSha256: null, afterSha256: sqlSha256(baseline) })],
  ])("refuses an ACL-only slot with %s", (_label, mutate) => {
    const candidate = fixture();
    mutate(candidate);
    refuses(candidate.admit, messages.slot);
  });
  it("refuses a target created only in an earlier class slot", () => {
    const candidate = fixture(positive, definition(explicit!, "SECURITY INVOKER"));
    const earlier = emptySlot(control.slots[0]!.path, "EarlierFixture");
    const text = definition(implicit!);
    earlier.createdFunctions.push({ signature: implicit!, searchPath: null });
    candidate.value.nativeStoreForwardClass!.slots.unshift(earlier);
    bind(candidate.value, 0, text);
    candidate.value.nativeStoreForwards!.reverse();
    candidate.preceding.push({ path: earlier.path, bytes: Buffer.from(text) });
    refuses(candidate.admit, messages.base);
  });
  it("leaves SECURITY mode to the catalog even for a DEFINER definition", () => {
    expect(fixture(positive, baseline.replace("SECURITY INVOKER", "SECURITY DEFINER")).admit).not.toThrow();
  });
  it.each([
    ["direct routine ACL", `GRANT EXECUTE ON ROUTINE ${explicit} TO service_role;`],
    ["guarded ACL", block("anon", "REVOKE ALL", implicit)],
    ["schema-wide ACL", "REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA other, public FROM PUBLIC;"],
    ["dynamic ACL", `DO $$ BEGIN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', '${explicit}', 'anon'); END; $$;`],
  ])("leaves the preimage to the catalog after an earlier %s", (_label, statement) => {
    expect(fixture(positive, sql(baseline, statement)).admit).not.toThrow();
  });

  it.each([
    ["an unlisted revoke target", positive.replace(explicit!, "public.fixture_other(text)"), messages.target],
    ["an unlisted guarded target", sql(first!, second!, grant.replace(implicit!, "public.fixture_other(integer)")), messages.target],
    ["a revoke targeting a different overload", positive.replace(explicit!, "public.fixture_narrow(date)"), messages.target],
    ["a guarded grant targeting an unlisted quoted type", sql(first!, second!, grant.replace(implicit!, 'public.fixture_narrow("int8")')), messages.target],
    ["the first PUBLIC revoke missing", sql(second!, grant), messages.missing],
    ["the second PUBLIC revoke missing", sql(first!, grant), messages.missing],
    ["swapped PUBLIC revokes", sql(second!, first!, grant), messages.order],
    ["the guarded grant before the last revoke", sql(first!, grant, second!), messages.order],
    ["incomplete guarded targets", sql(first!, second!, block("service_role", "GRANT EXECUTE", explicit)), messages.grant],
    ["reordered guarded targets", sql(first!, second!, block("service_role", "GRANT EXECUTE", [implicit, explicit].join(", "))), messages.grant],
    ["duplicate guarded targets", sql(first!, second!, block("service_role", "GRANT EXECUTE", [...signatures, explicit].join(", "))), messages.grant],
    ["wrong grantee", positive.replace("TO service_role", "TO authenticated"), messages.grant],
    ["grant option", positive.replace("TO service_role;", "TO service_role WITH GRANT OPTION;"), messages.grant],
    ["REVOKE EXECUTE payload", sql(first!, second!, block("service_role", "REVOKE EXECUTE", signatures.join(", "))), messages.grant],
    ["missing guarded block", sql(first!, second!), messages.grant],
    ["malformed guarded block", positive.replace("IF EXISTS", "IF NOT EXISTS"), messages.grant],
    ["an extra guarded block", sql(positive, grant), messages.aclOnly],
    ["extra SQL", sql(positive, "SELECT 1;"), messages.aclOnly],
    ["a trailing unterminated statement", sql(positive, "SELECT 1"), messages.aclOnly],
  ])("refuses SQL with %s", (_label, text, message) => {
    refuses(fixture(text).admit, message);
  });
  it("retains the incumbent refusal for a direct unflagged PUBLIC revoke", () => {
    const candidate = fixture();
    candidate.slot.grantOnlyFunctions.forEach(fn => delete fn.revokePublic);
    refuses(candidate.admit, messages.ordinary);
  });
});

describe("qualified catalogue storage SELECT", () => {
  const sql = `DO $$ BEGIN
${roleGuard}${ledgerGuard}  THEN
    EXECUTE 'GRANT SELECT (net_content_storage) ON TABLE public.catalog_sku_revisions TO openlup_catalog_publication;';
  END IF;
END; $$;`;
  function admit(text: string, declared = true) {
    const value = registry();
    const path = "db/platform/migrations/20990101000000_catalogue_storage.sql";
    value.nativeStoreForwardClass!.slots = [{ row: "catalogue-storage", path, replacedFunctions: [],
      createdFunctions: [], grantOnlyFunctions: [], dataStatements: [], ...(declared ? { qualifiedCatalogueStorageSelect: true } : {}) }];
    bind(value, 0, text);
    return assertNativeStoreForward(value, path, Buffer.from(text), [{ path: PLATFORM_BASELINE_FILE, bytes: before }]);
  }
  it("admits exactly the guarded column SELECT", () => expect(() => admit(sql)).not.toThrow());
  it.each([
    ["without a slot", sql, false],
    ["without the guard", sql.replace(ledgerGuard, "")],
    ["with a wrong hash", sql.replace(authoritySha256, "0".repeat(64))],
    ["with a role substitution", sql.replaceAll(catalogueReadRole, "service_role")],
    ["with table-wide SELECT", sql.replace(" (net_content_storage)", "")],
    ["with an extra column", sql.replace("net_content_storage", "net_content_storage, digest")],
    ["with a write privilege", sql.replace("GRANT SELECT", "GRANT UPDATE")],
    ["with grant option", sql.replace("TO openlup_catalog_publication;", "TO openlup_catalog_publication WITH GRANT OPTION;")],
    ["with a duplicate", `${sql}
${sql}`],
    ["with no grant", ""],
  ] as const)("refuses storage SELECT %s", (_label, text, declared) => {
    expect(() => admit(text, declared)).toThrow(/reviewed native store/u);
  });
});

describe("qualified price list basis SELECT", () => {
  const grant = "GRANT SELECT (amount_basis) ON TABLE public.price_lists TO openlup_catalog_publication;";
  const guarded = `DO $$ BEGIN
${roleGuard}${ledgerGuard}  THEN
    EXECUTE '${grant}';
  END IF;
END; $$;
`;
  const addColumn = "ALTER TABLE public.price_lists ADD COLUMN amount_basis text;";
  const addCheck = "ALTER TABLE public.price_lists ADD CONSTRAINT price_lists_basis_check CHECK (amount_basis IN ('tax_inclusive', 'tax_exclusive'));";
  const grantSlot: NativeStoreSlot = {
    row: "price-list-basis-read", path: "db/platform/migrations/20990103000000_price_list_basis_read.sql",
    replacedFunctions: [], createdFunctions: [], grantOnlyFunctions: [], dataStatements: [],
    qualifiedPriceListBasisSelect: true,
  };
  const columnSlot: NativeStoreSlot = {
    row: "price-list-basis-column", path: "db/platform/migrations/20990101000000_price_list_basis_column.sql",
    replacedFunctions: [], createdFunctions: [], grantOnlyFunctions: [], dataStatements: [],
  };
  const baseline = { path: PLATFORM_BASELINE_FILE, bytes: Buffer.concat([before, Buffer.from("\nCREATE TABLE public.price_lists (id uuid);\n")]) };
  const exactGrant = "qualified price list basis SELECT forward must contain only the exact guarded grant with final LF";
  function setup(text = guarded, existingTableStatements = [addColumn, addCheck], additionalPredecessorSql: string[] = []) {
    const value = registry();
    const slot = { ...grantSlot };
    const column = { ...columnSlot, existingTableStatements };
    value.nativeStoreForwardClass!.slots = [column, slot];
    const sql = [...existingTableStatements, ...additionalPredecessorSql].join("\n") + "\n";
    const pin = bind(value, 0, sql);
    bind(value, 1, text);
    const preceding = [baseline, { path: column.path, bytes: Buffer.from(sql) }];
    return { value, slot, pin, preceding, admit: () => assertNativeStoreForward(value, slot.path, Buffer.from(text), preceding) };
  }

  it.each([
    ["with a CHECK", [addColumn, addCheck]],
    ["without a CHECK", [addColumn]],
    ["with the column and CHECK in one ALTER", [`${addColumn.slice(0, -1)}, ${addCheck.replace("ALTER TABLE public.price_lists ", "")}`]],
  ])("admits the exact grant after the pinned column %s", (_label, statements) => {
    const { admit, pin } = setup(guarded, statements);
    expect(admit().priceListBasisPredecessor).toEqual(pin);
  });
  it("refuses the grant when its slot lacks the flag", () => {
    const { slot, admit } = setup();
    delete slot.qualifiedPriceListBasisSelect;
    expect(admit).toThrow("refuses DO outside the single constant role privilege shape");
  });
  it("refuses a grant slot that declares column DDL", () => {
    const { slot, admit } = setup();
    slot.existingTableStatements = [addColumn];
    expect(admit).toThrow("qualified price list basis SELECT slot must be grant-only");
  });
  it("refuses a grant slot that declares a function definition", () => {
    const { slot, admit } = setup();
    slot.createdFunctions = [{ signature: "public.fixture_basis()", searchPath: null }];
    expect(admit).toThrow("qualified price list basis SELECT slot must be grant-only");
  });
  it("refuses a grant slot that declares DML", () => {
    const { slot, admit } = setup();
    slot.dataStatements = ["UPDATE public.price_lists SET amount_basis = 'tax_exclusive';"];
    expect(admit).toThrow("qualified price list basis SELECT slot must be grant-only");
  });
  it("refuses two flagged slots in the registry", () => {
    const { value, admit } = setup();
    value.nativeStoreForwardClass!.slots.push({ ...grantSlot, row: "price-list-basis-again", path: "db/platform/migrations/20990104000000_price_list_basis_again.sql" });
    expect(admit).toThrow("allows one qualifiedPriceListBasisSelect slot");
  });
  it.each([
    ["a missing grant", ""],
    ["the ADD COLUMN in the same file", `${addColumn}\n${guarded}`],
    ["a second grant", guarded + guarded],
    ["a missing final LF", guarded.trimEnd()],
    ["an extra final LF", guarded + "\n"],
    ["an unguarded grant", grant],
    ["an altered ledger guard", guarded.replace(authoritySha256, "0".repeat(64))],
    ["an altered role guard", guarded.replace("IF EXISTS", "IF NOT EXISTS")],
    ["a table-level SELECT", guarded.replace(" (amount_basis)", "")],
    ["another column", guarded.replace("amount_basis", "id")],
    ["another table", guarded.replace("public.price_lists", "public.catalog_sku_revisions")],
    ["another role", guarded.replaceAll(catalogueReadRole, "service_role")],
    ["WITH GRANT OPTION", guarded.replace("TO openlup_catalog_publication;", "TO openlup_catalog_publication WITH GRANT OPTION;")],
    ["INSERT privilege", guarded.replace("GRANT SELECT", "GRANT INSERT")],
    ["UPDATE privilege", guarded.replace("GRANT SELECT", "GRANT UPDATE")],
  ])("refuses a grant-only file with %s", (_label, text) => {
    expect(setup(text).admit).toThrow(exactGrant);
  });
  it("refuses the grant without a predecessor slot", () => {
    const { value, preceding, admit } = setup();
    value.nativeStoreForwardClass!.slots.shift();
    value.nativeStoreForwards!.shift();
    preceding.pop();
    expect(admit).toThrow("requires an earlier slot introducing public.price_lists.amount_basis");
  });
  it("refuses an earlier column slot without a binding", () => {
    const { value, admit } = setup();
    value.nativeStoreForwards!.shift();
    expect(admit).toThrow("earlier slot is unbound, missing or drifted");
  });
  it("refuses a pinned predecessor missing from the SQL prefix", () => {
    const { preceding, admit } = setup();
    preceding.pop();
    expect(admit).toThrow("earlier slot is unbound, missing or drifted");
  });
  it("refuses drifted predecessor bytes with the original pin", () => {
    const { preceding, admit } = setup();
    preceding[1]!.bytes = Buffer.concat([preceding[1]!.bytes, Buffer.from("\n")]);
    expect(admit).toThrow("earlier slot is unbound, missing or drifted");
  });
  it("refuses a pinned column definition outside the existing-table inventory", () => {
    const { value, admit } = setup(guarded, [addColumn]);
    delete value.nativeStoreForwardClass!.slots[0]!.existingTableStatements;
    expect(admit).toThrow("predecessor definition drifted");
  });
  it.each([
    ["a different column type", [addColumn.replace("text", "integer")]],
    ["a column default", [addColumn.replace("text", "text DEFAULT 'tax_exclusive'")]],
    ["a non-null column", [addColumn.replace("text", "text NOT NULL")]],
    ["an altered CHECK", [addColumn, addCheck.replace("tax_exclusive", "other")]],
  ])("refuses a coherently repinned predecessor with %s", (_label, statements) => {
    expect(setup(guarded, statements).admit).toThrow("predecessor definition drifted");
  });
  describe("price list basis file scan", () => {
    const index = "CREATE UNIQUE INDEX price_lists_basis_idx ON public.price_lists (amount_basis);";
    const attach = "ADD CONSTRAINT price_lists_fixture_unique UNIQUE USING INDEX price_lists_fixture_idx";
    const predecessorRefusal = "Only the pinned column and its optional CHECK may reference price_lists in the predecessor file";
    it("refuses CREATE UNIQUE INDEX in the predecessor", () => {
      const { admit } = setup(guarded, [addColumn, addCheck], [index]);
      expect(admit).toThrow(predecessorRefusal);
    });
    it("refuses a separate ADD CONSTRAINT UNIQUE USING INDEX in the predecessor", () => {
      const { admit } = setup(guarded, [addColumn, addCheck, `ALTER TABLE public.price_lists ${attach};`]);
      expect(admit).toThrow(predecessorRefusal);
    });
    it("refuses UNIQUE USING INDEX combined with the pinned ADD COLUMN", () => {
      const { admit } = setup(guarded, [`${addColumn.slice(0, -1)}, ${attach};`, addCheck]);
      expect(admit).toThrow(predecessorRefusal);
    });
    it("refuses incomplete tokenization of an unrelated predecessor statement", () => {
      const update = `UPDATE public.fixture_metadata SET ";" = 'metadata';`;
      const { admit, value } = setup(guarded, [addColumn, addCheck], [update]);
      value.nativeStoreForwardClass!.slots[0]!.dataStatements = [update];
      expect(admit).toThrow("Cannot completely tokenize the price list basis predecessor file");
    });
    it.each([
      ["CREATE INDEX", "CREATE INDEX price_lists_basis_idx ON public.price_lists (amount_basis);"],
      ["quoted three-part CREATE UNIQUE INDEX", 'CREATE UNIQUE INDEX price_lists_basis_idx ON ONLY "postgres"."public"."price_lists" (amount_basis);'],
      ["Unicode-escaped CREATE INDEX", `CREATE INDEX price_lists_basis_idx ON U&"price_list!0073" UESCAPE '!' (amount_basis);`],
      ["ADD CONSTRAINT UNIQUE USING INDEX", `ALTER TABLE ONLY public.price_lists ${attach};`],
    ])("refuses later %s on price_lists", (_label, statement) => {
      const { admit, preceding } = setup();
      preceding.push({ path: "db/platform/migrations/20990102000000_index_price_list_basis.sql", bytes: Buffer.from(statement) });
      expect(admit).toThrow("predecessor definition drifted");
    });
  });

  const restrictiveCheck = "ADD CHECK (amount_basis = 'tax_exclusive');";
  it.each([
    ["a three-part target", `ALTER TABLE postgres.public.price_lists ${restrictiveCheck}`],
    ["a quoted target", `ALTER TABLE "public"."price_lists" ${restrictiveCheck}`],
    ["a quoted three-part target", `ALTER TABLE "postgres"."public"."price_lists" ${restrictiveCheck}`],
    ["an unqualified target", `ALTER TABLE price_lists ${restrictiveCheck}`],
    ["a Unicode-escaped target", String.raw`ALTER TABLE public.U&"price_lis\0074s" ${restrictiveCheck}`],
    ["a target with a custom Unicode escape", `ALTER TABLE public.U&"price_list!0073" UESCAPE '!' ${restrictiveCheck}`],
    ["an IF EXISTS ONLY target", `ALTER TABLE IF EXISTS ONLY postgres.public.price_lists ${restrictiveCheck}`],
    ["unclassified DDL on the table", "ALTER TABLE public.PRICE_LISTS ADD COLUMN other text;"],
    ["DML with a different target", "UPDATE public.fixture_metadata SET relation_name = 'price_lists';"],
    ["the column type", "ALTER TABLE ONLY public.price_lists ALTER COLUMN amount_basis TYPE integer;"],
    ["the CHECK", "ALTER TABLE public.price_lists DROP CONSTRAINT price_lists_basis_check;"],
    ["the relation", "ALTER TABLE public.price_lists RENAME TO old_price_lists;"],
  ])("refuses an intervening change to %s", (_label, text) => {
    const { preceding, admit } = setup();
    preceding.push({ path: "db/platform/migrations/20990102000000_changed_basis.sql", bytes: Buffer.from(text) });
    expect(admit).toThrow("predecessor definition drifted");
  });
  it("refuses incomplete tokenization anywhere in an intervening mentioning file", () => {
    const { preceding, admit } = setup();
    const text = `UPDATE public.price_lists SET amount_basis = 'tax_inclusive';
COMMENT ON COLUMN public.unrelated.";" IS 'metadata';`;
    preceding.push({ path: "db/platform/migrations/20990102000000_incomplete_scan.sql", bytes: Buffer.from(text) });
    expect(admit).toThrow("Cannot completely tokenize an intervening file");
  });
  it.each([
    ["DML only", "UPDATE public.price_lists SET amount_basis = 'tax_inclusive' WHERE id IS NOT NULL;"],
    ["INSERT rows", "INSERT INTO public.price_lists (amount_basis) VALUES ('tax_exclusive');"],
    ["DELETE rows", "DELETE FROM ONLY public.price_lists WHERE id IS NOT NULL;"],
    ["three-part UPDATE rows", 'UPDATE "postgres"."public"."price_lists" SET amount_basis = NULL;'],
    ["privilege changes", "GRANT SELECT ON TABLE public.price_lists TO service_role; REVOKE SELECT ON TABLE public.price_lists FROM service_role;"],
    ["a comment", "COMMENT ON COLUMN public.price_lists.amount_basis IS 'List basis';"],
  ])("admits an intervening file with %s", (_label, text) => {
    const { preceding, admit, pin } = setup();
    preceding.push({ path: "db/platform/migrations/20990102000000_price_list_metadata_or_data.sql", bytes: Buffer.from(text) });
    expect(admit().priceListBasisPredecessor).toEqual(pin);
  });
  it("refuses each guarded column grant under the other flag", () => {
    const storageAsBasis = setup(`${qualifiedCatalogueStorageSelectSql}\n`);
    expect(storageAsBasis.admit).toThrow(exactGrant);

    const basisAsStorage = setup();
    delete basisAsStorage.slot.qualifiedPriceListBasisSelect;
    basisAsStorage.slot.qualifiedCatalogueStorageSelect = true;
    expect(basisAsStorage.admit).toThrow("refuses DO outside the single constant role privilege shape");
  });
});

const profileIdentityGrantRow = "catalog-publication-subscription-profile-identity-execute";
describe.each([
  ["price setup", "grant", ["public.catalog_price_setup_apply_v2(text,text,uuid)", "public.catalog_publication_lock_effective_base_price_v2(uuid,uuid,uuid)"]],
  ["profile identity", profileIdentityGrantRow, ["public.catalog_publication_subscription_profile_identity(text,integer,text)"]],
] as const)("qualified %s EXECUTE", (_label, row, signatures) => {
  const first = signatures[0], last = signatures.at(-1)!;
  const name = first.slice("public.".length, first.indexOf("("));
  const create = (signature: string) => `CREATE FUNCTION ${signature} RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ SELECT 'pinned'; $$;`;
  const grantStatement = `GRANT EXECUTE ON FUNCTION ${signatures.join(",\n      ")} TO openlup_catalog_publication;`;
  const grantLine = `    EXECUTE '${grantStatement}';\n`;
  const guarded = `DO $$ BEGIN
${roleGuard}${ledgerGuard}  THEN
${grantLine}  END IF;
END; $$;
`;
  const exactGrant = "qualified price setup EXECUTE forward must contain only the exact guarded grant with final LF";
  const drift = "qualified price setup EXECUTE predecessor definition drifted";
  const noDo = "refuses DO outside the single constant role privilege shape";
  const interveningPath = `db/platform/migrations/2099010${signatures.length}100000_guarded_execute_intervening.sql`;

  function setup(text = guarded) {
    const value = registry();
    const slots: NativeStoreSlot[] = [...signatures.map((_, i) => `definition-${i}`), row].map((row, i) => ({ row,
      path: `db/platform/migrations/2099010${i + 1}000000_guarded_execute.sql`,
      replacedFunctions: [], createdFunctions: [], grantOnlyFunctions: [], dataStatements: [],
    }));
    value.nativeStoreForwardClass!.slots = slots;
    const grant = slots.at(-1)!;
    grant.qualifiedPriceSetupExecute = true;
    const preceding = [{ path: PLATFORM_BASELINE_FILE, bytes: before }];
    const pins = signatures.map((signature, i) => {
      const predecessor = slots[i]!;
      predecessor.createdFunctions.push({ signature, searchPath: "pg_catalog, pg_temp" });
      const sql = `${create(signature)}\nREVOKE ALL ON FUNCTION ${signature} FROM PUBLIC;\n`;
      preceding.push({ path: predecessor.path, bytes: Buffer.from(sql) });
      return bind(value, i, sql);
    });
    bind(value, signatures.length, text);
    return { value, slots, grant, preceding, pins, admit: () => assertNativeStoreForward(value, grant.path, Buffer.from(text), preceding) };
  }

  it("admits the frozen file after its pinned CREATEs with a distinct grant entry", () => {
    const { admit, pins, slots, grant } = setup();
    slots.push({ ...grant, row: row === profileIdentityGrantRow ? "price-setup-execute" : profileIdentityGrantRow,
      path: "db/platform/migrations/20990104000000_other_execute.sql" });
    expect(admit().priceSetupPredecessors).toEqual(pins);
  });
  it("admits an intervening routine that only references a wrapper", () => {
    const { preceding, admit, pins } = setup();
    const sql = `CREATE FUNCTION public.fixture_caller() RETURNS text LANGUAGE sql AS $$ SELECT public.${name}(NULL,NULL,NULL); $$;`;
    preceding.push({ path: interveningPath, bytes: Buffer.from(sql) });
    expect(admit().priceSetupPredecessors).toEqual(pins);
  });
  it("refuses a missing flag", () => {
    const { grant, admit, pins } = setup();
    delete grant.qualifiedPriceSetupExecute;
    expect(admit).toThrow(noDo);
    grant.qualifiedPriceSetupExecute = true;
    expect(admit().priceSetupPredecessors).toEqual(pins);
  });
  it("refuses a pin without its grant slot", () => {
    const { slots, admit } = setup();
    slots.pop();
    expect(admit).toThrow("requires feature bindings within its slots");
  });
  it("refuses two flagged slots for the same entry", () => {
    const { slots, grant, admit } = setup();
    slots.push({ ...grant, row: row === profileIdentityGrantRow ? row : "second-grant", path: "db/platform/migrations/20990104000000_grant_again.sql" });
    expect(admit).toThrow("allows one qualifiedPriceSetupExecute slot");
  });
  it("refuses the frozen bytes under the other grant entry", () => {
    const { grant, admit } = setup();
    grant.row = row === profileIdentityGrantRow ? "price-setup-execute" : profileIdentityGrantRow;
    expect(admit).toThrow(exactGrant);
  });
  it.each([
    ["one changed byte", guarded.replace("THEN", "tHEN")],
    ["a missing final LF", guarded.slice(0, -1)],
    ["an extra final LF", `${guarded}\n`],
    ["an altered authority path", guarded.replace(authorityPath, PLATFORM_BASELINE_FILE)],
    ["an altered authority hash", guarded.replace(authoritySha256, "0".repeat(64))],
    ["the missing authority guard", guarded.replace(ledgerGuard, "")],
    ["an altered role guard", guarded.replace(roleGuard, roleGuard.replace("rolname=", "rolname<>"))],
    ...(row === profileIdentityGrantRow ? [
      ["the sole grant omitted", guarded.replace(grantLine, "")],
      ["the sole grant repeated in the same block", guarded.replace(grantLine, grantLine.repeat(2))],
      ["SELECT alongside EXECUTE", guarded.replace("GRANT EXECUTE", "GRANT EXECUTE, SELECT")],
      ["the intact grant outside the guard", `${guarded.replace(grantLine, "")}${grantStatement}\n`],
    ] as const : []),
    ...(signatures.length === 2 ? [
      ["only the apply signature", guarded.replace(`,\n      ${last}`, "")],
      ["only the lock signature", guarded.replace(`${first},\n      `, "")],
      ["reordered signatures", guarded.replace(`${first},\n      ${last}`, `${last},\n      ${first}`)],
    ] as const : []),
    ["an extra signature", guarded.replace(last, `${last}, public.fixture_third()`)],
    ["an overloaded signature", guarded.replace(first, `public.${name}(text,text)`)],
    ["a different target", guarded.replace(last, "public.fixture_price_setup_helper()")],
    ["another grantee", guarded.replace(`TO ${catalogueReadRole};`, "TO service_role;")],
    ["WITH GRANT OPTION", guarded.replace(`TO ${catalogueReadRole};`, `TO ${catalogueReadRole} WITH GRANT OPTION;`)],
    ["an extra statement", `${guarded}SELECT 1;\n`],
    ["co-located function creation", `${create(first)}\n${guarded}`],
    ["co-located data write", `${guarded}DELETE FROM public.fixture_unrelated;\n`],
    ["the #987 basis SELECT", guarded.replace(/GRANT EXECUTE ON FUNCTION [^;]+;/u, `GRANT SELECT (amount_basis) ON TABLE public.price_lists TO ${catalogueReadRole};`)],
    ["the #984 storage SELECT", `${qualifiedCatalogueStorageSelectSql}\n`],
  ])("refuses frozen EXECUTE with %s", (_label, text) => {
    expect(setup(text).admit).toThrow(exactGrant);
  });
  it("refuses a flagged slot that declares a function creation", () => {
    const { grant, admit } = setup();
    grant.createdFunctions.push({ signature: first, searchPath: "pg_catalog, pg_temp" });
    expect(admit).toThrow("qualified price setup EXECUTE slot must be grant-only");
  });
  it("refuses an absent predecessor file", () => {
    const { preceding, admit } = setup();
    preceding.splice(1, 1);
    expect(admit).toThrow("requires every earlier slot landed first");
  });
  it("refuses a definition not declared in an earlier native slot", () => {
    const { slots, value, admit } = setup();
    slots.splice(signatures.length - 1, 1);
    value.nativeStoreForwards!.splice(signatures.length - 1, 1);
    expect(admit).toThrow(`requires an earlier native slot creating ${last}`);
  });
  if (row === profileIdentityGrantRow) {
    it("refuses the pinned CREATE in a native slot after the grant", () => {
      const { slots, value, preceding, admit } = setup();
      const definition = slots.shift()!;
      const pin = value.nativeStoreForwards!.shift()!;
      definition.path = pin.path = "db/platform/migrations/20990104000000_guarded_execute_definition.sql";
      slots.push(definition);
      value.nativeStoreForwards!.push(pin);
      preceding.pop();
      expect(admit).toThrow(`requires an earlier native slot creating ${first}`);
    });
    it("refuses a native prefix out of filename order", () => {
      const { preceding, admit } = setup();
      preceding.push({ path: "db/platform/migrations/20981231100000_fixture.sql", bytes: Buffer.from("SELECT 1;\n") });
      expect(admit).toThrow("requires an ordered same-rail prefix and baseline");
    });
  }
  it("refuses a predecessor file whose bytes drift from its pin", () => {
    const { preceding, admit } = setup();
    preceding[1]!.bytes = Buffer.concat([preceding[1]!.bytes, Buffer.from("\n")]);
    expect(admit).toThrow("requires every earlier slot landed first");
  });
  it("refuses a predecessor CREATE whose effective after-hash differs", () => {
    const { pins, admit } = setup();
    pins[0]!.functions[0]!.afterSha256 = "0".repeat(64);
    expect(admit).toThrow(drift);
  });
  it("refuses an issued predecessor without the PUBLIC revoke", () => {
    const { value, preceding, admit } = setup();
    const sql = `${create(first)}\n`;
    preceding[1]!.bytes = Buffer.from(sql);
    bind(value, 0, sql);
    expect(admit).toThrow("created function missing PUBLIC revoke");
  });
  it.each([
    ["replace the first target", create(first).replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION")],
    ...(first === last ? [] : [["replace the second target", create(last).replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION")] as const]),
    ["a DROP ROUTINE list that includes the target", `DROP ROUTINE public.fixture_unrelated(), ${last};`],
    ["a quoted ALTER FUNCTION of the target", `ALTER FUNCTION ${first.replace(name, `"${name}"`)} SECURITY INVOKER;`],
    ["a Unicode-escaped target identifier", `ALTER FUNCTION ${first.replace(name, `U&"${name.replace("a", "!0061")}" UESCAPE '!'`)} SECURITY INVOKER;`],
    ["a rename of the wrapper schema", "ALTER SCHEMA public RENAME TO old_public;"],
  ])("refuses intervening DDL for %s", (_label, sql) => {
    const { preceding, admit } = setup();
    preceding.push({ path: interveningPath, bytes: Buffer.from(sql) });
    expect(admit).toThrow(drift);
  });
  const incomplete = 'COMMENT ON COLUMN public.fixture_unrelated.";" IS \'metadata\';';
  it("refuses incomplete tokenization elsewhere in a predecessor", () => {
    const { value, preceding, admit } = setup();
    const sql = `${preceding[1]!.bytes.toString("utf8")}${incomplete}\n`;
    preceding[1]!.bytes = Buffer.from(sql);
    bind(value, 0, sql);
    expect(admit).toThrow("Cannot completely tokenize the preceding file");
  });
  it("refuses incomplete tokenization in an intervening file", () => {
    const { preceding, admit } = setup();
    preceding.push({ path: interveningPath, bytes: Buffer.from(incomplete) });
    expect(admit).toThrow("Cannot completely tokenize the preceding file");
  });
  it.each([
    ["qualifiedPriceListBasisSelect", exactGrant.replace("price setup EXECUTE", "price list basis SELECT")],
    ["qualifiedCatalogueStorageSelect", noDo],
  ] as const)("refuses EXECUTE under the %s column flag", (flag, expected) => {
    const { grant, admit, pins } = setup();
    delete grant.qualifiedPriceSetupExecute;
    grant[flag] = true;
    expect(admit).toThrow(expected);
    delete grant[flag];
    grant.qualifiedPriceSetupExecute = true;
    expect(admit().priceSetupPredecessors).toEqual(pins);
  });
});

describe("the sole conditional role rule", () => {
  it.each([
    ["old function lookup", "    AND pg_catalog.to_regprocedure('public.catalog_publication_bind_live_write()') IS NOT NULL\n"],
    ["any ledger row", "    AND EXISTS (SELECT 1 FROM ONLY public.platform_schema_migrations)\n"],
    ["path without digest", `    AND EXISTS (SELECT 1 FROM ONLY public.platform_schema_migrations WHERE catalog_path OPERATOR(pg_catalog.=) '${authorityPath}'::pg_catalog.text)\n`],
    ["digest without path", `    AND EXISTS (SELECT 1 FROM ONLY public.platform_schema_migrations WHERE sha256 OPERATOR(pg_catalog.=) '${authoritySha256}'::pg_catalog.text)\n`],
    ["wrong path", ledgerGuard.replace(authorityPath, PLATFORM_BASELINE_FILE)],
    ["wrong digest", ledgerGuard.replace(authoritySha256, "0".repeat(64))],
  ])("refuses a qualified catalogue read grant with %s in place of the exact authority ledger check", (_label, guard) => {
    const { value, preceding } = catalogueReadFixture();
    expect(() => checkCatalogueRead(value, preceding, catalogueReadSql.replace(ledgerGuard, guard))).toThrow(catalogueReadGuardRefusal);
  });
  it.each([
    ["unguarded grant", `GRANT EXECUTE ON FUNCTION ${catalogueReadTargets.join(", ")} TO ${catalogueReadRole};\n`],
    ["altered guard", catalogueReadSql.replace("AND EXISTS", "AND NOT EXISTS")],
    ["role-only guard", catalogueReadSql.replace(ledgerGuard, "")],
    ["ledger-only guard", catalogueReadSql.replace(roleGuard + ledgerGuard, ledgerGuard.replace("    AND ", "  IF "))],
    ["wrong grantee", catalogueReadSql.replace(" TO openlup_catalog_publication", " TO service_role")],
    ["wrong schema", catalogueReadSql.replace("FUNCTION public.", "FUNCTION private.")],
    ["wrong overload", catalogueReadSql.replace("text,jsonb,integer,text", "text,jsonb,bigint,text")],
    ["missing target", catalogueReadSql.replace(`${catalogueReadTargets[0]},\n      `, "")],
    ["extra target", catalogueReadSql.replace(" TO openlup_catalog_publication", ", public.fixture_extra() TO openlup_catalog_publication")],
    ["helper target", catalogueReadSql.replace(catalogueReadTargets[0]!, "public.catalog_publication_read_head()")],
    ["grant option", catalogueReadSql.replace(" TO openlup_catalog_publication;", " TO openlup_catalog_publication WITH GRANT OPTION;")],
    ["revoke", catalogueReadSql.replace("GRANT EXECUTE", "REVOKE EXECUTE").replace(" TO openlup_catalog_publication", " FROM openlup_catalog_publication")],
    ["extra SQL in the block", catalogueReadSql.replace("  END IF;", "    PERFORM 1;\n  END IF;")],
    ["extra SQL after the block", `${catalogueReadSql}CREATE TABLE public.fixture_extra (id uuid);\n`],
  ])("refuses a qualified catalogue read forward with %s", (_label, text) => {
    const { value, preceding } = catalogueReadFixture();
    expect(() => checkCatalogueRead(value, preceding, text)).toThrow(catalogueReadGuardRefusal);
  });
  it.each([["anon", "REVOKE ALL"], ["authenticated", "REVOKE ALL"], ["service_role", "REVOKE ALL"], ["authenticated", "GRANT EXECUTE"], ["service_role", "GRANT EXECUTE"]])("accepts %s %s", (role, verb) => {
    expect(() => check(`${sql()}\n${block(role, verb)}`)).not.toThrow();
  });
  it("accepts a function list and one block per role AND verb", () => {
    expect(() => check(`${sql()}\n${block("service_role", "REVOKE ALL", `public.fixture_existing(uuid), ${created}`)}\n${block("service_role", "GRANT EXECUTE")}`)).not.toThrow();
  });
  it("accepts a single constant without a trailing SQL semicolon", () => {
    expect(() => check(`${sql()}\n${block("service_role", "GRANT EXECUTE").replace(";';", "';")}`)).not.toThrow();
  });
  it("requires all created functions' PUBLIC revokes before a grant", () => {
    const value = registry(), slot = value.nativeStoreForwardClass!.slots[0]!;
    slot.replacedFunctions = []; slot.createdFunctions.unshift({ signature: "public.fixture_new(uuid)", searchPath: "pg_catalog" });
    const text = sql().replace("CREATE OR REPLACE FUNCTION public.fixture_existing(p_id uuid)", "CREATE FUNCTION public.fixture_new(p_id uuid)")
      .replace("REVOKE ALL ON FUNCTION public.fixture_existing(uuid) FROM PUBLIC;", "")
      + `\nGRANT EXECUTE ON FUNCTION ${created} TO authenticated;`;
    bind(value, 0, text);
    expect(() => assertNativeStoreForward(value, control.slots[0]!.path, Buffer.from(text), [{ path: PLATFORM_BASELINE_FILE, bytes: before }])).toThrow(/before every created-function grant/u);
  });
  it.each([
    ["extra statement", () => block("authenticated").replace("END IF;", "PERFORM 1; END IF;")],
    ["second branch", () => block("authenticated").replace("END IF;", "ELSE NULL; END IF;")],
    ["unlisted function", () => block("authenticated", "GRANT EXECUTE", "public.fixture_unlisted()")],
    ["unlisted role", () => block("fixture_role")],
    ["PUBLIC", () => block("PUBLIC")],
    ["non-constant EXECUTE", () => block("authenticated").replace("EXECUTE '", "EXECUTE format('").replace(";';", ";');")],
    ["concatenation", () => block("authenticated").replace(";';", ";' || '';" )],
    ["GRANT to anon", () => block("anon", "GRANT EXECUTE")],
    ["different guarded role", () => block("authenticated").replace("FROM authenticated", "FROM service_role")],
    ["case-changed role literal", () => block("authenticated").replace("rolname='authenticated'", "rolname='AUTHENTICATED'")],
    ["table privileges", () => block("authenticated").replace("ON FUNCTION", "ON TABLE")],
  ] as const)("refuses %s", (_label, badBlock) => { expect(() => check(`${sql()}\n${badBlock()}`)).toThrow(/reviewed native store/u); });
  it("refuses a block before PUBLIC revoke and duplicate role/verb blocks", () => {
    expect(() => check(sql().replace(revoke, () => `${block("authenticated")}\n${revoke}`))).toThrow(/before every created-function grant or conditional block/u);
    expect(() => check(`${sql()}\n${block("authenticated")}\n${block("authenticated")}`)).toThrow(/one conditional block/u);
  });
});

describe("same-file new-table narrowing", () => {
  const table = "public.fixture_new_table", other = "public.fixture_second_table";
  const create = `CREATE TABLE ${table} (id uuid);`;
  const tableBlock = (role: string, target = table) => block(role).replace(`ON FUNCTION ${created}`, `ON TABLE ${target}`);
  const run = (statement: string) => check(`${sql()}\n${create}\n${statement}`);
  it.each([
    `REVOKE ALL ON TABLE ${table} FROM PUBLIC;`,
    `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`,
    ...["anon", "authenticated", "service_role"].map(role => tableBlock(role)),
    tableBlock("service_role").replace(";';", "';"),
    `CREATE TABLE ${other} (id uuid);\n${tableBlock("service_role", `${table},${other}`)}`,
  ])("accepts narrowing on tables created in this file: %s", statement => {
    expect(() => run(statement)).not.toThrow();
    for (const part of sqlStatements(statement)) {
      if (!part.startsWith("CREATE TABLE")) expect(isExpandOnlyPlatformForward(part)).toBe(false);
    }
  });
  it("accepts function and table REVOKE blocks for the same role, but refuses duplicates within either kind", () => {
    expect(() => run(`${block("authenticated")}\n${tableBlock("authenticated")}`)).not.toThrow();
    expect(() => run(`${block("authenticated")}\n${block("authenticated")}`)).toThrow(/one conditional block/u);
    expect(() => run(`${tableBlock("authenticated")}\n${tableBlock("authenticated")}`)).toThrow(/one conditional block/u);
  });
  it.each([
    ["bare table GRANT", `GRANT SELECT ON TABLE ${table} TO authenticated;`],
    ["implicit TABLE grant", `GRANT SELECT ON ${table} TO authenticated;`],
    ["conditional table GRANT", tableBlock("service_role").replace("REVOKE ALL", "GRANT ALL").replace("FROM service_role", "TO service_role")],
    ["conditional table EXECUTE grant", tableBlock("service_role").replace("REVOKE ALL", "GRANT EXECUTE").replace("FROM service_role", "TO service_role")],
    ["bare table-list revoke", `CREATE TABLE ${other} (id uuid);\nREVOKE ALL ON TABLE ${table},${other} FROM PUBLIC;`],
    ["bare named-role revoke", `REVOKE ALL ON TABLE ${table} FROM authenticated;`],
    ["existing-table revoke", "REVOKE ALL ON TABLE public.fixture_row FROM PUBLIC;"],
    ["conditional existing-table revoke", tableBlock("service_role", "public.fixture_row")],
    ["existing-table RLS", "ALTER TABLE public.fixture_row ENABLE ROW LEVEL SECURITY;"],
    ["unqualified table revoke", "REVOKE ALL ON TABLE fixture_new_table FROM PUBLIC;"],
    ["conditional RLS", tableBlock("service_role").replace(`REVOKE ALL ON TABLE ${table} FROM service_role`, `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`)],
    ["non-constant table EXECUTE", tableBlock("authenticated").replace("EXECUTE '", "EXECUTE format('").replace(";';", ";');")],
    ["concatenated table EXECUTE", tableBlock("authenticated").replace(";';", ";' || '';" )],
    ["different guarded role", tableBlock("authenticated").replace("FROM authenticated", "FROM service_role")],
    ["PUBLIC conditional revoke", tableBlock("PUBLIC")],
    ["unlisted role", tableBlock("fixture_role")],
  ])("refuses %s", (_label, statement) => { expect(() => run(statement)).toThrow(/reviewed native store/u); });
  it.each([
    `REVOKE ALL ON TABLE ${table} FROM PUBLIC;`,
    `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`,
    tableBlock("service_role"),
  ])("requires an earlier unconditional qualified CREATE TABLE for %s", statement => {
    expect(() => check(`${sql()}\n${statement}\n${create}`)).toThrow(/same slot file/u);
    expect(() => check(`${sql()}\nCREATE TABLE IF NOT EXISTS ${table} (id uuid);\n${statement}`)).toThrow(/same slot file/u);
    expect(() => check(`${sql()}\nCREATE TABLE fixture_new_table (id uuid);\n${statement}`)).toThrow(/same slot file/u);
  });
  it.each([
    `REVOKE ALL ON TABLE ${table} FROM PUBLIC;`,
    `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`,
    tableBlock("service_role"),
  ])("refuses narrowing a table created by another slot: %s", statement => {
    const value = registry(), first = `${sql()}\n${create}`, firstPin = bind(value, 0, first);
    const text = `${sql(1)}\n${statement}`, pin = bind(value, 1, text);
    expect(() => assertNativeStoreForward(value, pin.path, Buffer.from(text), [{ path: PLATFORM_BASELINE_FILE, bytes: before }, { path: firstPin.path, bytes: Buffer.from(first) }])).toThrow(/same slot file/u);
  });
});

describe("real Git introduction, release and co-location", () => {
  it.each([{ eventName: "pull_request", fresh: false }, { eventName: "merge_group", fresh: false }, { eventName: "pull_request", fresh: true }])("refuses unbound expand-only SQL at native $eventName admission (new registry time: $fresh)", async ({ eventName, fresh }) => {
    mkdirSync(".context/scratch", { recursive: true });
    const folder = mkdtempSync(resolve(".context/scratch/native-store-queue-"));
    const git = (...args: string[]) => execFileSync("git", ["-C", folder, "-c", "user.name=Control Test", "-c", "user.email=control@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
    const put = (path: string, bytes: Buffer | string) => { mkdirSync(dirname(resolve(folder, path)), { recursive: true }); writeFileSync(resolve(folder, path), bytes); };
    const commit = () => { git("add", "."); git("commit", "-qm", "Synthetic queue witness"); return git("rev-parse", "HEAD"); };
    try {
      git("init", "-q", "-b", "main"); put("config/reviewed-platform-forwards.json", encode(registry())); const base = commit();
      git("update-ref", "refs/remotes/origin/main", base);
      const path = fresh ? "db/platform/migrations/20271106100000_fixture_new.sql" : control.slots[0]!.path;
      if (fresh) {
        const value = registry(); value.nativeStoreForwardClass!.slots.push({ row: "Future", path, replacedFunctions: [], createdFunctions: [], grantOnlyFunctions: [], dataStatements: [] });
        put("config/reviewed-platform-forwards.json", encode(value));
        expect(isNativeStoreMigrationPath(path)).toBe(true);
        expect(isNativeStoreMigrationPath(path, value.nativeStoreForwardClass!.slots)).toBe(true);
      }
      put(path, "CREATE TABLE public.fixture_unbound (id uuid);"); const head = commit();
      const candidate = await captureCommittedReviewCandidate(folder, base, head);
      let session = prepareCandidate(null, { ...candidate, intent: { risk: "behavior", criteria: "Synthetic closed native class refusal" }, authorSessionId: "fixture-author" }, 1000);
      for (const reviewer of ["fixture-reviewer-a", "fixture-reviewer-b"]) session = recordReport(session, { reviewer, cold: true, tree: candidate.tree, verdict: "PASS", findings: [], closes: [], documentation: "Synthetic queue fixture; exact class boundary." }, 1000);
      const receipt = receiptSummary(session, 12, 1000);
      const merged = git("commit-tree", candidate.tree, "-p", base, "-p", head, "-m", "Synthetic merge group");
      const ref = `refs/heads/gh-readonly-queue/main/pr-12-${base}`;
      const event = { number: 12, repository: { private: false }, action: "checks_requested", pull_request: { head: { sha: head } }, merge_group: { base_ref: "refs/heads/main", head_ref: ref, base_sha: base, head_sha: merged } };
      const env = { GITHUB_REPOSITORY: "openlup/openlup", GITHUB_EVENT_NAME: eventName, GITHUB_SHA: merged, GITHUB_REF: ref };
      const api = { get: async (path: string) => path.includes("/pulls/") ? { number: 12, state: "open", draft: false, base: { ref: "main" }, head: { sha: head } } : path.includes("/issues/") ? [{ id: 1, user: { login: "fixture-owner", type: "User" }, body: `${RECEIPT_MARKER}\n\`\`\`json\n${JSON.stringify(receipt)}\n\`\`\`` }] : path.includes("/collaborators/") ? { permission: "write" } : { object: { sha: base } } };
      const runGit = (cwd: string, ...args: string[]) => args.includes("fetch") ? Promise.resolve("") : reviewGit(cwd, ...args);
      await expect(waitNativeAdmission({ cwd: folder, event, env, api, runGit, now: () => 1000, deadlineMs: 1 })).rejects.toThrow(/feature binding/u);
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });
  it("names exactly the protected catalog test files in the documentation", () => {
    const named = readFileSync("docs/platform/DATA_AND_MIGRATIONS.md", "utf8").split("catalog test and these named files:")[1]?.split("Code those files run")[0] ?? "";
    expect([...named.matchAll(/`([^`]+)`/gu)].map(match => match[1]).sort()).toEqual([...NATIVE_CATALOG_CONTROLS, "tests/setup/"].sort());
  });
  it("names exactly the guard catalogs in the documentation", () => {
    const section = readFileSync("docs/platform/DATA_AND_MIGRATIONS.md", "utf8").split("- The guard catalogs")[1]?.split(/\n(?:- |\n)/u)[0] ?? "";
    expect([...new Set([...section.matchAll(/`(pg_[a-z_]+)`/gu)].map(match => match[1]))].sort()).toEqual([...NATIVE_STORE_GUARD_CATALOGS].sort());
  });
  // Measured 8.3 s alone and 12.1 s at load average 7 exceed Vitest's 5 s default.
  it("accepts class, slot, pins and SQL together while preserving machinery and issued immutability", () => {
    mkdirSync(".context/scratch", { recursive: true });
    const folder = mkdtempSync(resolve(".context/scratch/native-store-git-"));
    const git = (...args: string[]) => execFileSync("git", ["-C", folder, ...args], { encoding: "utf8" }).trim();
    const put = (path: string, bytes: string | Buffer) => { mkdirSync(dirname(resolve(folder, path)), { recursive: true }); writeFileSync(resolve(folder, path), bytes); };
    const commit = () => { git("add", "."); git("-c", "user.name=Control Test", "-c", "user.email=control@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "Synthetic control witness"); return git("rev-parse", "HEAD"); };
    const registryPath = "config/reviewed-platform-forwards.json", path = control.slots[0]!.path, text = sql();
    try {
      git("init", "--quiet"); const value = registry();
      put(PLATFORM_BASELINE_FILE, before); put(registryPath, encode(value)); const base = commit();
      bind(value, 0, text); put(path, text); put(registryPath, encode(value)); const feature = commit();
      expect(() => assertCoLocatedForwardApproval(folder, base, feature)).not.toThrow();
      expect(() => assertReviewedPlatformForward(folder, base, feature, path, Buffer.from(text), true)).not.toThrow();
      put("scripts/reviewed-platform-forward.ts", "// Changed control"); const mixed = commit();
      expect(() => assertCoLocatedForwardApproval(folder, base, mixed)).toThrow("reviewed replacement admission machinery must be approved separately before co-located SQL/pins");
      git("reset", "--hard", feature);
      // The real-PostgreSQL catalog test is the truth for function attributes: a feature PR cannot edit it, or the named
      // files that select, run and containerize it, unseen. Code those files run is a review duty, not a control.
      for (const control of [...NATIVE_CATALOG_CONTROLS, ".github/workflows/fixture.yml", "tests/setup/disposable-docker.ts"]) {
        put(control, "// Changed catalog test input"); const controlEdit = commit();
        expect(() => assertCoLocatedForwardApproval(folder, base, controlEdit), control).toThrow("reviewed replacement admission machinery must be approved separately before co-located SQL/pins");
        git("reset", "--hard", feature);
      }
      const changed = structuredClone(value); changed.nativeStoreForwardClass!.slots[0]!.replacedFunctions[0]!.searchPath = null;
      put(registryPath, encode(changed)); const enlarged = commit();
      expect(() => assertCoLocatedForwardApproval(folder, feature, enlarged)).toThrow("reviewed native store issued bindings and slots are immutable");
      git("reset", "--hard", feature);
      value.nativeStoreForwards![0]!.sha256 = sqlSha256(text + " "); put(registryPath, encode(value)); const repin = commit();
      expect(() => assertCoLocatedForwardApproval(folder, feature, repin)).toThrow(/immutable/u);
      git("reset", "--hard", base);
      const unknown = path.replace("fixture_1", "unknown"); const expand = "CREATE TABLE public.fixture_unknown (id uuid);";
      put(unknown, expand); const unbound = commit();
      expect(() => assertAdmittedPlatformForward(folder, base, unbound, unknown, Buffer.from(expand))).toThrow(/reviewed replacement path/u);
      expect(() => assertCoLocatedForwardApproval(folder, base, unbound)).toThrow(`reviewed native store requires an exact slot and feature binding: ${unknown}`);
      git("reset", "--hard", base);
      const noClass = registry(); delete noClass.nativeStoreForwardClass; delete noClass.nativeStoreForwards;
      put(registryPath, encode(noClass)); const older = commit();
      const initial = registry(); bind(initial, 0, text); put(registryPath, encode(initial)); put(path, text); const simultaneous = commit();
      const group = git("-c", "user.name=Control Test", "-c", "user.email=control@example.invalid", "commit-tree", git("rev-parse", `${simultaneous}^{tree}`), "-p", older, "-p", simultaneous, "-m", "Native same-change merge group");
      for (const head of [simultaneous, group]) expect(() => assertCoLocatedForwardApproval(folder, older, head)).not.toThrow();
      for (const release of [false, true]) expect(() => assertReviewedPlatformForward(folder, older, simultaneous, path, Buffer.from(text), release)).not.toThrow();
      // A same-change pin must still bind the actual SQL bytes.
      const wrong = structuredClone(initial); wrong.nativeStoreForwards![0]!.sha256 = "0".repeat(64);
      put(registryPath, encode(wrong)); const mismatch = commit();
      expect(() => assertCoLocatedForwardApproval(folder, older, mismatch)).toThrow(`non-expand-only forward differs from reviewed replacement path or bytes: ${path}`);
      // Release cannot authorize an issued introduction with a later pin repair.
      expect(() => assertReviewedPlatformForward(folder, older, mismatch, path, Buffer.from(text), true)).toThrow("reviewed replacement allowlist must be approved separately before a feature PR adds SQL");
      git("reset", "--hard", simultaneous);
      const sealed = structuredClone(initial); sealed.nativeStoreForwardClass!.sealed = true;
      put(registryPath, encode(sealed)); const sealing = commit();
      sealed.nativeStoreForwardClass!.slots.pop(); put(registryPath, encode(sealed)); const sealedEdit = commit();
      expect(() => assertCoLocatedForwardApproval(folder, sealing, sealedEdit)).toThrow("reviewed native store sealed slot prefix is immutable and cannot be unsealed");
    } finally { rmSync(folder, { recursive: true, force: true }); }
  }, 30_000);
  it("preserves earlier classes' release approval when the new class is added", () => {
    mkdirSync(".context/scratch", { recursive: true }); const folder = mkdtempSync(resolve(".context/scratch/native-store-history-"));
    const git = (...args: string[]) => execFileSync("git", ["-C", folder, ...args], { encoding: "utf8" }).trim();
    try {
      git("init", "--quiet"); mkdirSync(resolve(folder, "config"));
      const old = structuredClone(production); delete old.nativeStoreForwardClass; delete old.nativeStoreForwards;
      const commit = (value: ReviewedForwardRegistry) => { writeFileSync(resolve(folder, "config/reviewed-platform-forwards.json"), encode(value)); git("add", "."); git("-c", "user.name=Control Test", "-c", "user.email=control@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "Synthetic approval history"); return git("rev-parse", "HEAD"); };
      const base = commit(old), head = commit(production);
      expect(() => assertUnchangedForwardApproval(folder, base, head, old.replacementForwards[0]!.path)).not.toThrow();
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });
});

// Separate inert companions keep the production writer's bodies out of this control.
const g4g3 = JSON.parse(fixture("g4g3-statements.json").toString()) as {
  prefix: string;
  g4Statements: string[];
  refusals: { label: string; replace?: number; sql: string }[];
  listRefusals: { label: string; replace?: number; sql?: string; order?: number[] }[];
  writerDoTerminatorRefusal: string;
};
function checkG4G3(index: number, text: string) {
  const value = registry(), preceding = [{ path: PLATFORM_BASELINE_FILE, bytes: Buffer.concat([before, Buffer.from(`\n${g4g3.prefix}`)]) }];
  value.nativeStoreForwardClass!.slots[2]!.existingTableStatements = [...g4g3.g4Statements];
  if (index === 3) value.nativeStoreForwardClass!.slots[3]!.createdFunctions = structuredClone(production.nativeStoreForwardClass!.slots.find(slot => slot.row === "G3")!.createdFunctions);
  for (let earlier = 0; earlier < index; earlier++) {
    const source = earlier === 2 ? `${g4g3.g4Statements.join("\n")}\n${sql(earlier)}` : sql(earlier);
    const pin = bind(value, earlier, source);
    assertNativeStoreForward(value, pin.path, Buffer.from(source), preceding);
    preceding.push({ path: pin.path, bytes: Buffer.from(source) });
  }
  const pin = bind(value, index, text);
  assertNativeStoreForward(value, pin.path, Buffer.from(text), preceding);
}

describe("G4 exact existing-table companions and G3 inventory", () => {
  const g4 = () => `${g4g3.g4Statements.join("\n")}\n${sql(2)}`;
  const g3 = () => fixture("g3-shape.sql").toString();
  it("keeps the sealed issued slot and binding prefix in order, without whole-file class pins", () => {
    const slots = production.nativeStoreForwardClass!.slots.slice(0, 7);
    expect(slots.map(slot => slot.row)).toEqual(["G6", "G2", "G4", "G3", "G7", "G8", "G11-c"]);
    expect(production.nativeStoreForwardClass!.sealed).toBe(true);
    expect(production.nativeStoreForwards!.slice(0, 7).map(pin => pin.path)).toEqual(slots.slice(0, 7).map(slot => slot.path));
    expect(slots[2]!.existingTableStatements).toEqual(g4g3.g4Statements);
    expect(slots[3]!.dataStatements).toEqual(["INSERT INTO public.client_absorption_policy (table_name, disposition, note) VALUES ('commerce_destinations', 'block', 'A delivery destination is an immutable delivery snapshot bound to the order or subscription that used it; never carry or rebind it when absorbing a lead.');"]);
    expect(slots[2]!.createdFunctions).toEqual([
      { signature: "public.fulfillment_reserve_purchase_order_items(text,uuid,text,jsonb,text,timestamptz,jsonb,timestamptz)", searchPath: "pg_catalog, pg_temp" },
      { signature: "public.fulfillment_release_purchase_reservation(text,uuid,text,jsonb,timestamptz)", searchPath: "pg_catalog, pg_temp" },
      { signature: "public.fulfillment_expire_purchase_reservations(timestamptz,integer)", searchPath: "pg_catalog, pg_temp" },
      { signature: "public.commerce_cancel_abandoned_purchase_checkout(text,uuid,text,timestamptz)", searchPath: "pg_catalog, pg_temp" },
      { signature: "public.inventory_admission_try_enter()", searchPath: "pg_catalog, pg_temp" },
    ]);
    for (const index of [2, 3]) {
      expect(slots[index]!.replacedFunctions).toEqual([]);
      expect(slots[index]!.grantOnlyFunctions).toEqual([]);
      expect(slots[index]!.createdFunctions).toHaveLength(index === 2 ? 5 : 4);
      expect(slots[index]!.createdFunctions.every(fn => fn.searchPath === "pg_catalog, pg_temp")).toBe(true);
      expect(slots[index]).not.toHaveProperty("sha256");
    }
  });
  it("reads both registries: the production one with the pinned list and a seven-slot fixture one carrying it", () => {
    expect(() => readReviewedForwardRegistry(readFileSync("config/reviewed-platform-forwards.json"))).not.toThrow();
    const value = registry();
    expect(value.nativeStoreForwardClass!.slots).toHaveLength(7);
    value.nativeStoreForwardClass!.slots[2]!.existingTableStatements = [...g4g3.g4Statements];
    expect(readReviewedForwardRegistry(encode(value)).nativeStoreForwardClass!.slots[2]!.existingTableStatements).toEqual(g4g3.g4Statements);
  });
  it("accepts G4's exact three whole statements once in order, without generic admission", () => {
    expect(() => checkG4G3(2, g4())).not.toThrow();
    for (const statement of g4g3.g4Statements) expect(isExpandOnlyPlatformForward(statement)).toBe(false);
  });
  it("compares after the existing splitter only, preserving internal statement bytes", () => {
    const text = `${g4g3.g4Statements.map(statement => `\n-- leading fixture comment\n${statement}\n`).join("\n")}\n${sql(2)}`;
    expect(() => checkG4G3(2, text)).not.toThrow();
    expect(() => checkG4G3(2, g4().replace("  ALTER COLUMN", " ALTER COLUMN"))).toThrow(/existing-table statement/u);
  });
  it.each(g4g3.refusals)("refuses G4 $label even with fresh feature pins", attack => {
    const statements = [...g4g3.g4Statements];
    if (attack.replace === undefined) statements.push(attack.sql); else statements[attack.replace] = attack.sql;
    // The class splitter refuses non-ASCII structure before any companion is compared, so such a case never reaches the list check.
    const message = /\P{ASCII}/u.test(attack.sql) ? /non-ASCII outside strings/u : /existing-table statement/u;
    expect(() => checkG4G3(2, `${statements.join("\n")}\n${sql(2)}`)).toThrow(message);
  });
  it("refuses validate-before-add, a duplicate statement and a missing statement", () => {
    const [drop, add, validate] = g4g3.g4Statements;
    for (const statements of [[drop, validate, add], [drop, add, add, validate], [drop, add]]) {
      expect(() => checkG4G3(2, `${statements.join("\n")}\n${sql(2)}`)).toThrow(/existing-table statement/u);
    }
  });
  it.each(g4g3.g4Statements)("refuses a listed G4 statement in another slot: %s", statement => {
    expect(() => check(`${sql()}\n${statement}`)).toThrow(/closed shapes/u);
    expect(() => checkG4G3(3, `${g3()}\n${statement}`)).toThrow(/closed shapes/u);
  });
  it("admits a safe exact existing-table list on any unissued slot", () => {
    const value = registry(); value.nativeStoreForwardClass!.slots[0]!.existingTableStatements = [...g4g3.g4Statements];
    expect(() => readReviewedForwardRegistry(encode(value))).not.toThrow();
    value.nativeStoreForwardClass!.slots[0]!.existingTableStatements!.push(g4g3.g4Statements[0]!);
    expect(() => readReviewedForwardRegistry(encode(value))).toThrow(/unique exact texts/u);
  });
  it("allows unissued exact-statement inventory changes but preserves sealing", () => {
    const prior = registry(), next = registry();
    next.nativeStoreForwardClass!.slots[2]!.existingTableStatements = [...g4g3.g4Statements];
    expect(() => changedForwardApprovals(encode(prior), encode(next))).not.toThrow();
    prior.nativeStoreForwardClass!.sealed = true; next.nativeStoreForwardClass!.sealed = true;
    expect(() => changedForwardApprovals(encode(prior), encode(next))).toThrow(/sealed slot prefix/u);
  });
  it("preserves the inherited final END semicolon requirement for conditional DO", () => {
    expect(() => checkG4G3(2, `${g4()}\n${g4g3.writerDoTerminatorRefusal}`)).toThrow(/single constant role privilege shape/u);
  });
  it("accepts the synthetic G3-shaped tables, four headers, RLS and exact six ACL blocks", () => {
    expect(() => checkG4G3(3, g3())).not.toThrow();
    const slot = production.nativeStoreForwardClass!.slots.find(slot => slot.row === "G3")!;
    expect([...nativeStoreFunctionDefinitions(Buffer.from(g3()), slot.createdFunctions.map(fn => fn.signature)).keys()]).toEqual(slot.createdFunctions.map(fn => fn.signature));
    expect(sqlStatements(g3()).filter(statement => statement.startsWith("DO "))).toHaveLength(6);
  });
  it.each([2, 3])("refuses a function outside slot %s's closed list", index => {
    const text = `${index === 2 ? g4() : g3()}\nCREATE FUNCTION public.fixture_unlisted_destination(uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb; $$;`;
    expect(() => checkG4G3(index, text)).toThrow(/unlisted signature/u);
  });
  it.each([2, 3])("refuses wrong search_path on slot %s creations", index => {
    const text = (index === 2 ? g4() : g3()).replace("SET search_path = pg_catalog, pg_temp", "SET search_path = public");
    expect(() => checkG4G3(index, text)).toThrow(/unpinned SECURITY DEFINER or search_path/u);
  });
  it.each([
    [2, "public.fulfillment_purchase_reservation_receipts"],
    [3, "public.commerce_destinations"],
    [3, "public.commerce_destination_bindings"],
  ] as const)("refuses slot %s narrowing on %s without its own CREATE", (index, table) => {
    const tableBlock = block("service_role").replace(`ON FUNCTION ${created}`, `ON TABLE ${table}`);
    const baseText = index === 2 ? g4() : sqlStatements(g3()).filter(statement => !statement.startsWith(`CREATE TABLE ${table} (`)
      && !(/^(?:ALTER TABLE |REVOKE ALL ON TABLE |DO )/u.test(statement) && statement.includes(table))).join("\n");
    for (const statement of [`REVOKE ALL ON TABLE ${table} FROM PUBLIC;`, tableBlock, `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`]) {
      expect(() => checkG4G3(index, `${baseText}\n${statement}`)).toThrow(/same slot file/u);
    }
  });
});

// The new-table capability is a fixed G8 allowance, not a registry-defined ACL grammar.
const noticeTable = "public.subscription_notice_refusals";
const noticeGrant = "GRANT SELECT, INSERT ON public.subscription_notice_refusals TO service_role;";
const noticePolicy = "CREATE POLICY subscription_notice_refusals_runtime ON public.subscription_notice_refusals FOR ALL TO service_role USING (true) WITH CHECK (true);";
const noticeDo = (text: string) => `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE '${text}'; END IF; END; $$;`;
const noticeCreate = `CREATE TABLE ${noticeTable} (id uuid);`;
const noticeShape = [noticeCreate, `ALTER TABLE ${noticeTable} ENABLE ROW LEVEL SECURITY;`, `REVOKE ALL ON TABLE ${noticeTable} FROM PUBLIC;`, noticeDo(noticeGrant), noticeDo(noticePolicy)].join("\n");
function checkNotice(text: string, mutate?: (value: ReviewedForwardRegistry) => void, existing?: "baseline" | "earlier-slot") {
  const value = registry(); value.nativeStoreForwardClass!.slots[5]!.insertSelectTables = [noticeTable]; mutate?.(value);
  const preceding = [{ path: PLATFORM_BASELINE_FILE, bytes: Buffer.concat([before, Buffer.from(existing === "baseline" ? `\n${noticeCreate}` : "")]) }];
  for (let index = 0; index < 6; index++) {
    const source = sql(index) + (index === 0 && existing === "earlier-slot" ? `\n${noticeCreate}` : "")
      + (index === 5 ? `\n${block("service_role", "GRANT EXECUTE", control.slots[5]!.createdFunctions[0]!.signature)}\n${text}` : "");
    const pin = bind(value, index, source);
    assertNativeStoreForward(value, pin.path, Buffer.from(source), preceding);
    preceding.push({ path: pin.path, bytes: Buffer.from(source) });
  }
}
const conditionalNoticeError = "reviewed native store conditional privilege target or role refused";
const sameSlotNoticeError = "reviewed native store INSERT/SELECT requires its table created earlier in the same slot file";
function noticeRefusal(run: () => void, message: string) {
  let caught: unknown;
  try { run(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toBe(message);
}
describe("checker-pinned G8 INSERT/SELECT table", () => {
  it("admits the exact guarded grant and single policy after same-file creation", () => { expect(() => checkNotice(noticeShape)).not.toThrow(); });
  it("permits the allowance before its future table is introduced", () => { expect(() => checkNotice("")).not.toThrow(); });
  it("refuses UPDATE, DELETE, TRUNCATE, REFERENCES and TRIGGER", () => {
    for (const privilege of ["UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) noticeRefusal(() => checkNotice(noticeShape.replace("SELECT, INSERT", privilege)), conditionalNoticeError);
  });
  it("refuses any other grantee", () => { noticeRefusal(() => checkNotice(noticeShape.replace(noticeGrant, noticeGrant.replace("TO service_role", "TO fixture_role"))), conditionalNoticeError); });
  it("refuses anon and authenticated grants", () => {
    for (const role of ["anon", "authenticated"]) noticeRefusal(() => checkNotice(noticeShape.replace(noticeGrant, noticeGrant.replace("TO service_role", `TO ${role}`))), conditionalNoticeError);
  });
  it("refuses a second policy", () => { noticeRefusal(() => checkNotice(`${noticeShape}\n${noticeDo(noticePolicy)}`), "reviewed native store INSERT/SELECT permits at most one policy"); });
  it("refuses another policy role, PUBLIC and an omitted role", () => {
    for (const target of ["TO authenticated", "TO PUBLIC", ""]) noticeRefusal(() => checkNotice(noticeShape.replace(noticePolicy, noticePolicy.replace("TO service_role", target))), conditionalNoticeError);
  });
  it("refuses a grant or policy on a pre-existing table", () => {
    for (const statement of [noticeGrant, noticePolicy]) noticeRefusal(() => checkNotice(noticeDo(statement), undefined, "baseline"), sameSlotNoticeError);
  });
  it("refuses a column-level grant", () => { noticeRefusal(() => checkNotice(noticeShape.replace(noticeGrant, noticeGrant.replace("SELECT, INSERT", "SELECT (id), INSERT (id)"))), conditionalNoticeError); });
  it("refuses WITH GRANT OPTION", () => { noticeRefusal(() => checkNotice(noticeShape.replace(noticeGrant, noticeGrant.replace(";", " WITH GRANT OPTION;"))), conditionalNoticeError); });
  it("refuses the shape on a table created by an earlier slot", () => { noticeRefusal(() => checkNotice(noticeDo(noticeGrant), undefined, "earlier-slot"), sameSlotNoticeError); });
  it("refuses an unnamed new table", () => { noticeRefusal(() => checkNotice(noticeShape.replaceAll(noticeTable, "public.fixture_notice_other")), conditionalNoticeError); });
  it("refuses the key on a non-G8 slot", () => { noticeRefusal(() => checkNotice(noticeShape, value => { value.nativeStoreForwardClass!.slots[0]!.insertSelectTables = [noticeTable]; }), "reviewed native store insertSelectTables is G8-only"); });
  it("refuses a G8 value differing from the reader constant", () => {
    for (const names of [[], ["public.fixture_notice_other"], [noticeTable, "public.fixture_notice_other"]]) noticeRefusal(() => checkNotice(noticeShape, value => { value.nativeStoreForwardClass!.slots[5]!.insertSelectTables = names; }), "reviewed native store insertSelectTables is pinned by the checker");
  });
  it("refuses the named table when not created in the same file", () => { noticeRefusal(() => checkNotice(noticeDo(noticeGrant)), sameSlotNoticeError); });
  it("refuses policy text differing by one token", () => { noticeRefusal(() => checkNotice(noticeShape.replace(noticePolicy, noticePolicy.replace("USING (true)", "USING (false)"))), conditionalNoticeError); });
  it("refuses reordered privileges and added TABLE", () => {
    for (const grant of [noticeGrant.replace("SELECT, INSERT", "INSERT, SELECT"), noticeGrant.replace(" ON ", " ON TABLE ")]) noticeRefusal(() => checkNotice(noticeShape.replace(noticeGrant, grant)), conditionalNoticeError);
  });
});


const parameterTable = "CREATE TABLE public.fixture_parameters (id uuid, extra uuid, status text, kind text, CONSTRAINT fixture_status CHECK (status IN ('open','closed')), CONSTRAINT fixture_kind CHECK (kind IN ('first','second')), CONSTRAINT fixture_key UNIQUE (id));";
const parameterCheck = (name = "fixture_status", column = "status", values = "'open','closed','paused'") => `ALTER TABLE public.fixture_parameters DROP CONSTRAINT ${name};\nALTER TABLE public.fixture_parameters ADD CONSTRAINT ${name} CHECK (${column} IN (${values}));`;
const parameterUnique = "ALTER TABLE public.fixture_parameters DROP CONSTRAINT fixture_key;\nALTER TABLE public.fixture_parameters ADD CONSTRAINT fixture_key UNIQUE NULLS NOT DISTINCT (id,extra);";
function parameterForward(text: string, mutate: (slot: NativeStoreSlot) => void, history = "", tableSource = parameterTable) {
  const value = registry(), slot = value.nativeStoreForwardClass!.slots[0]!; mutate(slot);
  const complete = `${sql()}\n${text}`, pin = bind(value, 0, complete);
  const preceding = [{ path: PLATFORM_BASELINE_FILE, bytes: Buffer.concat([before, Buffer.from(`\n${tableSource}`)]) }, ...history ? [{ path: "db/platform/migrations/20261031120000_parameter_history.sql", bytes: Buffer.from(history) }] : []];
  assertNativeStoreForward(value, pin.path, Buffer.from(complete), preceding);
}
const addCheck = (slot: NativeStoreSlot) => { slot.checkSupersets = [{ table: "public.fixture_parameters", constraint: "fixture_status", column: "status", values: ["open", "closed", "paused"] }]; };
const addUnique = (slot: NativeStoreSlot) => { slot.uniqueSupersets = [{ table: "public.fixture_parameters", constraint: "fixture_key", columns: ["id", "extra"], nullsNotDistinct: true }]; };

const rangeCheck = (expression = "days BETWEEN 1 AND 3660", tail = "") => `ALTER TABLE public.fixture_parameters DROP CONSTRAINT fixture_days;
ALTER TABLE public.fixture_parameters ADD CONSTRAINT fixture_days CHECK (${expression})${tail};`;
const addRange = (slot: NativeStoreSlot) => { slot.checkSupersets = [{ table: "public.fixture_parameters", constraint: "fixture_days", column: "days",
  range: { lower: 1, upper: 3660 }, beforeSha256: sqlSha256("CHECK (((days >= 1) AND (days <= 90)))") }]; };

describe("integer range CHECK admission", () => {
  it.each(["days BETWEEN 1 AND 3660", "days >= 1 AND days <= 3660"])("admits the exact adjacent pair: %s", expression => {
    expect(() => parameterForward(rangeCheck(expression), addRange)).not.toThrow();
    expect(() => parameterForward(rangeCheck(expression, " NOT VALID"), addRange)).not.toThrow();
    expect(isExpandOnlyPlatformForward(rangeCheck(expression))).toBe(false);
  });
  it("admits signed int4 endpoints", () => {
    expect(() => parameterForward(rangeCheck("days BETWEEN -2147483648 AND 2147483647"), slot => {
      addRange(slot); Object.assign(slot.checkSupersets![0]!, { range: { lower: -2147483648, upper: 2147483647 } });
    })).not.toThrow();
  });
  it.each([
    "days BETWEEN 2 AND 3660", "days BETWEEN 1 AND 89", "other_days BETWEEN 1 AND 3660",
    "days BETWEEN 1.0 AND 3660", "days BETWEEN 1 AND 3660.5", "days BETWEEN '1' AND 3660",
    "days BETWEEN 1::integer AND 3660", "days BETWEEN (1 + 0) AND 3660", "days BETWEEN lower_bound AND 3660",
    "days BETWEEN 1 AND 3660 OR true", "days BETWEEN 1 AND 3660 AND other_days > 0",
    "days > 1 AND days <= 3660", "days >= 1 AND other_days <= 3660", "days >= 1 OR days <= 3660",
    "days NOT BETWEEN 1 AND 3660", "days BETWEEN SYMMETRIC 1 AND 3660",
    "days BETWEEN -2147483649 AND 3660", "days BETWEEN 1 AND 2147483648",
  ])("refuses an unlisted or non-literal interval: %s", expression => {
    expect(() => parameterForward(rangeCheck(expression), addRange)).toThrow(/CHECK must match/u);
  });
  it.each(["NO INHERIT", "NOT VALID NO INHERIT", "NOT VALID NOT VALID"])("refuses extra CHECK options: %s", option => {
    expect(() => parameterForward(rangeCheck(undefined, ` ${option}`), addRange)).toThrow(/CHECK must match/u);
  });
  it("requires the same table and constraint, exactly once, with no transaction boundary or intervening statement", () => {
    const pair = rangeCheck(), [drop, add] = pair.split("\n");
    for (const text of ["", drop!, add!, `${pair}\n${pair}`, pair.replaceAll("fixture_parameters", "other_table"), pair.replaceAll("fixture_days", "other_check"),
      pair.replace(";\n", ";\nCOMMIT;\n"), pair.replace(";\n", ";\nCREATE TABLE public.gap(id int);\n"),
      pair.replace("DROP CONSTRAINT", "DROP CONSTRAINT IF EXISTS"), pair.replace(";\n", " CASCADE;\n"), `${pair}\nCOMMIT;`]) {
      expect(() => parameterForward(text, addRange)).toThrow(/complete named|must match|duplicate|closed shapes|adjacent/u);
    }
    expect(() => parameterForward(pair, () => {})).toThrow(/closed shapes/u);
  });
  it.each([
    { range: { lower: 1.5, upper: 3660 } }, { range: { lower: "1", upper: 3660 } },
    { range: { lower: 1, upper: 2147483648 } }, { range: { lower: 90, upper: 1 } },
    { range: { lower: 1, upper: 3660, extra: true } }, { range: null },
    { beforeSha256: undefined }, { beforeSha256: "wrong" }, { values: ["open"] },
  ])("refuses malformed range declarations or a missing preimage pin: %j", fields => {
    expect(() => parameterForward(rangeCheck(), slot => { addRange(slot); Object.assign(slot.checkSupersets![0]!, fields); })).toThrow(/invalid CHECK superset entry/u);
  });
});

describe("native store checkToFunctionGuard admission", () => {
  const formatExpr = "CHECK (status ~ '^[a-z][a-z0-9_]{1,63}$')";
  const priorStatusSha = checkConstraintSha256("CHECK (status IN ('open', 'closed'))");
  const afterStatusSha = checkConstraintSha256(formatExpr);
  const guardedPair = (expression = formatExpr, table = "public.fixture_parameters", name = "fixture_status", tail = "") =>
    `ALTER TABLE ${table} DROP CONSTRAINT ${name};\nALTER TABLE ${table} ADD CONSTRAINT ${name} ${expression}${tail};`;
  const addGuarded = (slot: NativeStoreSlot, overrides: Partial<NonNullable<NativeStoreSlot["checkToFunctionGuard"]>[number]> = {}) => {
    slot.checkToFunctionGuard = [{
      table: "public.fixture_parameters",
      name: "fixture_status",
      column: "status",
      beforeSha256: priorStatusSha,
      afterSha256: afterStatusSha,
      guardFunctions: [slot.replacedFunctions[0]!.signature],
      ...overrides,
    }];
  };

  it("admits a pinned named closed-enum CHECK to format CHECK transition with a replaced guard function", () => {
    expect(() => parameterForward(guardedPair(), slot => addGuarded(slot))).not.toThrow();
    expect(() => parameterForward(guardedPair(formatExpr, "public.fixture_parameters", "fixture_status", " NOT VALID"), slot => addGuarded(slot))).not.toThrow();
  });

  it("admits a pinned inline unnamed column CHECK transition (default <table>_<column>_check name)", () => {
    const inlineTable = "CREATE TABLE public.fixture_inline_prefs (id uuid PRIMARY KEY, method_kind text NOT NULL CHECK (method_kind IN ('instant','card','transfer')));";
    const beforeSha = checkConstraintSha256("CHECK (method_kind IN ('instant', 'card', 'transfer'))");
    const afterExpr = "CHECK (method_kind ~ '^[a-z][a-z0-9_]{1,63}$')";
    const afterSha = checkConstraintSha256(afterExpr);
    const pair = guardedPair(afterExpr, "public.fixture_inline_prefs", "fixture_inline_prefs_method_kind_check");
    expect(() => parameterForward(pair, slot => addGuarded(slot, {
      table: "public.fixture_inline_prefs",
      name: "fixture_inline_prefs_method_kind_check",
      column: "method_kind",
      beforeSha256: beforeSha,
      afterSha256: afterSha,
    }), "", inlineTable)).not.toThrow();
  });

  it("tracks prior ALTER TABLE CHECK replacements in the prefix and admits multiple entries in one slot", () => {
    const history = "ALTER TABLE public.fixture_parameters DROP CONSTRAINT fixture_status;\nALTER TABLE public.fixture_parameters ADD CONSTRAINT fixture_status CHECK (status IN ('open','closed','paused'));";
    const widenedBeforeSha = checkConstraintSha256("CHECK (status IN ('open','closed','paused'))");
    const kindBeforeSha = checkConstraintSha256("CHECK (kind IN ('first','second'))");
    const kindAfterExpr = "CHECK (kind ~ '^[a-z][a-z0-9_]{1,63}$')";
    const kindAfterSha = checkConstraintSha256(kindAfterExpr);
    const pair = `${guardedPair()}\n${guardedPair(kindAfterExpr, "public.fixture_parameters", "fixture_kind")}`;
    expect(() => parameterForward(pair, slot => {
      slot.checkToFunctionGuard = [
        { table: "public.fixture_parameters", name: "fixture_status", column: "status", beforeSha256: widenedBeforeSha, afterSha256: afterStatusSha, guardFunctions: [slot.replacedFunctions[0]!.signature] },
        { table: "public.fixture_parameters", name: "fixture_kind", column: "kind", beforeSha256: kindBeforeSha, afterSha256: kindAfterSha, guardFunctions: [slot.replacedFunctions[0]!.signature] },
      ];
    }, history)).not.toThrow();
  });

  it("refuses mismatched beforeSha256 and mismatched afterSha256", () => {
    expect(() => parameterForward(guardedPair(), slot => addGuarded(slot, { beforeSha256: "0".repeat(64) })))
      .toThrow(/checkToFunctionGuard beforeSha256 mismatch/u);
    expect(() => parameterForward(guardedPair(), slot => addGuarded(slot, { afterSha256: "f".repeat(64) })))
      .toThrow(/checkToFunctionGuard afterSha256 mismatch/u);
  });

  it("refuses missing DROP, missing ADD, intervening statements, missing pair, and unpinned DROP CONSTRAINT", () => {
    const pair = guardedPair();
    const [drop, add] = pair.split("\n");
    expect(() => parameterForward(drop!, slot => addGuarded(slot))).toThrow(/complete named CHECK replacement/u);
    expect(() => parameterForward(add!, slot => addGuarded(slot))).toThrow(/adjacent named constraint replacement/u);
    expect(() => parameterForward("", slot => addGuarded(slot))).toThrow(/complete named CHECK replacement/u);
    expect(() => parameterForward(pair.replace(";\n", ";\nCREATE TABLE public.gap (id uuid);\n"), slot => addGuarded(slot))).toThrow(/adjacent named constraint replacement/u);
    expect(() => parameterForward(`${pair}\n${pair}`, slot => addGuarded(slot))).toThrow(/duplicate CHECK replacement/u);
    expect(() => parameterForward(pair, () => {})).toThrow(/closed shapes/u);
    expect(() => parameterForward(pair.replace("DROP CONSTRAINT", "DROP CONSTRAINT IF EXISTS"), slot => addGuarded(slot))).toThrow(/closed shapes/u);
    expect(() => parameterForward(pair.replace(";\n", " CASCADE;\n"), slot => addGuarded(slot))).toThrow(/closed shapes/u);
  });

  it("refuses empty guardFunctions, duplicate guardFunctions, non-canonical signatures, or a guardFunction absent from slot.replacedFunctions", () => {
    expect(() => parameterForward(guardedPair(), slot => addGuarded(slot, { guardFunctions: [] })))
      .toThrow(/requires at least one guardFunctions entry/u);
    expect(() => parameterForward(guardedPair(), slot => addGuarded(slot, { guardFunctions: ["public.unlisted_guard(uuid)"] })))
      .toThrow(/guardFunction must be listed in slot\.replacedFunctions/u);
    expect(() => parameterForward(guardedPair(), slot => addGuarded(slot, { guardFunctions: [slot.replacedFunctions[0]!.signature, slot.replacedFunctions[0]!.signature] })))
      .toThrow(/guardFunctions must be unique canonical signatures/u);
    expect(() => parameterForward(guardedPair(), slot => addGuarded(slot, { guardFunctions: [slot.replacedFunctions[0]!.signature.toUpperCase()] })))
      .toThrow(/guardFunctions must be unique canonical signatures/u);
    expect(() => parameterForward(guardedPair(), slot => addGuarded(slot, { guardFunctions: ["fixture_replaced_1(uuid)"] })))
      .toThrow(/guardFunctions must be unique canonical signatures/u);
  });

  it("admits multiple checkToFunctionGuard entries across two different tables and tracks IF NOT EXISTS / ONLY / ADD COLUMN CHECK in prefix", () => {
    const twoTables = [
      "CREATE TABLE IF NOT EXISTS public.fixture_returns (id uuid PRIMARY KEY, reason_code text NOT NULL, CONSTRAINT fixture_returns_reason_check CHECK (reason_code IN ('damaged', 'other')));",
      "CREATE TABLE IF NOT EXISTS public.fixture_prefs (id uuid PRIMARY KEY);",
    ].join("\n");
    const history = [
      "ALTER TABLE ONLY public.fixture_prefs ADD COLUMN method_kind text NOT NULL CHECK (method_kind IN ('instant', 'card'));",
    ].join("\n");
    const rBefore = checkConstraintSha256("CHECK (reason_code IN ('damaged', 'other'))");
    const rAfterExpr = "CHECK (reason_code ~ '^[a-z][a-z0-9_]{1,63}$')";
    const rAfter = checkConstraintSha256(rAfterExpr);
    const mBefore = checkConstraintSha256("CHECK (method_kind IN ('instant', 'card'))");
    const mAfterExpr = "CHECK (method_kind ~ '^[a-z][a-z0-9_]{1,63}$')";
    const mAfter = checkConstraintSha256(mAfterExpr);
    const pair = `${guardedPair(rAfterExpr, "public.fixture_returns", "fixture_returns_reason_check")}\n${guardedPair(mAfterExpr, "public.fixture_prefs", "fixture_prefs_method_kind_check")}`;
    expect(() => parameterForward(pair, slot => {
      slot.checkToFunctionGuard = [
        { table: "public.fixture_returns", name: "fixture_returns_reason_check", column: "reason_code", beforeSha256: rBefore, afterSha256: rAfter, guardFunctions: [slot.replacedFunctions[0]!.signature] },
        { table: "public.fixture_prefs", name: "fixture_prefs_method_kind_check", column: "method_kind", beforeSha256: mBefore, afterSha256: mAfter, guardFunctions: [slot.replacedFunctions[0]!.signature] },
      ];
    }, history, twoTables)).not.toThrow();
  });

  it.each([
    "CHECK (true)",
    "CHECK (status <> '')",
    "CHECK (status IS NOT NULL)",
    "CHECK (status ~ '^.*$')",
    "CHECK (status ~ '^.+$')",
    "CHECK (status ~ '[a-z]+')",
    "CHECK (status ~ '^[a-z]*$')",
    "CHECK (status ~ '^[a-z]+$')",
    "CHECK (status ~ '^[a-z]+|.*$')",
    "CHECK (status ~ '^([a-z]+)+$')",
    "CHECK (status ~ '^[^ ]+$')",
    "CHECK (status ~ '^[a-z]{0,10}$')",
    "CHECK (status ~ '^[a-z]{1,300}$')",
    "CHECK (kind ~ '^[a-z][a-z0-9_]{1,63}$')",
    "CHECK (status ~ '^[a-z][a-z0-9_]{1,63}$' OR true)",
  ])("refuses trivial, unconstrained, ReDoS, negated-class, or wrong-column replacement: %s", expression => {
    const hash = checkConstraintSha256(expression);
    expect(() => parameterForward(guardedPair(expression), slot => addGuarded(slot, { afterSha256: hash })))
      .toThrow(/must be a non-trivial anchored format CHECK/u);
  });

  it("refuses a format CHECK that does not accept all prior enum values", () => {
    const narrowExpr = "CHECK (status ~ '^[0-9]{1,8}$')";
    expect(() => parameterForward(guardedPair(narrowExpr), slot => addGuarded(slot, { afterSha256: checkConstraintSha256(narrowExpr) })))
      .toThrow(/must accept all prior enum values/u);
  });

  it("refuses a missing prior CHECK, column mismatch, non-enum prior CHECK, duplicate/overlapping entries, or malformed declarations", () => {
    expect(() => parameterForward(guardedPair(formatExpr, "public.fixture_parameters", "missing_check"), slot => addGuarded(slot, { name: "missing_check" })))
      .toThrow(/prior CHECK missing from prefix/u);
    expect(() => parameterForward(guardedPair(), slot => addGuarded(slot, { column: "kind" })))
      .toThrow(/prior CHECK must be a closed enum on kind/u);
    const nonEnumTable = "CREATE TABLE public.fixture_non_enum (id uuid, status text, CONSTRAINT fixture_status CHECK (status <> ''));";
    expect(() => parameterForward(guardedPair(formatExpr, "public.fixture_non_enum", "fixture_status"), slot => addGuarded(slot, {
      table: "public.fixture_non_enum",
      beforeSha256: checkConstraintSha256("CHECK (status <> '')"),
    }), "", nonEnumTable)).toThrow(/prior CHECK must be a closed enum/u);
    expect(() => parameterForward(guardedPair(), slot => { addCheck(slot); addGuarded(slot); }))
      .toThrow(/duplicate constraint entry/u);
    expect(() => parameterForward(guardedPair(), slot => {
      addGuarded(slot);
      slot.checkToFunctionGuard!.push({ ...slot.checkToFunctionGuard![0]! });
    })).toThrow(/duplicate constraint entry/u);
    expect(() => parameterForward(guardedPair(), slot => { slot.checkToFunctionGuard = []; }))
      .toThrow(/requires a non-empty array/u);
    expect(() => parameterForward(guardedPair(), slot => addGuarded(slot, { afterSha256: priorStatusSha })))
      .toThrow(/invalid checkToFunctionGuard entry/u);
  });
});

describe("registry-defined native capabilities", () => {
  it("admits a fresh later eighth slot from data and keeps all issued data unchanged", () => {
    expect(readReviewedForwardRegistry(encode(production))).toEqual(production);
    const value = registry(), preceding = [{ path: PLATFORM_BASELINE_FILE, bytes: before }];
    for (let index = 0; index < 7; index++) { const text = sql(index), pin = bind(value, index, text); assertNativeStoreForward(value, pin.path, Buffer.from(text), preceding); preceding.push({ path: pin.path, bytes: Buffer.from(text) }); }
    const path = "db/platform/migrations/20271106100000_future.sql";
    value.nativeStoreForwardClass!.slots.push({ row: "C2-1", path, replacedFunctions: [], createdFunctions: [], grantOnlyFunctions: [], dataStatements: [] });
    const text = "CREATE TABLE public.fixture_eighth (id uuid);"; bind(value, 7, text);
    expect(() => assertNativeStoreForward(value, path, Buffer.from(text), preceding)).not.toThrow();
    value.nativeStoreForwardClass!.slots.push({ ...structuredClone(value.nativeStoreForwardClass!.slots[7]!), row: "Ninth", path: "db/platform/migrations/20271106110000_ninth.sql" });
    expect(() => readReviewedForwardRegistry(encode(value))).not.toThrow();
  });
  it.each(["DROP TABLE public.fixture_parameters;", "ALTER TABLE public.fixture_parameters DROP COLUMN status;", "ALTER TABLE public.fixture_parameters ALTER COLUMN status TYPE integer;", "ALTER TABLE public.fixture_parameters RENAME COLUMN status TO other;", "ALTER TABLE public.fixture_parameters ADD COLUMN safe text, DROP COLUMN status;"])("refuses listed destructive existing-table DDL: %s", statement => {
    expect(() => parameterForward(statement, slot => { slot.existingTableStatements = [statement]; })).toThrow("reviewed native store existing-table statement is not expand-only");
  });
  it("admits multiple CHECK widenings after unrelated additive DDL", () => {
    const history = "ALTER TABLE public.fixture_parameters ADD COLUMN unrelated uuid;\nALTER TABLE public.fixture_parameters ADD CONSTRAINT unrelated_fk FOREIGN KEY (unrelated) REFERENCES public.fixture_row(id) ON DELETE RESTRICT NOT VALID;";
    expect(() => parameterForward(`${parameterCheck()}\n${parameterCheck("fixture_kind", "kind", "'first','second','third'")}`, slot => { addCheck(slot); slot.checkSupersets!.push({ ...slot.checkSupersets![0]!, constraint: "fixture_kind", column: "kind", values: ["first", "second", "third"] }); }, history)).not.toThrow();
  });
  it.each([false, true])("admits a listed CHECK with trailing NOT VALID without reading prefix validation state (%s)", unvalidated => {
    const source = unvalidated ? parameterTable.replace("('open','closed'))", "('open','closed')) NOT VALID") : parameterTable;
    expect(() => parameterForward(parameterCheck().replace(/;$/u, " NOT VALID;"), addCheck, "", source)).not.toThrow();
  });
  it.each(["NOT", "VALID", "NO INHERIT", "NOT VALID NOT VALID", "NOT VALID NO INHERIT"])("refuses a listed CHECK with other trailing tokens: %s", tail => {
    expect(() => parameterForward(parameterCheck().replace(/;$/u, ` ${tail};`), addCheck)).toThrow(/CHECK must match/u);
  });
  it("refuses another ALTER action after a NOT VALID CHECK", () => {
    expect(() => parameterForward(parameterCheck().replace(/;$/u, " NOT VALID, ADD COLUMN other text;"), addCheck))
      .toThrow("reviewed native store requires the adjacent named constraint replacement");
  });
  it("keeps exact values, binding and adjacency for a NOT VALID CHECK", () => {
    const sql = parameterCheck().replace(/;$/u, " NOT VALID;");
    expect(() => parameterForward(sql.replace("'open','closed','paused'", "'open','paused'"), addCheck)).toThrow(/CHECK must match/u);
    expect(() => parameterForward(sql.replaceAll("fixture_status", "other_status"), addCheck)).toThrow(/closed shapes/u);
    expect(() => parameterForward(sql.replace(";\n", ";\nCREATE TABLE public.gap (id uuid);\n"), addCheck)).toThrow(/adjacent/u);
    expect(() => parameterForward(sql, () => {})).toThrow(/closed shapes/u);
  });
  it("requires CHECK ADD values to equal the slot and the pair to be adjacent", () => {
    expect(() => parameterForward(parameterCheck(undefined, undefined, "'open','paused'"), addCheck)).toThrow("reviewed native store CHECK must match its listed values");
    expect(() => parameterForward(parameterCheck().replace(";\n", ";\nCREATE TABLE public.gap (id uuid);\n"), addCheck)).toThrow(/adjacent/u);
    expect(() => parameterForward(parameterCheck(), () => {})).toThrow(/closed shapes/u);
  });
  it("admits only a listed adjacent UNIQUE superset without widening the general grammar", () => {
    expect(isExpandOnlyPlatformForward(parameterUnique.split("\n")[1]!)).toBe(false);
    expect(() => parameterForward(parameterUnique, addUnique)).not.toThrow();
    expect(() => parameterForward(parameterUnique, () => {})).toThrow(/closed shapes/u);
    expect(() => parameterForward(parameterUnique.replace("(id,extra)", "(extra)"), addUnique)).toThrow("reviewed native store UNIQUE must match its listed key");
    expect(() => parameterForward(parameterUnique.replace(";\n", ";\nCREATE TABLE public.gap (id uuid);\n"), addUnique)).toThrow(/adjacent/u);
    expect(() => parameterForward(parameterUnique.replaceAll("fixture_key", "other_key"), addUnique)).toThrow(/closed shapes/u);
    expect(() => parameterForward(parameterUnique.replace(" NULLS NOT DISTINCT", ""), addUnique)).toThrow(/UNIQUE must match/u);
  });
  it("admits a hash-pinned fresh view and required PUBLIC and conditional revokes", () => {
    const create = "CREATE VIEW public.fixture_parameter_view AS SELECT id FROM public.fixture_parameters;";
    const revoke = "REVOKE ALL ON TABLE public.fixture_parameter_view FROM PUBLIC;";
    const entry = (slot: NativeStoreSlot) => { slot.createdViews = [{ name: "public.fixture_parameter_view", sha256: sqlSha256(create) }]; };
    const text = `${create}\n${revoke}\nDO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON TABLE public.fixture_parameter_view FROM anon'; END IF; END; $$;`;
    expect(() => parameterForward(text, entry)).not.toThrow();
    expect(() => parameterForward(create, entry)).toThrow("reviewed native store created view missing PUBLIC revoke");
    for (const role of ["PUBLIC", "service_role", "authenticated"]) {
      expect(() => parameterForward(`${text}\nGRANT SELECT ON TABLE public.fixture_parameter_view TO ${role};`, entry)).toThrow("reviewed native store created view GRANT refused");
      expect(() => parameterForward(`${text}\nDO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT SELECT ON TABLE public.fixture_parameter_view TO ${role};'; END IF; END; $$;`, entry)).toThrow("reviewed native store created view GRANT refused");
    }
    expect(() => parameterForward(text, () => {})).toThrow(/view definition/u);
    expect(() => parameterForward(text + `\n${create}`, entry)).toThrow(/view definition/u);
    expect(() => parameterForward(text.replace("SELECT id", "SELECT extra"), entry)).toThrow(/view definition/u);
    expect(() => parameterForward("", entry)).toThrow(/view missing/u);
  });
  it("preserves all required new-table, index, invoker, narrowing and named-DML shapes", () => {
    const table = "CREATE TABLE public.fixture_editor (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), parent uuid REFERENCES public.fixture_parameters(id), hash text CHECK (char_length(hash) = 64), status text DEFAULT 'previewed', created_at timestamptz DEFAULT now());";
    const seed = "INSERT INTO public.client_absorption_policy (table_name, disposition, note) VALUES ('fixture_editor','block','Retain original ownership.');";
    const text = `${table}\nCREATE INDEX fixture_editor_lookup ON public.fixture_editor (id, created_at DESC);\nCREATE INDEX fixture_editor_expiry ON public.fixture_editor (created_at);\nCREATE UNIQUE INDEX fixture_editor_open ON public.fixture_editor (id) WHERE status = 'previewed';\nALTER TABLE public.fixture_editor ENABLE ROW LEVEL SECURITY;\nREVOKE ALL ON TABLE public.fixture_editor FROM PUBLIC;\nALTER TABLE public.subscriptions ADD COLUMN composition_constraint jsonb;\nALTER TABLE public.subscriptions ADD CONSTRAINT fixture_composition CHECK (composition_constraint IS NULL OR jsonb_typeof(composition_constraint) = 'object') NOT VALID;\nALTER TABLE public.subscriptions ADD COLUMN configured_offer_version text NOT NULL DEFAULT 'classic';\nALTER TABLE public.subscriptions ADD CONSTRAINT fixture_offer CHECK (configured_offer_version IN ('classic','sized.v1')) NOT VALID;\n${seed}`;
    expect(() => parameterForward(text, slot => { slot.dataStatements = [seed]; })).not.toThrow();
    expect(() => check(sql().replace("SECURITY DEFINER", "IMMUTABLE SECURITY INVOKER"))).not.toThrow();
  });
});

function nativeGitFixture(run: (context: { folder: string; git: (...args: string[]) => string; put: (path: string, bytes: string | Buffer) => void; commit: () => string }) => void) {
  mkdirSync(".context/scratch", { recursive: true });
  const folder = mkdtempSync(resolve(".context/scratch/native-parameters-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", folder, "-c", "user.name=Control Test", "-c", "user.email=control@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
  const put = (path: string, bytes: string | Buffer) => { mkdirSync(dirname(resolve(folder, path)), { recursive: true }); writeFileSync(resolve(folder, path), bytes); };
  const commit = () => { git("add", "."); git("commit", "-qm", "Synthetic parameter witness"); return git("rev-parse", "HEAD"); };
  try { git("init", "-q", "-b", "main"); run({ folder, git, put, commit }); } finally { rmSync(folder, { force: true, recursive: true }); }
}
const emptySlot = (path: string, row = "Future"): NativeStoreSlot => ({ row, path, replacedFunctions: [], createdFunctions: [], grantOnlyFunctions: [], dataStatements: [] });

describe("native replacements of qualified SECURITY DEFINER functions", () => {
  const path = "db/platform/migrations/20990101000000_qualified_security.sql";
  const signature = "public.catalog_price_setup_region_code()";
  const searchPath = "pg_catalog, pg_temp";
  const prior = `CREATE FUNCTION ${signature} RETURNS text LANGUAGE sql SECURITY INVOKER SET search_path = ${searchPath} AS $$ SELECT 'before'; $$;`;
  const definition = prior.replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION").replace("'before'", "'after'");
  const guard = renderQualifiedSecurityDefiner(signature);
  const text = `${definition}\n${guard}`;
  const valueFor = (candidate = text, target = signature, preimage = prior.replace(signature, target), pinnedSearchPath: string | null = searchPath) => {
    const value = registry(), slot = emptySlot(path);
    slot.replacedFunctions = [{ signature: target, beforeSha256: sqlSha256(preimage), searchPath: pinnedSearchPath, qualifiedSecurityDefiner: true }];
    value.nativeStoreForwardClass = { sealed: true, slots: [slot] };
    bind(value, 0, candidate);
    return { value, slot, prefix: [{ path: PLATFORM_BASELINE_FILE, bytes: Buffer.from(preimage) }] };
  };

  it("admits the rendered guard against committed base through PR, queue and release checks", () => {
    nativeGitFixture(({ folder, git, put, commit }) => {
      const { value } = valueFor();
      const baseRegistry = { ...value, nativeStoreForwardClass: { sealed: true, slots: [] }, nativeStoreForwards: [] };
      put(PLATFORM_BASELINE_FILE, prior);
      put("config/reviewed-platform-forwards.json", encode(baseRegistry));
      const base = commit();
      put(path, text);
      put("config/reviewed-platform-forwards.json", encode(value));
      const head = commit();
      const merged = git("commit-tree", git("rev-parse", `${head}^{tree}`), "-p", base, "-p", head, "-m", "Synthetic PR merge");
      expect(() => assertAdmittedPlatformForward(folder, base, merged, path, Buffer.from(text))).not.toThrow();
      expect(() => assertCoLocatedForwardApproval(folder, base, head)).not.toThrow();
      expect(() => assertCoLocatedForwardApproval(folder, base, merged)).not.toThrow();
      expect(() => assertAdmittedPlatformForward(folder, base, merged, path, Buffer.from(text), true)).not.toThrow();
    });
  });

  it.each([
    ["changed whitespace", `${definition}\n${guard.replace("  THEN", "   THEN")}`, "expected this exact statement immediately after"],
    ["changed signature", `${definition}\n${guard.replace(signature, "public.catalog_price_setup_settlement_currency()")}`, "expected this exact statement immediately after"],
    ["changed ledger path", `${definition}\n${guard.replace(authorityPath, PLATFORM_BASELINE_FILE)}`, "expected this exact statement immediately after"],
    ["changed ledger hash", `${definition}\n${guard.replace(authoritySha256, "0".repeat(64))}`, "expected this exact statement immediately after"],
    ["missing statement at the end of the file", definition, "expected this exact statement immediately after"],
    ["statement before the replacement", `${guard}\n${definition}`, "put this exact statement only immediately after"],
    ["mark with a different following statement", `${definition}\nREVOKE ALL ON FUNCTION ${signature} FROM PUBLIC;`, "expected this exact statement immediately after"],
    ["a DEFINER header", text.replace("SECURITY INVOKER", "SECURITY DEFINER"), "keep the native SECURITY INVOKER header"],
  ])("refuses %s with the signature and exact statement", (_label, candidate, remedy) => {
    const { value, prefix } = valueFor(candidate);
    const admit = () => assertNativeStoreForward(value, path, Buffer.from(candidate), prefix);
    expect(admit).toThrow(`${signature}: ${remedy}`);
    expect(admit).toThrow(guard);
  });

  it.each([
    "public.catalog_publication_record_command(jsonb)",
    "public.catalog_publication_admit()",
    "public.catalog_price_setup_region_code()",
    "public.catalog_price_setup_settlement_currency()",
    "public.platform_human_membership_is_administrator(uuid)",
    "public.catalog_publication_assert_receipt(uuid,text)",
  ])("refuses an unmarked replacement of qualified DEFINER %s", target => {
    const candidate = definition.replace(signature, target);
    const { value, slot, prefix } = valueFor(candidate, target);
    delete slot.replacedFunctions[0]!.qualifiedSecurityDefiner;
    expect(() => assertNativeStoreForward(value, path, Buffer.from(candidate), prefix))
      .toThrow(`${target}: set qualifiedSecurityDefiner: true and put this statement immediately after its CREATE OR REPLACE FUNCTION:\n${renderQualifiedSecurityDefiner(target)}`);
  });

  it("refuses an unmarked replacement even with the exact statement", () => {
    const { value, slot, prefix } = valueFor();
    delete slot.replacedFunctions[0]!.qualifiedSecurityDefiner;
    expect(() => assertNativeStoreForward(value, path, Buffer.from(text), prefix))
      .toThrow(`${signature}: set qualifiedSecurityDefiner: true and put this statement immediately after its CREATE OR REPLACE FUNCTION:\n${guard}`);
  });

  it.each([
    ["pg_catalog, public", false],
    ["pg_catalog, public, pg_temp", true],
  ] as const)("admits a marked record_command replacement with search_path %s = %s", (pinnedPath, admitted) => {
    const target = "public.catalog_publication_record_command(jsonb)";
    const nativePath = "pg_catalog, public";
    const source = readFileSync("db/platform/migrations/20261123191000_catalog_publication_commands.sql", "utf8");
    const preimage = sqlStatements(source, false, false, true).find(statement => statement.startsWith("CREATE FUNCTION public.catalog_publication_record_command("))!;
    const replacement = preimage.replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION").replace(`SET search_path = ${nativePath} AS`, `SET search_path = ${pinnedPath} AS`);
    const candidate = `${replacement}\n${renderQualifiedSecurityDefiner(target)}`;
    const { value, prefix } = valueFor(candidate, target, preimage, pinnedPath);
    const admit = () => assertNativeStoreForward(value, path, Buffer.from(candidate), prefix);
    if (admitted) expect(admit).not.toThrow();
    else expect(admit).toThrow(`${target}: qualifiedSecurityDefiner must pin SET search_path = pg_catalog, public, pg_temp`);
  });

  it.each([null, "pg_catalog, pg_temp, pg_temp", "pg_catalog, pg_temp_42, pg_temp", "pg_catalog, pg_temp_42"])("refuses a marked replacement with search_path %j", pinnedPath => {
    const { value, slot } = valueFor();
    slot.replacedFunctions[0]!.searchPath = pinnedPath;
    expect(() => readReviewedForwardRegistry(encode(value)))
      .toThrow(`${signature}: qualifiedSecurityDefiner must pin SET search_path = pg_catalog, pg_temp`);
  });

  it.each([true, false])("refuses a guard for a function outside the qualified set with mark present = %s", marked => {
    const other = "public.fixture_unqualified()";
    const candidate = text.replaceAll(signature, other), { value, slot, prefix } = valueFor(candidate, other);
    if (!marked) delete slot.replacedFunctions[0]!.qualifiedSecurityDefiner;
    const admit = () => assertNativeStoreForward(value, path, Buffer.from(candidate), prefix);
    expect(admit).toThrow(`${other}: ${marked ? "the qualified authority migration leaves its SECURITY mode unchanged" : "remove this statement"}`);
    expect(admit).toThrow(renderQualifiedSecurityDefiner(other));
  });

  it("refuses the field on a created function", () => {
    const { value, slot } = valueFor();
    slot.createdFunctions = [{ ...slot.replacedFunctions[0]! }];
    slot.replacedFunctions = [];
    expect(() => readReviewedForwardRegistry(encode(value))).toThrow(`${signature}: remove qualifiedSecurityDefiner from createdFunctions`);
  });

  it.each([false, null, "true", 1])("refuses a qualifiedSecurityDefiner value of %j", invalid => {
    const { value, slot } = valueFor();
    Object.assign(slot.replacedFunctions[0]!, { qualifiedSecurityDefiner: invalid });
    expect(() => readReviewedForwardRegistry(encode(value))).toThrow(`${signature}: qualifiedSecurityDefiner must be true when present`);
  });

  it("admits a later marked replacement with the chained before-hash", () => {
    const { value, slot, prefix } = valueFor();
    const later = emptySlot("db/platform/migrations/20990102000000_qualified_security.sql", "Later");
    later.replacedFunctions = [{ ...slot.replacedFunctions[0]!, beforeSha256: sqlSha256(definition) }];
    value.nativeStoreForwardClass!.slots.push(later);
    const candidate = text.replace("'after'", "'later'");
    bind(value, 1, candidate);
    expect(() => assertNativeStoreForward(value, later.path, Buffer.from(candidate), [...prefix, { path, bytes: Buffer.from(text) }])).not.toThrow();
  });
});

describe("settings-only native forwards", () => {
  const path = "db/platform/migrations/20261124130000_fixture_settings.sql";
  const settings = [
    { signature: "public.fixture_grant(text[])", searchPath: "pg_catalog, pg_temp" },
    { signature: "public.fixture_existing(uuid)", searchPath: "public, pg_catalog, pg_temp" },
  ];
  const render = ({ signature, searchPath }: typeof settings[number]) => `ALTER FUNCTION ${signature} SET search_path = ${searchPath};`;
  const statements = settings.map(render);
  const text = statements.join("\n");
  const valueFor = (bytes = text, functions = settings) => {
    const value = registry();
    value.nativeStoreForwardClass = { sealed: true, slots: [{ ...emptySlot(path), settingsOnlyFunctions: functions }] };
    value.nativeStoreForwards = [{ path, sha256: sqlSha256(bytes), functions: [] }];
    return value;
  };
  const prefix = [{ path: PLATFORM_BASELINE_FILE, bytes: before }];
  const nonPublicSettings = [
    { signature: "acquisition_private.keyed_digest(text,jsonb)", searchPath: "pg_catalog, pg_temp" },
    { signature: "auth.uid()", searchPath: "pg_catalog, pg_temp" },
  ];
  const nonPublicPrefix = [
    "db/platform/migrations/20260810180001_self_host_actor_auth.sql",
    "db/platform/migrations/20260816140000_acquisition_case_foundation.sql",
  ].map(path => ({ path, bytes: readFileSync(path) }));
  const ownerWindowRole = "fixture_owner";
  const windowText = renderNativeStoreSettingsOwnerWindow(settings, ownerWindowRole);
  const [open, , , close] = sqlStatements(windowText, false, false, true) as [string, string, string, string];
  const valueForWindow = (candidate = windowText) => {
    const value = valueFor(candidate);
    value.nativeStoreForwardClass!.slots[0]!.ownerWindowRole = ownerWindowRole;
    return value;
  };

  it("admits exact settings statements from committed base through PR, queue and release checks", () => {
    nativeGitFixture(({ folder, put, commit }) => {
      const value = valueFor();
      const prior = structuredClone(value);
      prior.nativeStoreForwardClass!.slots = [];
      prior.nativeStoreForwards = [];
      put(PLATFORM_BASELINE_FILE, before);
      put("config/reviewed-platform-forwards.json", encode(prior));
      const base = commit();
      put(path, text);
      put("config/reviewed-platform-forwards.json", encode(value));
      const head = commit();
      expect(() => assertAdmittedPlatformForward(folder, base, head, path, Buffer.from(text))).not.toThrow();
      expect(() => assertCoLocatedForwardApproval(folder, base, head)).not.toThrow();
      expect(() => assertAdmittedPlatformForward(folder, base, head, path, Buffer.from(text), true)).not.toThrow();
    });
  });

  it("admits non-public settings from committed native definitions through PR, queue and release checks", () => {
    nativeGitFixture(({ folder, git, put, commit }) => {
      const candidate = nonPublicSettings.map(render).join("\n");
      const value = valueFor(candidate, nonPublicSettings);
      const prior = { ...value, nativeStoreForwardClass: { sealed: true, slots: [] }, nativeStoreForwards: [] };
      put(PLATFORM_BASELINE_FILE, before);
      for (const source of nonPublicPrefix) put(source.path, source.bytes);
      put("config/reviewed-platform-forwards.json", encode(prior));
      const base = commit();
      put(path, candidate);
      put("config/reviewed-platform-forwards.json", encode(value));
      const head = commit();
      const group = git("commit-tree", git("rev-parse", `${head}^{tree}`), "-p", base, "-p", head, "-m", "Synthetic settings group");
      expect(() => assertAdmittedPlatformForward(folder, base, head, path, Buffer.from(candidate))).not.toThrow();
      expect(() => assertCoLocatedForwardApproval(folder, base, group)).not.toThrow();
      expect(() => assertAdmittedPlatformForward(folder, base, head, path, Buffer.from(candidate), true)).not.toThrow();
    });
  });

  it.each([
    "fixture_private.keyed_digest(text,jsonb)",
    'acquisition_private."keyed_digest"(text,jsonb)',
    "Acquisition_Private.keyed_digest(text,jsonb)",
    "auth.fixture_other()",
    "auth.uid(uuid)",
    "auth.uid( )",
  ])("refuses settings signature %s and names the admitted forms", signature => {
    const functions = [{ ...nonPublicSettings[0]!, signature }];
    expect(() => readReviewedForwardRegistry(encode(valueFor(render(functions[0]!), functions))))
      .toThrow("Use public.<name>(<types>), acquisition_private.<name>(<types>) or exactly auth.uid().");
  });

  it("refuses a non-public settings target absent from the base definitions", () => {
    const candidate = nonPublicSettings.map(render).join("\n");
    expect(() => assertNativeStoreForward(valueFor(candidate, nonPublicSettings), path, Buffer.from(candidate), [...prefix, nonPublicPrefix[0]!]))
      .toThrow("settings-only function absent from base migrations: acquisition_private.keyed_digest(text,jsonb)");
  });

  it("refuses extra SQL for non-public settings with a matching file hash", () => {
    const candidate = [...nonPublicSettings.map(render), "SELECT 1;"].join("\n");
    expect(() => assertNativeStoreForward(valueFor(candidate, nonPublicSettings), path, Buffer.from(candidate), [...prefix, ...nonPublicPrefix]))
      .toThrow("Expected 2 statements, found 3.");
  });

  it.each(nonPublicSettings)("keeps $signature out of the ordinary function lists", ({ signature, searchPath }) => {
    const value = registry();
    const slot = emptySlot(path);
    value.nativeStoreForwardClass = { sealed: true, slots: [slot] };
    const read = () => readReviewedForwardRegistry(encode(value));
    expect(read).not.toThrow();

    slot.createdFunctions = [{ signature, searchPath }];
    expect(read).toThrow("reviewed native store closed signature, preimage or search_path drifted");
    slot.createdFunctions = [];
    slot.replacedFunctions = [{ signature, searchPath, beforeSha256: sqlSha256(before) }];
    expect(read).toThrow("reviewed native store closed signature, preimage or search_path drifted");
    slot.replacedFunctions = [];
    slot.grantOnlyFunctions = [{ signature, grantTo: ["authenticated"], revokeFrom: [] }];
    expect(read).toThrow("reviewed native store invalid grant-only signature or role capability");
    slot.grantOnlyFunctions = [{ signature, grantTo: ["service_role"], revokeFrom: [], revokePublic: true }];
    expect(read).toThrow(nativeStoreRevokePublicMessages.slot);
  });

  it.each([
    ["an extra ALTER", `${text}\nALTER FUNCTION public.fixture_existing(uuid) COST 10;`, "Expected 2 statements, found 3."],
    ["reordered entries", [...statements].reverse().join("\n"), `At index 0 (zero-based), expected: ${statements[0]}`],
    ["non-ALTER SQL", `${statements[0]}\nSELECT 1;`, `At index 1 (zero-based), expected: ${statements[1]}`],
  ])("locates %s even with a matching file hash", (_label, candidate, message) => {
    expect(() => assertNativeStoreForward(valueFor(candidate), path, Buffer.from(candidate), prefix)).toThrow(message);
  });

  it("admits the exact settings-owner window from committed base through PR, queue and release checks", () => {
    nativeGitFixture(({ folder, put, commit }) => {
      const value = valueForWindow();
      const prior = structuredClone(value);
      prior.nativeStoreForwardClass!.slots = [];
      prior.nativeStoreForwards = [];
      put(PLATFORM_BASELINE_FILE, before);
      put("config/reviewed-platform-forwards.json", encode(prior));
      const base = commit();
      put(path, windowText);
      put("config/reviewed-platform-forwards.json", encode(value));
      const head = commit();
      expect(() => assertAdmittedPlatformForward(folder, base, head, path, Buffer.from(windowText))).not.toThrow();
      expect(() => assertCoLocatedForwardApproval(folder, base, head)).not.toThrow();
      expect(() => assertAdmittedPlatformForward(folder, base, head, path, Buffer.from(windowText), true)).not.toThrow();
    });
  });

  const lineOf = (snippet: string) => windowText.slice(0, windowText.indexOf(snippet)).split("\n").length;
  const closeLine = lineOf(close);
  const grantLine = lineOf("    EXECUTE pg_catalog.format('GRANT");
  const revokeLine = lineOf("    EXECUTE pg_catalog.format('REVOKE");
  const closeEnd = windowText.trimEnd().split("\n").length;

  it.each([
    ["a space in OPEN", windowText.replace(open, open.replace("BEGIN\n", "BEGIN \n")), 2],
    ["a newline in OPEN", windowText.replace(open, open.replace("BEGIN\n", "BEGIN\r\n")), 2],
    ["a space in CLOSE", windowText.replace(close, close.replace("BEGIN\n", "BEGIN \n")), closeLine + 1],
    ["a newline in CLOSE", windowText.replace(close, close.replace("BEGIN\n", "BEGIN\r\n")), closeLine + 1],
    ["a different role in OPEN", windowText.replace(`GRANT ${ownerWindowRole}`, "GRANT another_owner"), grantLine],
    ["a different role in CLOSE", windowText.replace(`REVOKE ${ownerWindowRole} FROM %I`, "REVOKE another_owner FROM %I"), revokeLine],
    ["a literal grantor in OPEN", windowText.replace(open, open.replace("GRANTED BY %I", "GRANTED BY another_owner")), grantLine],
    ["a literal grantor in CLOSE", windowText.replace(close, close.replace("GRANTED BY %I", "GRANTED BY another_owner")), revokeLine],
    ["a different ADMIN", windowText.replace("ADMIN FALSE", "ADMIN TRUE"), grantLine],
    ["a different INHERIT", windowText.replace("INHERIT TRUE", "INHERIT FALSE"), grantLine],
    ["a different SET", windowText.replace("SET FALSE", "SET TRUE"), grantLine],
    ["missing OPEN", `${text}\n${close}\n`, 1],
    ["missing CLOSE", `${open}\n${text}\n`, closeLine],
    ["CLOSE before the ALTERs", `${open}\n${close}\n${text}\n`, lineOf(statements[0]!)],
    ["reordered ALTERs", `${open}\n${[...statements].reverse().join("\n")}\n${close}\n`, lineOf(statements[0]!)],
    ["an extra statement", `${windowText}SELECT 1;\n`, closeEnd + 1],
    ["a missing final newline", windowText.slice(0, -1), closeEnd],
    ["an extra final newline", `${windowText}\n`, closeEnd + 1],
  ] as const)("refuses %s and reports the first differing line", (_label, candidate, line) => {
    const show = (sql: string) => JSON.stringify(sql.split(/(?<=\n)/u)[line - 1]) ?? "<end of file>";
    expect(() => assertNativeStoreForward(valueForWindow(candidate), path, Buffer.from(candidate), prefix))
      .toThrow(`Line ${line}: expected ${show(windowText)}; actual ${show(candidate)}.`);
  });

  it("refuses ownerWindowRole on an ordinary slot", () => {
    const value = valueForWindow();
    delete value.nativeStoreForwardClass!.slots[0]!.settingsOnlyFunctions;
    expect(() => readReviewedForwardRegistry(encode(value))).toThrow("ownerWindowRole is allowed only on a settings-only slot");
  });

  it.each(["Fixture_owner", '"fixture_owner"', "pg_fixture_owner", "a".repeat(64), 42])("refuses invalid ownerWindowRole %j", role => {
    const value = valueForWindow();
    Object.assign(value.nativeStoreForwardClass!.slots[0]!, { ownerWindowRole: role });
    expect(() => readReviewedForwardRegistry(encode(value))).toThrow("ownerWindowRole must be an unquoted lowercase role name of at most 63 ASCII characters matching ^[a-z_][a-z0-9_]{0,62}$ and must not start with pg_.");
  });

  it.each([false, true])("admits a later replacement and grant-only change after the pinned settings ALTERs (owner window: %s)", withWindow => {
    const grant = settings[0]!, replace = settings[1]!;
    // Keep the replacement header already pinned so this exercises the prefix scan independently.
    const prior = `CREATE FUNCTION public.fixture_existing(p_id uuid) RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = ${replace.searchPath} AS $$ SELECT 'before'; $$;`;
    const after = prior.replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION").replace("'before'", "'after'");
    const next = emptySlot("db/platform/migrations/20261124140000_fixture_followup.sql", "Followup");
    next.replacedFunctions.push({ ...replace, beforeSha256: sqlSha256(prior) });
    next.grantOnlyFunctions.push({ signature: grant.signature, grantTo: ["authenticated"], revokeFrom: [] });
    const value = withWindow ? valueForWindow() : valueFor();
    value.nativeStoreForwardClass!.slots.push(next);
    const candidate = `${after}\n${block("authenticated", "GRANT EXECUTE", grant.signature)}`;
    bind(value, 1, candidate);
    const baseline = before.toString("utf8").replace(/^CREATE FUNCTION public\.fixture_existing\(.*$/mu, () => prior);
    const history = [
      { path: PLATFORM_BASELINE_FILE, bytes: Buffer.from(baseline) },
      { path, bytes: Buffer.from(withWindow ? windowText : text) },
    ];
    expect(() => assertNativeStoreForward(value, next.path, Buffer.from(candidate), history)).not.toThrow();
    expect(() => assertNativeStoreForward(value, next.path, Buffer.from(candidate), history.slice(0, 1)))
      .toThrow(new Error("reviewed native store requires every earlier slot landed first"));
    const drifted = [history[0]!, { path, bytes: Buffer.concat([history[1]!.bytes, Buffer.from("\n")]) }];
    expect(() => assertNativeStoreForward(value, next.path, Buffer.from(candidate), drifted))
      .toThrow(new Error("reviewed native store requires every earlier slot landed first"));

    const unrelated = "db/platform/migrations/20261124133000_fixture_history.sql";
    for (const statement of [render(replace), `ALTER FUNCTION ${replace.signature} COST 10;`]) {
      const sources = [...history, { path: unrelated, bytes: Buffer.from(statement) }];
      expect(() => assertNativeStoreForward(value, next.path, Buffer.from(candidate), sources))
        .toThrow(`unsupported preceding function DDL in ${unrelated} for public.fixture_existing`);
    }
  });

  it.each([
    ["a search path without a final pg_temp", [{ ...settings[0]!, searchPath: "pg_temp, pg_catalog" }], /search_path ending in pg_temp/u],
    ["an earlier pg_temp before the final pg_temp", [{ ...settings[0]!, searchPath: "pg_temp, pg_catalog, pg_temp" }], /search_path ending in pg_temp/u],
    ["a duplicate signature", [settings[0]!, { ...settings[0]!, searchPath: "pg_temp" }], /duplicate signatures/u],
    ["an unqualified signature", [{ ...settings[0]!, signature: "fixture_grant(text[])" }], /canonical qualified signatures/u],
  ] as const)("refuses %s in the registry reader", (_label, functions, message) => {
    expect(() => readReviewedForwardRegistry(encode(valueFor(text, [...functions])))).toThrow(message);
  });

  it.each([
    { createdFunctions: [settings[0]!] },
    { replacedFunctions: [{ ...settings[0]!, beforeSha256: sqlSha256(before) }] },
    { grantOnlyFunctions: [{ signature: settings[0]!.signature, grantTo: ["authenticated"], revokeFrom: [] }] },
    { dataStatements: ["DELETE FROM public.fixture_row;"] },
  ])("refuses a non-empty ordinary list in a settings-only slot (%j)", lists => {
    const value = valueFor();
    Object.assign(value.nativeStoreForwardClass!.slots[0]!, lists);
    expect(() => readReviewedForwardRegistry(encode(value))).toThrow("settings-only slot requires empty function definition, grant and data lists");
  });

  it("refuses to reserve an unknown settings target without SQL", () => {
    nativeGitFixture(({ folder, put, commit }) => {
      const functions = [{ signature: "public.fixture_missing()", searchPath: "pg_catalog, pg_temp" }];
      const value = valueFor(render(functions[0]!), functions);
      value.nativeStoreForwards = [];
      put(PLATFORM_BASELINE_FILE, before);
      put("config/reviewed-platform-forwards.json", encode({ ...value, nativeStoreForwardClass: { sealed: true, slots: [] } }));
      const base = commit();
      put("config/reviewed-platform-forwards.json", encode(value));
      const head = commit();
      expect(() => assertCoLocatedForwardApproval(folder, base, head))
        .toThrow("settings-only function absent from base migrations: public.fixture_missing()");
    });
  });

  it.each([false, true])("refuses an unknown function introduced with the SQL (previously reserved slot: %s)", (reserved) => {
    nativeGitFixture(({ folder, put, commit }) => {
      const functions = [{ signature: "public.fixture_missing()", searchPath: "pg_catalog, pg_temp" }];
      const candidate = functions.map(render).join("\n");
      const value = valueFor(candidate, functions);
      const prior = structuredClone(value);
      if (!reserved) prior.nativeStoreForwardClass!.slots = [];
      prior.nativeStoreForwards = [];
      put(PLATFORM_BASELINE_FILE, before);
      put("config/reviewed-platform-forwards.json", encode(prior));
      const base = commit();
      put("db/platform/migrations/20261124120000_fixture_create.sql", "CREATE FUNCTION public.fixture_missing() RETURNS integer LANGUAGE sql AS $$ SELECT 1; $$;");
      put("config/reviewed-platform-forwards.json", encode(value));
      put(path, candidate);
      const head = commit();
      const message = "settings-only function absent from base migrations: public.fixture_missing()";
      expect(() => assertAdmittedPlatformForward(folder, base, head, path, Buffer.from(candidate))).toThrow(message);
      expect(() => assertAdmittedPlatformForward(folder, base, head, path, Buffer.from(candidate), true)).toThrow(message);
      expect(() => assertNativeStoreForward(value, path, Buffer.from(candidate), prefix)).toThrow(message);
    });
  });

  it("refuses a whole-file hash mismatch", () => {
    expect(() => assertNativeStoreForward(valueFor(), path, Buffer.from(text + "\n"), prefix)).toThrow(/path or file hash drifted/u);
  });
});

describe("parameterized native Git history", () => {
  it.each(["20271106100000", "20271105100000"])("refuses a registry-only new slot at or before the latest qualified base time: %s", time => {
    nativeGitFixture(({ folder, put, commit }) => {
      const value = registry(); value.nativeStoreForwardClass = { sealed: true, slots: [] };
      put(PLATFORM_BASELINE_FILE, before); put("db/platform/migrations/q2_20271106100000_latest.sql", "CREATE TABLE public.latest (id uuid);"); put("config/reviewed-platform-forwards.json", encode(value)); const base = commit();
      value.nativeStoreForwardClass.slots.push(emptySlot(`db/platform/migrations/${time}_future.sql`)); put("config/reviewed-platform-forwards.json", encode(value)); const head = commit();
      expect(() => assertCoLocatedForwardApproval(folder, base, head)).toThrow("reviewed native store new slot time must be later than every base migration");
    });
  });
  it("routes new timestamps through source, group and release and preserves issued SQL after sealed appends", () => {
    nativeGitFixture(({ folder, git, put, commit }) => {
      const value = registry(); value.nativeStoreForwardClass = { sealed: true, slots: [] };
      put(PLATFORM_BASELINE_FILE, before); put("config/reviewed-platform-forwards.json", encode(value)); const base = commit();
      const path = "db/platform/migrations/20271106100000_future.sql", text = "CREATE TABLE public.future (id uuid);";
      value.nativeStoreForwardClass.slots.push(emptySlot(path)); value.nativeStoreForwards!.push({ path, sha256: sqlSha256(text), functions: [] });
      put(path, text); put("config/reviewed-platform-forwards.json", encode(value)); const head = commit();
      expect(() => assertAdmittedPlatformForward(folder, base, head, path, Buffer.from(text))).not.toThrow();
      const group = git("commit-tree", git("rev-parse", `${head}^{tree}`), "-p", base, "-p", head, "-m", "Synthetic parameter group");
      expect(() => assertCoLocatedForwardApproval(folder, base, group)).not.toThrow();
      value.nativeStoreForwardClass.slots.push(emptySlot("db/platform/migrations/20271107100000_later.sql", "Later")); put("config/reviewed-platform-forwards.json", encode(value)); const appended = commit();
      expect(() => assertCoLocatedForwardApproval(folder, head, appended)).not.toThrow();
      expect(() => assertReviewedPlatformForward(folder, base, appended, path, Buffer.from(text), true)).not.toThrow();
      value.nativeStoreForwardClass.slots[0]!.dataStatements = ["UPDATE public.future SET id=NULL;"]; put("config/reviewed-platform-forwards.json", encode(value)); const edited = commit();
      expect(() => assertCoLocatedForwardApproval(folder, appended, edited)).toThrow(/sealed slot prefix|issued bindings/u);
    });
  });
  it.each(["delete predecessor", "insert predecessor", "reorder predecessor"])("preserves an issued slot's unsealed array position: %s", attack => {
    nativeGitFixture(({ folder, put, commit }) => {
      const prior = registry(), a = emptySlot("db/platform/migrations/20271106100000_reserved.sql", "Reserved"), b = emptySlot("db/platform/migrations/20271106110000_issued.sql", "Issued");
      const text = "CREATE TABLE public.issued_position (id uuid);";
      prior.nativeStoreForwardClass = { sealed: false, slots: [a, b] }; prior.nativeStoreForwards = [{ path: b.path, sha256: sqlSha256(text), functions: [] }];
      expect(() => assertNativeStoreForward(prior, b.path, Buffer.from(text), [{ path: PLATFORM_BASELINE_FILE, bytes: before }])).toThrow("reviewed native store requires every earlier slot landed first");
      put(PLATFORM_BASELINE_FILE, before); put("config/reviewed-platform-forwards.json", encode(prior)); const base = commit();
      const next = structuredClone(prior);
      if (attack === "delete predecessor") next.nativeStoreForwardClass!.slots.shift();
      else if (attack === "insert predecessor") next.nativeStoreForwardClass!.slots.unshift(emptySlot("db/platform/migrations/20271106090000_inserted.sql", "Inserted"));
      else { next.nativeStoreForwardClass!.slots[0] = { ...a, path: "db/platform/migrations/20271106120000_reserved.sql" }; next.nativeStoreForwardClass!.slots.reverse(); }
      expect(() => readReviewedForwardRegistry(encode(next))).not.toThrow();
      expect(() => changedForwardApprovals(encode(prior), encode(next))).toThrow("reviewed native store issued bindings and slots are immutable");
      put("config/reviewed-platform-forwards.json", encode(next)); put(b.path, text); const head = commit();
      expect(() => assertCoLocatedForwardApproval(folder, base, head)).toThrow("reviewed native store issued bindings and slots are immutable");
    });
  });
  it("freezes sealed unissued reservations and refuses every way to unseal or edit the old prefix", () => {
    const prior = registry(); prior.nativeStoreForwardClass!.sealed = true;
    for (const mutation of ["unseal", "edit", "remove", "insert"]) {
      const next = structuredClone(prior);
      if (mutation === "unseal") next.nativeStoreForwardClass!.sealed = false;
      if (mutation === "edit") next.nativeStoreForwardClass!.slots[0]!.row = "Edited";
      if (mutation === "remove") next.nativeStoreForwardClass!.slots.pop();
      if (mutation === "insert") next.nativeStoreForwardClass!.slots.unshift(emptySlot("db/platform/migrations/20261101221900_inserted.sql", "Inserted"));
      expect(() => changedForwardApprovals(encode(prior), encode(next))).toThrow("reviewed native store sealed slot prefix is immutable and cannot be unsealed");
    }
  });
  it("keeps static preimages distinct from a DO-patched installed body", () => {
    const patch = "DO $$ BEGIN EXECUTE $patch$CREATE OR REPLACE FUNCTION public.fixture_existing(p_id uuid) RETURNS text LANGUAGE sql SECURITY INVOKER SET search_path = pg_catalog AS $body$ SELECT 'patched'; $body$;$patch$; END; $$;";
    expect(() => parameterForward("", () => {}, patch)).not.toThrow();
  });
});

// Main lands A; a feature adds X1 and X2 in one commit; main then lands an unrelated Y; the feature's landing
// merge places Y before X1 and X2. Release reads the feature's own first-parent history.
type LandingContext = { folder: string; git: (...args: string[]) => string; put: (path: string, bytes: string | Buffer) => void; issued: string; feature: string; moved: string; merged: ReviewedForwardRegistry; text: Record<string, string>; land: (registry: ReviewedForwardRegistry | Buffer) => string };
function landingFixture(run: (context: LandingContext) => void) {
  nativeGitFixture(({ folder, git, put, commit }) => {
    const [a, y, x1, x2] = ["a_issued", "y_moved", "x1_candidate", "x2_candidate"].map((name, index) => emptySlot(`db/platform/migrations/2027110610${index}000_${name}.sql`, name.toUpperCase()));
    const text = Object.fromEntries([a, y, x1, x2].map(slot => [slot.path, `CREATE TABLE public.${slot.row.toLowerCase()} (id uuid);`]));
    const value = (slots: NativeStoreSlot[]) => { const result = registry(); result.nativeStoreForwardClass = { sealed: false, slots }; result.nativeStoreForwards = slots.map(slot => ({ path: slot.path, sha256: sqlSha256(text[slot.path]!), functions: [] })); return result; };
    const write = (slots: NativeStoreSlot[]) => { for (const slot of slots) put(slot.path, text[slot.path]!); put("config/reviewed-platform-forwards.json", encode(value(slots))); };
    put(PLATFORM_BASELINE_FILE, before); write([a]); const issued = commit();
    write([a, x1, x2]); const feature = commit();
    git("reset", "-q", "--hard", issued); write([a, y]); const moved = commit();
    write([a, y, x1, x2]);
    const land = (data: ReviewedForwardRegistry | Buffer) => {
      put("config/reviewed-platform-forwards.json", Buffer.isBuffer(data) ? data : encode(data)); git("add", ".");
      return git("commit-tree", git("write-tree"), "-p", feature, "-p", moved, "-m", "Synthetic landing merge");
    };
    run({ folder, git, put, issued, feature, moved, merged: value([a, y, x1, x2]), text, land });
  });
}
const separately = "reviewed replacement allowlist must be approved separately before a feature PR adds SQL";
describe("release approval binding across a landing merge", () => {
  // Six history checks: measured at most 3.5 s alone at load average 15; the bound is four times that.
  it("admits the candidate's unchanged approvals after main's unrelated slot moved them", () => {
    landingFixture(({ folder, git, issued, feature, moved, merged, text, land }) => {
      const landing = land(merged), mainline = git("commit-tree", `${landing}^{tree}`, "-p", moved, "-p", landing, "-m", "Synthetic mainline merge");
      for (const pin of merged.nativeStoreForwards!.slice(2)) {
        expect(() => assertUnchangedForwardApproval(folder, feature, landing, pin.path)).not.toThrow();
        for (const head of [landing, mainline]) expect(() => assertReviewedPlatformForward(folder, issued, head, pin.path, Buffer.from(text[pin.path]!), true)).not.toThrow();
      }
    });
  }, 14_000);
  it.each(["candidate pin", "candidate slot"])("refuses a changed %s", change => {
    landingFixture(({ folder, put, issued, feature, merged, text, land }) => {
      const path = merged.nativeStoreForwards![2]!.path;
      if (change === "candidate pin") { text[path] = `${text[path]}\nCREATE INDEX x1_lookup ON public.x1_candidate (id);`; put(path, text[path]!); merged.nativeStoreForwards![2]!.sha256 = sqlSha256(text[path]!); }
      else merged.nativeStoreForwardClass!.slots[2]!.dataStatements = ["DELETE FROM public.x1_candidate;"];
      const landing = land(merged);
      expect(() => assertUnchangedForwardApproval(folder, feature, landing, path)).toThrow(separately);
      expect(() => assertReviewedPlatformForward(folder, issued, landing, path, Buffer.from(text[path]!), true)).toThrow(separately);
    });
  });
  it.each(["an unknown registry key", "an unknown pin key", "a malformed registry"])("refuses %s", change => {
    landingFixture(({ folder, feature, merged, land }) => {
      const path = merged.nativeStoreForwards![2]!.path;
      if (change === "an unknown registry key") Object.assign(merged, { unreviewedForwards: [] });
      if (change === "an unknown pin key") Object.assign(merged.nativeStoreForwards![2]!, { note: "unreviewed" });
      const landing = land(change === "a malformed registry" ? encode(merged).subarray(1) : merged);
      expect(() => assertUnchangedForwardApproval(folder, feature, landing, path)).toThrow(separately);
    });
  });
  it.each(["an edited issued pin", "an edited issued slot", "a slot inserted before the issued one"])("refuses %s", change => {
    landingFixture(({ folder, put, feature, merged, text, land }) => {
      const path = merged.nativeStoreForwards![2]!.path, issuedPin = merged.nativeStoreForwards![0]!;
      if (change === "an edited issued pin") { text[issuedPin.path] = `${text[issuedPin.path]} `; put(issuedPin.path, text[issuedPin.path]!); issuedPin.sha256 = sqlSha256(text[issuedPin.path]!); }
      if (change === "an edited issued slot") merged.nativeStoreForwardClass!.slots[0]!.dataStatements = ["DELETE FROM public.a_issued;"];
      if (change === "a slot inserted before the issued one") merged.nativeStoreForwardClass!.slots.unshift(emptySlot("db/platform/migrations/20271106090000_inserted.sql", "Inserted"));
      expect(() => readReviewedForwardRegistry(encode(merged))).not.toThrow();
      expect(() => assertUnchangedForwardApproval(folder, feature, land(merged), path)).toThrow(separately);
    });
  });
  it("refuses a later forward when an earlier unissued forward's slot and pin are removed", () => {
    landingFixture(({ folder, feature, merged, land }) => {
      const removed = merged.nativeStoreForwards![2]!.path, path = merged.nativeStoreForwards![3]!.path;
      merged.nativeStoreForwards!.splice(2, 1); merged.nativeStoreForwardClass!.slots.splice(2, 1);
      expect(() => readReviewedForwardRegistry(encode(merged))).not.toThrow();
      const landing = land(merged);
      expect(() => assertUnchangedForwardApproval(folder, feature, landing, removed)).toThrow(separately);
      expect(() => assertUnchangedForwardApproval(folder, feature, landing, path)).toThrow(separately);
    });
  });
  it("keeps the regular-file refusal for a non-regular registry", () => {
    landingFixture(({ folder, git, feature, merged }) => {
      const registryPath = resolve(folder, "config/reviewed-platform-forwards.json");
      writeFileSync(resolve(folder, "config/forwards.json"), encode(merged)); rmSync(registryPath); symlinkSync("forwards.json", registryPath); git("add", "-A");
      const linked = git("commit-tree", git("write-tree"), "-p", feature, "-m", "Synthetic non-regular registry");
      expect(() => assertUnchangedForwardApproval(folder, feature, linked, merged.nativeStoreForwards![2]!.path)).toThrow("reviewed replacement requires a regular file: config/reviewed-platform-forwards.json");
    });
  });
});

const triggerFunction = "CREATE FUNCTION public.fixture_trigger_guard() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$ BEGIN RETURN NEW; END; $$;";
const triggerRevoke = "REVOKE ALL ON FUNCTION public.fixture_trigger_guard() FROM PUBLIC;";
const triggerBefore = "CREATE TRIGGER fixture_trigger_guard BEFORE INSERT OR DELETE OR UPDATE OF id, extra ON public.fixture_parameters FOR EACH ROW EXECUTE FUNCTION public.fixture_trigger_guard();";
const triggerAfter = "CREATE TRIGGER fixture_trigger_event AFTER INSERT ON public.fixture_row FOR EACH ROW EXECUTE FUNCTION public.fixture_trigger_guard();";
function triggerForward(statement = triggerBefore, extra = "", configure?: (slot: NativeStoreSlot) => void, history = "", definition = triggerFunction) {
  parameterForward(`${definition}\n${triggerRevoke}\n${statement}\n${extra}`, slot => {
    slot.createdFunctions.push({ signature: "public.fixture_trigger_guard()", searchPath: "pg_catalog, pg_temp" });
    slot.createdTriggers = [{ name: "fixture_trigger_guard", table: "public.fixture_parameters", sha256: sqlSha256(statement) }];
    configure?.(slot);
  }, history);
}

describe("closed created row triggers on prefix tables", () => {
  it("refuses conditional prefix function drops for ordinary and deferred triggers", () => {
    const deferred = triggerBefore.replace("CREATE TRIGGER fixture_trigger_guard BEFORE INSERT OR DELETE OR UPDATE OF id, extra", "CREATE CONSTRAINT TRIGGER fixture_trigger_guard AFTER INSERT")
      .replace("FOR EACH ROW", "DEFERRABLE INITIALLY DEFERRED FOR EACH ROW");
    const histories = [
      ["DROP FUNCTION IF EXISTS public.fixture_retired_guard();", "public.fixture_retired_guard"],
      ["DROP FUNCTION IF EXISTS public.other(), public.fixture_existing(uuid);", "public.fixture_existing"],
    ] as const;
    for (const [history, target] of histories) {
      for (const statement of [triggerBefore, deferred]) expect(() => triggerForward(statement, "", slot => {
        if (statement === deferred) slot.createdTriggers = [{ name: "fixture_trigger_guard", relation: "public.fixture_parameters",
          events: ["INSERT"], function: "public.fixture_trigger_guard()", sha256: sqlSha256(deferred), deferred: true }];
      }, history)).toThrow(`reviewed native store unsupported preceding function DDL in db/platform/migrations/20261031120000_parameter_history.sql for ${target}`);
    }
  });
  it("admits both guarded existing-table trigger shapes with PUBLIC and conditional revokes", () => {
    const revokes = ["anon", "authenticated", "service_role"].map(role => block(role, "REVOKE ALL", "public.fixture_trigger_guard()")).join("\n");
    expect(() => triggerForward(triggerBefore, `${triggerAfter}\n${revokes}`, slot => {
      slot.createdTriggers!.push({ name: "fixture_trigger_event", table: "public.fixture_row", sha256: sqlSha256(triggerAfter) });
    })).not.toThrow();
  });
  it.each([
    ["WHEN", triggerBefore.replace("FOR EACH ROW EXECUTE", "FOR EACH ROW WHEN (true) EXECUTE")],
    ["FOR EACH STATEMENT", triggerBefore.replace("FOR EACH ROW", "FOR EACH STATEMENT")],
    ["INSTEAD OF", triggerBefore.replace("BEFORE", "INSTEAD OF")],
    ["REFERENCING", triggerBefore.replace("FOR EACH ROW", "REFERENCING NEW TABLE AS new_rows FOR EACH ROW")],
    ["TRUNCATE event", triggerBefore.replace("INSERT OR DELETE OR UPDATE OF id, extra", "TRUNCATE")],
    ["function arguments", triggerBefore.replace("fixture_trigger_guard();", "fixture_trigger_guard('argument');")],
  ])("refuses %s even with a fresh statement hash", (_label, statement) => {
    expect(() => triggerForward(statement)).toThrow("reviewed native store created trigger shape refused");
  });
  it("refuses an existing trigger function outside the slot", () => {
    const statement = triggerBefore.replace("EXECUTE FUNCTION public.fixture_trigger_guard()", "EXECUTE FUNCTION public.fixture_external_trigger()");
    const history = triggerFunction.replace("fixture_trigger_guard", "fixture_external_trigger");
    expect(() => triggerForward(statement, "", undefined, history)).toThrow("reviewed native store created trigger requires a same-slot created function");
  });
  it("refuses a function created by an earlier slot", () => {
    const value = registry(), first = sql(), firstPin = bind(value, 0, first);
    const statement = triggerBefore.replace("public.fixture_trigger_guard()", "public.fixture_created_1()");
    const text = `${sql(1)}\n${statement}`;
    value.nativeStoreForwardClass!.slots[1]!.createdTriggers = [{ name: "fixture_trigger_guard", table: "public.fixture_parameters", sha256: sqlSha256(statement) }];
    const pin = bind(value, 1, text);
    expect(() => assertNativeStoreForward(value, pin.path, Buffer.from(text), [{ path: PLATFORM_BASELINE_FILE, bytes: Buffer.concat([before, Buffer.from(`\n${parameterTable}`)]) }, { path: firstPin.path, bytes: Buffer.from(first) }])).toThrow("reviewed native store created trigger requires a same-slot created function");
  });
  it.each([
    ["SECURITY DEFINER", triggerFunction.replace("SECURITY INVOKER", "SECURITY DEFINER")],
    ["implicit invoker", triggerFunction.replace(" SECURITY INVOKER", "")],
    ["non-trigger return", triggerFunction.replace("RETURNS trigger", "RETURNS text")],
  ])("refuses a trigger function with %s", (_label, definition) => {
    expect(() => triggerForward(triggerBefore, "", undefined, "", definition)).toThrow("reviewed native store trigger function requires RETURNS trigger, SECURITY INVOKER and pinned search_path");
  });
  it("requires a pinned trigger-function search_path and its PUBLIC revoke", () => {
    expect(() => triggerForward(triggerBefore, "", slot => { slot.createdFunctions.at(-1)!.searchPath = null; }, "", triggerFunction.replace(" SET search_path = pg_catalog, pg_temp", ""))).toThrow("reviewed native store trigger function requires RETURNS trigger, SECURITY INVOKER and pinned search_path");
    expect(() => parameterForward(`${triggerFunction}\n${triggerBefore}`, slot => {
      slot.createdFunctions.push({ signature: "public.fixture_trigger_guard()", searchPath: "pg_catalog, pg_temp" });
      slot.createdTriggers = [{ name: "fixture_trigger_guard", table: "public.fixture_parameters", sha256: sqlSha256(triggerBefore) }];
    })).toThrow("reviewed native store created function missing PUBLIC revoke");
  });
  it.each(["PUBLIC", "authenticated", "service_role"])("refuses a trigger-function GRANT EXECUTE to %s", role => {
    expect(() => triggerForward(triggerBefore, `GRANT EXECUTE ON FUNCTION public.fixture_trigger_guard() TO ${role};`)).toThrow("reviewed native store trigger function GRANT EXECUTE refused");
  });
  it("refuses a guarded trigger-function GRANT EXECUTE", () => {
    expect(() => triggerForward(triggerBefore, block("service_role", "GRANT EXECUTE", "public.fixture_trigger_guard()"))).toThrow("reviewed native store trigger function GRANT EXECUTE refused");
  });
  it("refuses unlisted, duplicate, missing and hash-drifted trigger statements", () => {
    const error = "reviewed native store unlisted, duplicate or drifted trigger statement";
    expect(() => triggerForward(triggerBefore, "", slot => { delete slot.createdTriggers; })).toThrow(error);
    expect(() => triggerForward(triggerBefore, triggerBefore)).toThrow(error);
    expect(() => triggerForward(triggerBefore, "", slot => { slot.createdTriggers![0]!.sha256 = "0".repeat(64); })).toThrow(error);
    expect(() => triggerForward("", "", slot => { slot.createdTriggers![0]!.sha256 = sqlSha256(triggerBefore); })).toThrow("reviewed native store created trigger statement missing");
  });
  it.each([
    "DROP TRIGGER fixture_trigger_guard ON public.fixture_parameters;",
    "ALTER TRIGGER fixture_trigger_guard ON public.fixture_parameters RENAME TO fixture_renamed;",
    "ALTER TABLE public.fixture_parameters ENABLE TRIGGER fixture_trigger_guard;",
    "ALTER TABLE public.fixture_parameters DISABLE TRIGGER fixture_trigger_guard;",
    "ALTER TABLE public.fixture_parameters ENABLE ALWAYS TRIGGER fixture_trigger_guard;",
    "ALTER TABLE public.fixture_parameters ENABLE REPLICA TRIGGER fixture_trigger_guard;",
  ])("refuses trigger mutation: %s", statement => {
    expect(() => triggerForward(triggerBefore, statement)).toThrow("reviewed native store trigger mutation refused");
  });
  it("keeps slot trigger names unique across relations", () => {
    const second = triggerAfter.replace("fixture_trigger_event", "fixture_trigger_guard");
    expect(() => triggerForward(triggerBefore, second, slot => { slot.createdTriggers!.push({
      name: "fixture_trigger_guard", table: "public.fixture_row", sha256: sqlSha256(second),
    }); })).toThrow("reviewed native store invalid created trigger inventory");
  });
  it("validates only the three trigger entry fields and unique names", () => {
    for (const entry of [{ name: "bad name", table: "public.fixture_parameters", sha256: sqlSha256(triggerBefore) }, { name: "fixture_trigger_guard", table: "app.fixture_parameters", sha256: sqlSha256(triggerBefore) }, { name: "fixture_trigger_guard", table: "public.fixture_parameters", sha256: "bad" }, { name: "fixture_trigger_guard", table: "public.fixture_parameters", sha256: sqlSha256(triggerBefore), extra: true }]) {
      expect(() => triggerForward(triggerBefore, "", slot => { slot.createdTriggers = [entry]; })).toThrow("reviewed native store invalid created trigger inventory");
    }
    expect(() => triggerForward(triggerBefore, "", slot => { slot.createdTriggers!.push({ ...slot.createdTriggers![0]! }); })).toThrow("reviewed native store invalid created trigger inventory");
  });
});

describe("token-bound native SQL identities", () => {
  it("resolves quoted and commented identities in the slot's own CHECK pair", () => {
    const sql = parameterCheck().replaceAll("ALTER TABLE public.fixture_parameters", 'ALTER/* gap */TABLE "public" . "fixture_parameters"').replaceAll("CONSTRAINT fixture_status", 'CONSTRAINT /* name */ "fixture_status"');
    expect(() => parameterForward(sql, addCheck)).not.toThrow();
  });
  it("resolves both trigger shapes through keyword comments and qualified-name whitespace", () => {
    const statement = triggerBefore.replace("CREATE TRIGGER", "CREATE/* gap */TRIGGER").replace("ON public.fixture_parameters", 'ON "public" /* schema */ . "fixture_parameters"').replace("FUNCTION public.fixture_trigger_guard", 'FUNCTION "public" . "fixture_trigger_guard"');
    expect(() => triggerForward(statement)).not.toThrow();
    expect(() => triggerForward(triggerBefore, 'ALTER\nTABLE "public" . "fixture_parameters" DISABLE/* gap */TRIGGER fixture_trigger_guard;')).toThrow("reviewed native store trigger mutation refused");
  });
  it("resolves view revokes and refuses view grants using token identities", () => {
    const create = 'CREATE/* gap */VIEW "public" . "fixture_parameter_view" AS SELECT id FROM public.fixture_parameters;';
    const revoke = 'REVOKE/* gap */ALL ON TABLE "public" . "fixture_parameter_view" FROM PUBLIC;';
    const entry = (slot: NativeStoreSlot) => { slot.createdViews = [{ name: "public.fixture_parameter_view", sha256: sqlSha256(create) }]; };
    expect(() => parameterForward(`${create}\n${revoke}`, entry)).not.toThrow();
    expect(() => parameterForward(`${create}\n${revoke}\nGRANT SELECT ON TABLE public /* schema */ . fixture_parameter_view TO service_role;`, entry)).toThrow("reviewed native store created view GRANT refused");
  });
  it("does not let a commented or spaced existing-table ADD bypass the exact list", () => {
    expect(() => parameterForward('ALTER/* gap */TABLE "public" . "fixture_parameters" ADD COLUMN unlisted text;', slot => { slot.existingTableStatements = ["ALTER TABLE public.fixture_parameters ADD COLUMN listed text;"]; })).toThrow("reviewed native store existing-table statement unlisted, duplicate or out of order");
  });
  it("detects a preceding function identity through schema whitespace", () => {
    expect(() => parameterForward("", () => {}, 'ALTER/* gap */FUNCTION "public" . "fixture_existing"(uuid) SET search_path=public;')).toThrow("reviewed native store unsupported preceding function DDL");
  });
});

it.each(["pull_request", "merge_group"])("routes prepared later SQL plus a catalog change through the unchanged %s queue expression", async eventName => {
  mkdirSync(".context/scratch", { recursive: true }); const folder = mkdtempSync(resolve(".context/scratch/prepared-native-queue-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", folder, "-c", "user.name=Control Test", "-c", "user.email=control@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
  const put = (path: string, bytes: Buffer | string) => { mkdirSync(dirname(resolve(folder, path)), { recursive: true }); writeFileSync(resolve(folder, path), bytes); };
  const commit = () => { git("add", "."); git("commit", "-qm", "Synthetic prepared native slot"); return git("rev-parse", "HEAD"); };
  try {
    git("init", "-q", "-b", "main"); const value = registry(), path = "db/platform/migrations/20271106100000_prepared.sql", text = "CREATE TABLE public.prepared (id uuid);";
    value.nativeStoreForwardClass = { sealed: false, slots: [emptySlot(path)] }; value.nativeStoreForwards = [{ path, sha256: sqlSha256(text), functions: [] }];
    put("config/reviewed-platform-forwards.json", encode(value)); put(PLATFORM_BASELINE_FILE, before); const base = commit(); git("update-ref", "refs/remotes/origin/main", base);
    put(path, text); put("tests/postgres/nativeStoreForwardCatalog.shared.ts", "// Changed observer"); const head = commit();
    expect(isNativeStoreMigrationPath(path)).toBe(true);
    expect(isNativeStoreMigrationPath(path, value.nativeStoreForwardClass.slots)).toBe(true);
    const candidate = await captureCommittedReviewCandidate(folder, base, head);
    let session = prepareCandidate(null, { ...candidate, intent: { risk: "behavior", criteria: "Prepared native slot machinery refusal" }, authorSessionId: "prepared-author" }, 1000);
    for (const reviewer of ["prepared-reviewer-a", "prepared-reviewer-b"]) session = recordReport(session, { reviewer, cold: true, tree: candidate.tree, verdict: "PASS", findings: [], closes: [], documentation: "Synthetic prepared-slot queue boundary." }, 1000);
    const receipt = receiptSummary(session, 12, 1000), merged = git("commit-tree", candidate.tree, "-p", base, "-p", head, "-m", "Synthetic prepared group"), ref = `refs/heads/gh-readonly-queue/main/pr-12-${base}`;
    const event = { number: 12, repository: { private: false }, action: "checks_requested", pull_request: { head: { sha: head } }, merge_group: { base_ref: "refs/heads/main", head_ref: ref, base_sha: base, head_sha: merged } };
    const env = { GITHUB_REPOSITORY: "openlup/openlup", GITHUB_EVENT_NAME: eventName, GITHUB_SHA: merged, GITHUB_REF: ref };
    const api = { get: async (path: string) => path.includes("/pulls/") ? { number: 12, state: "open", draft: false, base: { ref: "main" }, head: { sha: head } } : path.includes("/issues/") ? [{ id: 1, user: { login: "fixture-owner", type: "User" }, body: `${RECEIPT_MARKER}\n\`\`\`json\n${JSON.stringify(receipt)}\n\`\`\`` }] : path.includes("/collaborators/") ? { permission: "write" } : { object: { sha: base } } };
    const runGit = (cwd: string, ...args: string[]) => args.includes("fetch") ? Promise.resolve("") : reviewGit(cwd, ...args);
    await expect(waitNativeAdmission({ cwd: folder, event, env, api, runGit, now: () => 1000, deadlineMs: 1 })).rejects.toThrow("reviewed replacement admission machinery must be approved separately before co-located SQL/pins");
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

it("routes later paths conservatively while admitting an ordinary unregistered expand-only migration", () => {
  nativeGitFixture(({ folder, put, commit }) => {
    const value = registry(), path = "db/platform/migrations/20271106100000_unregistered.sql", text = "CREATE TABLE public.unregistered (id uuid);";
    put("config/reviewed-platform-forwards.json", encode(value)); put(PLATFORM_BASELINE_FILE, before); const base = commit();
    put(path, text); put("tests/postgres/nativeStoreForwardCatalog.shared.ts", "// Ordinary additive test change"); const head = commit();
    expect(isNativeStoreMigrationPath(path)).toBe(true); expect(isNativeStoreMigrationPath(path, value.nativeStoreForwardClass!.slots)).toBe(false);
    expect(isNativeStoreMigrationPath("db/platform/migrations/20261101221999_earlier.sql")).toBe(false);
    expect(isNativeStoreMigrationPath("supabase/migrations/20271106100000_other.sql")).toBe(false);
    expect(isNativeStoreMigrationPath("db/platform/migrations/20271106100000_UPPER-extra.sql")).toBe(true);
    expect(() => assertCoLocatedForwardApproval(folder, base, head)).not.toThrow();
    expect(() => assertAdmittedPlatformForward(folder, base, head, path, Buffer.from(text))).not.toThrow();
  });
});

it("keeps the complete issued slot and pin contents fixed without pinning later appends", () => {
  const canonical = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
  expect(sqlSha256(canonical(production.nativeStoreForwardClass!.slots.slice(0, 7)))).toBe("e045315db04e824b10dd7d1565d3d42b443fef72a433598e582b1ee46d5b4859");
  expect(sqlSha256(canonical(production.nativeStoreForwards!.slice(0, 7)))).toBe("7c8cc2e9a9735359a01384e4fcc34c84f45ae82fcf07f2f76f86123a290d8760");
});

it.each(production.nativeStoreForwardClass!.slots.slice(0, 7))("validates issued $row against the complete real prefix through Git objects", slot => {
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const paths = execFileSync("git", ["ls-tree", "-r", "--name-only", revision, "--", "db/platform/migrations/"], { encoding: "utf8" }).trim().split("\n").filter(path => /^db\/platform\/migrations\/\d{14}_[^/]+\.sql$/u.test(path) && path < slot.path);
  const bytes = (path: string) => execFileSync("git", ["show", `${revision}:${path}`]);
  expect(() => assertNativeStoreForward(production, slot.path, bytes(slot.path), paths.map(path => ({ path, bytes: bytes(path) })))).not.toThrow();
});

it.each([
  "ALTER TABLE IF EXISTS public.fixture_parameters ADD COLUMN another text;",
  "CREATE OR REPLACE VIEW public.fixture_parameter_view AS SELECT id FROM public.fixture_parameters;",
  "CREATE VIEW IF NOT EXISTS public.fixture_parameter_view AS SELECT id FROM public.fixture_parameters;",
  triggerBefore.replace("CREATE TRIGGER", "CREATE OR REPLACE TRIGGER"),
  triggerBefore.replace("CREATE TRIGGER", "CREATE TRIGGER IF NOT EXISTS"),
])("refuses non-plain object entries: %s", statement => {
  expect(() => parameterForward(statement, slot => {
    if (statement.startsWith("ALTER")) slot.existingTableStatements = [statement];
    else if (statement.includes("VIEW")) slot.createdViews = [{ name: "public.fixture_parameter_view", sha256: sqlSha256(statement) }];
    else slot.createdTriggers = [{ name: "fixture_trigger_guard", table: "public.fixture_parameters", sha256: sqlSha256(statement) }];
  })).toThrow(/reviewed native store/u);
});

it("checks new constraint pairs independently of historical SQL spelling or decoy anchors", () => {
  const history = String.raw`DO E'BEGIN\n PERFORM ''a\\b''; END;';
ALTER TABLE public.U&"fixtur\0065_parameters" ALTER COLUMN status SET DEFAULT 'closed';
CREATE TABLE public.fixture_parameters$anchor (id uuid, CONSTRAINT fixture_key UNIQUE (id));`;
  for (const [sql, configure] of [[parameterCheck(), addCheck], [parameterUnique, addUnique]] as const) expect(() => parameterForward(sql, configure, history)).not.toThrow();
});
it.each(["CHECK", "UNIQUE"])("requires exactly one complete listed %s replacement", kind => {
  const sql = kind === "CHECK" ? parameterCheck() : parameterUnique, configure = kind === "CHECK" ? addCheck : addUnique;
  expect(() => parameterForward("", configure)).toThrow(/complete named CHECK replacement/u);
  expect(() => parameterForward(sql.split("\n")[0]!, configure)).toThrow(/complete named CHECK replacement/u);
  expect(() => parameterForward(sql.split("\n")[1]!, configure)).toThrow(/must match/u);
  expect(() => parameterForward(`${sql}\n${sql}`, configure)).toThrow(/duplicate/u);
  expect(() => parameterForward(sql.replaceAll(kind === "CHECK" ? "fixture_status" : "fixture_key", "unlisted"), configure)).toThrow(/closed shapes/u);
  expect(() => parameterForward(sql, slot => { configure(slot); Object.assign((kind === "CHECK" ? slot.checkSupersets : slot.uniqueSupersets)![0]!, { beforeSha256: "0".repeat(64) }); })).toThrow(/invalid .* superset entry/u);
});


function replacementChain(count = 2) {
  const value = registry(), original = control.slots[0]!.replacedFunctions[0]!;
  const source = sqlStatements(before.toString()).find(statement => statement.startsWith("CREATE FUNCTION public.fixture_existing("))!;
  const statements = Array.from({ length: count }, (_, index) => source.replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION").replace("'before'", `'chain_${index}'`));
  value.nativeStoreForwardClass = { sealed: false, slots: control.slots.slice(0, count).map((slot, index) => ({
    row: slot.row, path: slot.path, replacedFunctions: [{ ...original, beforeSha256: index ? sqlSha256(statements[index - 1]!) : original.beforeSha256 }], createdFunctions: [], grantOnlyFunctions: [], dataStatements: [],
  })) };
  statements.forEach((statement, index) => bind(value, index, statement));
  const admit = (index = count - 1, history = "") => assertNativeStoreForward(value, value.nativeStoreForwardClass!.slots[index]!.path, Buffer.from(statements[index]!), [
    { path: PLATFORM_BASELINE_FILE, bytes: before },
    ...statements.slice(0, index).map((statement, index) => ({ path: value.nativeStoreForwardClass!.slots[index]!.path, bytes: Buffer.from(statement) })),
    ...history ? [{ path: "db/platform/migrations/20261101222500_chain_history.sql", bytes: Buffer.from(history) }] : [],
  ]);
  return { value, statements, admit };
}

describe("chained native replacements", () => {
  it("accepts a two-slot chain and uses the immediately preceding replacement in a three-slot chain", () => {
    const two = replacementChain(); expect(() => two.admit(0)).not.toThrow(); expect(() => two.admit()).not.toThrow();
    const three = replacementChain(3); expect(() => three.admit()).not.toThrow();
    three.value.nativeStoreForwardClass!.slots[2]!.replacedFunctions[0]!.beforeSha256 = sqlSha256(three.statements[0]!);
    bind(three.value, 2, three.statements[2]!);
    expect(() => three.admit()).toThrow("reviewed native store chained replacement before-hash differs from preceding after-hash");
  });
  it("refuses a before-hash differing from the preceding pin", () => {
    const chain = replacementChain(); chain.value.nativeStoreForwardClass!.slots[1]!.replacedFunctions[0]!.beforeSha256 = "0".repeat(64); bind(chain.value, 1, chain.statements[1]!);
    expect(() => chain.admit()).toThrow("reviewed native store chained replacement before-hash differs from preceding after-hash");
  });
  it("refuses an actual prefix definition differing from a valid pin chain", () => {
    const chain = replacementChain();
    expect(() => chain.admit(1, chain.statements[0]!.replace("'chain_0'", "'intervening'"))).toThrow("reviewed native store actual base function before-hash drifted");
  });
  it.each(["reversed slots", "earlier time"])("refuses %s", attack => {
    const chain = replacementChain(), slots = chain.value.nativeStoreForwardClass!.slots;
    if (attack === "reversed slots") slots.reverse();
    else slots[1]!.path = slots[1]!.path.replace("20261101223000", "20261101221000");
    expect(() => readReviewedForwardRegistry(encode(chain.value))).toThrow("reviewed native store slot path, row or order drifted");
  });
  it.each([2, 3])("refuses chaining onto an unpinned predecessor in %i slots", count => {
    const chain = replacementChain(count); chain.value.nativeStoreForwards!.splice(count - 2, 1);
    expect(() => chain.admit()).toThrow("reviewed native store chained replacement requires a bound predecessor");
  });
  it("still requires the predecessor SQL to have landed", () => {
    const chain = replacementChain();
    expect(() => assertNativeStoreForward(chain.value, chain.value.nativeStoreForwardClass!.slots[1]!.path, Buffer.from(chain.statements[1]!), [{ path: PLATFORM_BASELINE_FILE, bytes: before }])).toThrow("reviewed native store requires every earlier slot landed first");
  });
  it("preserves replacement headers even when the new forward is repinned", () => {
    const chain = replacementChain(); chain.statements[1] = chain.statements[1]!.replace("LANGUAGE sql", "LANGUAGE sql STABLE"); bind(chain.value, 1, chain.statements[1]!);
    expect(() => chain.admit()).toThrow("reviewed native store replacement header drifted");
  });
  it("admits both hosted entry points and freezes an issued slot in the chain through Git objects", () => {
    nativeGitFixture(({ folder, put, commit }) => {
      const chain = replacementChain(), prior = structuredClone(chain.value); prior.nativeStoreForwardClass!.slots.pop(); prior.nativeStoreForwards!.pop();
      put(PLATFORM_BASELINE_FILE, before); put(prior.nativeStoreForwardClass!.slots[0]!.path, chain.statements[0]!); put("config/reviewed-platform-forwards.json", encode(prior)); const base = commit();
      const path = chain.value.nativeStoreForwardClass!.slots[1]!.path;
      put(path, chain.statements[1]!); put("config/reviewed-platform-forwards.json", encode(chain.value)); const head = commit();
      expect(() => assertCoLocatedForwardApproval(folder, base, head)).not.toThrow();
      expect(() => assertAdmittedPlatformForward(folder, base, head, path, Buffer.from(chain.statements[1]!))).not.toThrow();
      chain.value.nativeStoreForwardClass!.slots[0]!.replacedFunctions[0]!.searchPath = "public";
      put("config/reviewed-platform-forwards.json", encode(chain.value)); const edited = commit();
      expect(() => assertCoLocatedForwardApproval(folder, head, edited)).toThrow("reviewed native store issued bindings and slots are immutable");
    });
  });
});


const dropIndexCreate = "CREATE UNIQUE INDEX fixture_active_idx ON public.fixture_parameters (id) WHERE status = 'open';";
const dropIndexSql = "DROP INDEX public.fixture_active_idx;";
const dropIndexEntry = { table: "public.fixture_parameters", name: "fixture_active_idx", beforeSha256: sqlSha256(dropIndexCreate) };
function indexDrop(text = dropIndexSql, source = dropIndexCreate, history = "", configure?: (slot: NativeStoreSlot) => void) {
  parameterForward(text, slot => { slot.droppedIndexes = [{ ...dropIndexEntry, beforeSha256: sqlSha256(source) }]; configure?.(slot); }, history, `${parameterTable}\n${source}`);
}
describe("closed native index drops", () => {
  it("admits a standalone partial unique index drop and non-unique replacement", () => {
    expect(() => indexDrop(`${dropIndexSql}\nCREATE INDEX fixture_replacement_idx ON public.fixture_parameters (id, extra DESC);`)).not.toThrow();
    expect(() => indexDrop(dropIndexSql, dropIndexCreate.replace("CREATE UNIQUE", "CREATE"))).not.toThrow();
  });
  it("admits several listed standalone drops once each without imposing an order", () => {
    const second = "CREATE INDEX fixture_second_idx ON public.fixture_parameters (extra);";
    expect(() => indexDrop(`DROP INDEX public.fixture_second_idx;\n${dropIndexSql}`, dropIndexCreate, second, slot => {
      slot.droppedIndexes![0]!.beforeSha256 = sqlSha256(dropIndexCreate);
      slot.droppedIndexes!.push({ ...dropIndexEntry, name: "fixture_second_idx", beforeSha256: sqlSha256(second) });
    })).not.toThrow();
  });
  it.each([
    "DROP INDEX IF EXISTS public.fixture_active_idx;", "DROP INDEX CONCURRENTLY public.fixture_active_idx;",
    "DROP INDEX public.fixture_active_idx CASCADE;", "DROP INDEX public.fixture_active_idx RESTRICT;",
    "DROP INDEX public.fixture_active_idx, public.other_idx;", "DROP INDEX fixture_active_idx;",
    'DROP INDEX "public"."fixture_active_idx";', 'DROP INDEX public."fixture_active_idx";',
    "DROP INDEX PUBLIC.fixture_active_idx;", "DROP INDEX public.FIXTURE_ACTIVE_IDX;", "drop index public.fixture_active_idx;",
    "DROP  INDEX public.fixture_active_idx;", "DROP\nINDEX public.fixture_active_idx;", "DROP INDEX public.fixture_active_idx ;",
    "DROP/* gap */INDEX public.fixture_active_idx;", "DROP INDEX public.fixture_active_idx_extra;", "DROP INDEX public.other_idx;",
  ])("refuses non-exact or unlisted drop text: %s", text => {
    expect(() => indexDrop(text)).toThrow("reviewed native store unlisted, duplicate or non-plain index drop");
  });
  it("refuses unlisted, repeated and missing drops", () => {
    expect(() => indexDrop(dropIndexSql, dropIndexCreate, "", slot => { delete slot.droppedIndexes; })).toThrow("reviewed native store unlisted, duplicate or non-plain index drop");
    expect(() => indexDrop(`${dropIndexSql}\n${dropIndexSql}`)).toThrow("reviewed native store unlisted, duplicate or non-plain index drop");
    expect(() => indexDrop("")).toThrow("reviewed native store listed index drop missing");
  });
  it("refuses a missing CREATE preimage", () => {
    expect(() => indexDrop(dropIndexSql, "")).toThrow("reviewed native store dropped index plain CREATE missing from prefix");
  });
  it.each([
    'CREATE UNIQUE INDEX "fixture_active_idx" ON public.fixture_parameters (id);',
    "CREATE UNIQUE INDEX public.fixture_active_idx ON public.fixture_parameters (id);",
    "CREATE UNIQUE INDEX CONCURRENTLY fixture_active_idx ON public.fixture_parameters (id);",
    "CREATE UNIQUE INDEX IF NOT EXISTS fixture_active_idx ON public.fixture_parameters (id);",
    "ALTER TABLE public.fixture_parameters ADD CONSTRAINT fixture_active_idx PRIMARY KEY (id);",
    "ALTER TABLE public.fixture_parameters ADD CONSTRAINT fixture_active_idx UNIQUE (id);",
    "ALTER TABLE public.fixture_parameters ADD CONSTRAINT fixture_active_idx EXCLUDE USING gist (int4range(0, 1) WITH &&);",
    "CREATE UNIQUE INDEX fixture_active_idx ON public.other_table (id);",
    "CREATE UNIQUE INDEX fixture_active_idx ON fixture_parameters (id);",
    'CREATE UNIQUE INDEX fixture_active_idx ON "public"."fixture_parameters" (id);',
    "CREATE UNIQUE INDEX fixture_active_idx ON public.fixture_parameters$other (id);",
  ])("refuses a pinned statement that is not a plain CREATE INDEX of its table, including constraint indexes: %s", source => {
    expect(() => indexDrop(dropIndexSql, source)).toThrow("reviewed native store dropped index preimage is not a plain CREATE INDEX of its table");
  });
  it("refuses a hash that pins no prefix statement", () => {
    expect(() => indexDrop(dropIndexSql, dropIndexCreate, "", slot => { slot.droppedIndexes![0]!.beforeSha256 = "0".repeat(64); })).toThrow("reviewed native store dropped index plain CREATE missing from prefix");
  });
  // History is what PostgreSQL executes; the catalog proof compares the dropped index with its pinned CREATE.
  it.each([
    'CREATE INDEX "fixture_active_idx" ON public.fixture_parameters (id);\nDROP INDEX public.fixture_active_idx;',
    String.raw`CREATE INDEX U&"fixture_\0061ctive_idx" ON public.fixture_parameters (id);`,
    "SELECT 'fixture_active_idx';",
  ])("leaves earlier prefix history to the PostgreSQL proof: %s", earlier => {
    const history = `${earlier}\n${dropIndexCreate}`;
    expect(() => indexDrop(dropIndexSql, history, "", slot => { slot.droppedIndexes![0]!.beforeSha256 = sqlSha256(dropIndexCreate); })).not.toThrow();
  });
  it.each([
    "ALTER INDEX public.fixture_active_idx SET (fillfactor=80);",
    "DO $$ BEGIN EXECUTE 'DROP INDEX public.fixture_active_idx'; END; $$;",
    "ALTER TABLE public.fixture_parameters ADD CONSTRAINT adopted_key UNIQUE USING INDEX fixture_active_idx;",
  ])("leaves later prefix history to the PostgreSQL proof: %s", history => {
    expect(() => indexDrop(dropIndexSql, dropIndexCreate.replace(" WHERE status = 'open'", ""), history)).not.toThrow();
  });
  it.each(["duplicate", "schema-qualified name", "bad table", "bad hash", "extra key"])("refuses invalid inventory: %s", attack => {
    expect(() => indexDrop(dropIndexSql, dropIndexCreate, "", slot => {
      const entry = slot.droppedIndexes![0]!;
      if (attack === "duplicate") slot.droppedIndexes!.push({ ...entry });
      if (attack === "schema-qualified name") entry.name = "public.fixture_active_idx";
      if (attack === "bad table") entry.table = "fixture_parameters";
      if (attack === "bad hash") entry.beforeSha256 = "bad";
      if (attack === "extra key") Object.assign(entry, { cascade: false });
    })).toThrow("reviewed native store invalid dropped index inventory");
  });
  it.each(["issued", "sealed reservation"])("keeps dropped index inventory immutable in an %s slot", mode => {
    const prior = registry(); prior.nativeStoreForwardClass!.slots[0]!.droppedIndexes = [{ ...dropIndexEntry }];
    if (mode === "issued") bind(prior, 0, `${sql()}\n${dropIndexSql}`); else prior.nativeStoreForwardClass!.sealed = true;
    const next = structuredClone(prior); next.nativeStoreForwardClass!.slots[0]!.droppedIndexes![0]!.beforeSha256 = "0".repeat(64);
    expect(() => changedForwardApprovals(encode(prior), encode(next))).toThrow(mode === "issued" ? "reviewed native store issued bindings and slots are immutable" : "reviewed native store sealed slot prefix is immutable and cannot be unsealed");
  });
});

const censusTable = "public.fixture_census";
const censusCreate = `CREATE TABLE ${censusTable} (id uuid PRIMARY KEY, client_id uuid NOT NULL REFERENCES public.clients(id), payload jsonb);`;
const censusClassification = "INSERT INTO public.client_absorption_policy (table_name, disposition, note) VALUES ('fixture_census', 'block', 'Customer history prevents absorption.');";
const censusGrant = `GRANT SELECT (client_id) ON TABLE ${censusTable} TO service_role;`;
const censusPolicy = `CREATE POLICY fixture_census_absorption_census ON ${censusTable} FOR SELECT TO service_role USING (true);`;
const censusShape = [censusCreate, `ALTER TABLE ${censusTable} ENABLE ROW LEVEL SECURITY;`, `REVOKE ALL ON TABLE ${censusTable} FROM PUBLIC;`, censusClassification, noticeDo(censusGrant), noticeDo(censusPolicy)].join("\n");
function censusForward(text = censusShape, mutate: (slot: NativeStoreSlot) => void = () => {}, earlier = false) {
  const value = registry(), index = earlier ? 1 : 0, slot = value.nativeStoreForwardClass!.slots[index]!;
  const preceding = [{ path: PLATFORM_BASELINE_FILE, bytes: before }];
  if (earlier) {
    const prior = `${sql()}\n${censusCreate}`, pin = bind(value, 0, prior);
    preceding.push({ path: pin.path, bytes: Buffer.from(prior) });
  }
  slot.absorptionCensusTables = [censusTable]; slot.dataStatements = [censusClassification]; mutate(slot);
  const complete = `${sql(index)}\n${text}`, pin = bind(value, index, complete);
  assertNativeStoreForward(value, pin.path, Buffer.from(complete), preceding);
}
describe("owned absorption census capability", () => {
  it("admits the two exact guarded statements on a same-slot client-referencing block table", () => {
    expect(() => censusForward()).not.toThrow();
  });
  it("admits a named single-column table FK as well as an inline FK", () => {
    expect(() => censusForward(censusShape.replace("client_id uuid NOT NULL REFERENCES public.clients(id)", "client_id uuid NOT NULL, CONSTRAINT fixture_owner FOREIGN KEY (client_id) REFERENCES public.clients(id)"))).not.toThrow();
  });
  it("admits more than one independently classified census table", () => {
    const other = censusShape.replaceAll("fixture_census", "fixture_another");
    expect(() => censusForward(`${censusShape}\n${other}`, slot => {
      slot.absorptionCensusTables!.push("public.fixture_another");
      slot.dataStatements.push(censusClassification.replaceAll("fixture_census", "fixture_another"));
    })).not.toThrow();
  });
  it.each([
    ["wrong column", censusGrant, censusGrant.replace("(client_id)", "(payload)")],
    ["extra column", censusGrant, censusGrant.replace("(client_id)", "(client_id, payload)")],
    ["table grant", censusGrant, censusGrant.replace(" (client_id)", "")],
    ["wrong grant role", censusGrant, censusGrant.replace("TO service_role", "TO authenticated")],
    ["write verb", censusGrant, censusGrant.replace("GRANT SELECT", "GRANT UPDATE")],
    ["grant option", censusGrant, censusGrant.replace("service_role;", "service_role WITH GRANT OPTION;")],
    ["FOR ALL", censusPolicy, censusPolicy.replace("FOR SELECT", "FOR ALL")],
    ["non-true USING", censusPolicy, censusPolicy.replace("USING (true)", "USING (false)")],
    ["WITH CHECK", censusPolicy, censusPolicy.replace("USING (true);", "USING (true) WITH CHECK (true);")],
    ["wrong policy role", censusPolicy, censusPolicy.replace("TO service_role", "TO authenticated")],
    ["wrong policy name", censusPolicy, censusPolicy.replace("fixture_census_absorption_census", "fixture_other_policy")],
    ["restrictive policy", censusPolicy, censusPolicy.replace("FOR SELECT", "AS RESTRICTIVE FOR SELECT")],
  ])("refuses %s", (_label, original, replacement) => {
    expect(() => censusForward(censusShape.replace(original!, replacement!))).toThrow(/closed shapes|conditional privilege/u);
  });
  it.each([censusGrant, censusPolicy])("refuses an unguarded census statement: %s", statement => {
    expect(() => censusForward(censusShape.replace(noticeDo(statement), statement))).toThrow(/service_role conditional shell/u);
  });
  it.each([censusGrant, censusPolicy])("refuses duplicate or missing census statements: %s", statement => {
    expect(() => censusForward(`${censusShape}\n${noticeDo(statement)}`)).toThrow(/duplicate absorption census/u);
    expect(() => censusForward(censusShape.replace(noticeDo(statement), ""))).toThrow(/exactly one grant and policy/u);
  });
  it("refuses another conditional shell role even when the target role is service_role", () => {
    expect(() => censusForward(censusShape.replaceAll("rolname='service_role'", "rolname='authenticated'"))).toThrow(/service_role conditional shell/u);
  });
  it("refuses unlisted tables", () => {
    expect(() => censusForward(censusShape, slot => { delete slot.absorptionCensusTables; })).toThrow(/conditional privilege/u);
  });
  it("refuses an earlier slot's table", () => {
    expect(() => censusForward(censusShape.replace(censusCreate, ""), undefined, true)).toThrow(/same slot/u);
  });
  it("requires the table to be created before its census grant", () => {
    expect(() => censusForward(`${noticeDo(censusGrant)}\n${censusShape.replace(noticeDo(censusGrant), "")}`)).toThrow(/created earlier/u);
  });
  it("leaves installed foreign-key semantics to the PostgreSQL catalogue guard", () => {
    expect(() => censusForward(censusShape.replace("client_id uuid NOT NULL REFERENCES public.clients(id)", "client_id uuid"))).not.toThrow();
  });
  it("requires classification in both the slot and SQL", () => {
    expect(() => censusForward(censusShape, slot => { slot.dataStatements = []; })).toThrow(/exact block classifications/u);
    expect(() => censusForward(censusShape.replace(censusClassification, ""))).toThrow(/named data statement missing/u);
  });
  it.each(["retain", "carry"])("refuses %s classification", disposition => {
    const statement = censusClassification.replace("'block'", `'${disposition}'`);
    expect(() => censusForward(censusShape.replace(censusClassification, statement), slot => { slot.dataStatements = [statement]; })).toThrow(/exact block classifications/u);
  });
  it.each([[censusTable, censusTable], ["fixture_census"], ["other.fixture_census"], [`public.${"a".repeat(63)}`], ['public."CensusHistory"'], ['public."fixture_census"'], ['"public".fixture_census']])("refuses invalid census inventory %j", (...tables) => {
    expect(() => censusForward(censusShape, slot => { slot.absorptionCensusTables = tables as string[]; })).toThrow(/qualified tables/u);
  });
});

describe("slot-local legacy headers and fresh-column FK actions", () => {
  const compact = "CREATE FUNCTION public.fixture_compact(p_id uuid) RETURNS text LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$ SELECT 'before'; $$;";
  const replacement = compact.replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION").replace("'before'", "'after'");
  const compactForward = (statement: string, path = "pg_catalog") => parameterForward(statement, slot => {
    slot.replacedFunctions.push({signature:"public.fixture_compact(uuid)", searchPath:path, beforeSha256:nativeStoreFunctionDefinitions(Buffer.from(compact), ["public.fixture_compact(uuid)"]).get("public.fixture_compact(uuid)")!});
  }, compact);
  it("admits a replacement preserving its compact legacy search_path header", () => {
    expect(() => compactForward(replacement)).not.toThrow();
  });
  it.each(["search_path = pg_catalog", "search_path= pg_catalog", "search_path =pg_catalog", "search_path=public"])("refuses compact legacy header drift: %s", spelling => {
    expect(() => compactForward(replacement.replace("search_path=pg_catalog",spelling))).toThrow("replacement header drifted");
  });
  it("still refuses compact spelling on a newly created function and a mismatched legacy pin", () => {
    expect(() => check(sql().replace("search_path = pg_catalog, pg_temp", "search_path=pg_catalog, pg_temp"))).toThrow();
    expect(() => compactForward(replacement,"public")).toThrow("unpinned SECURITY DEFINER or search_path");
  });
  const column = "ALTER TABLE public.fixture_parameters ADD COLUMN parent_id uuid;";
  const fk = (action: string, suffix: string) => `ALTER TABLE public.fixture_parameters ADD CONSTRAINT fixture_parent_fk FOREIGN KEY (parent_id) REFERENCES public.fixture_row(id) ON DELETE ${action}${suffix};`;
  const listed = (statements: string[]) => parameterForward(statements.join("\n"), slot => {slot.existingTableStatements = statements;});
  it.each(["CASCADE", "SET NULL"])("admits a declared fresh-column FK with %s and either validation state", action => {
    for (const suffix of ["", " NOT VALID"]) expect(() => listed([column,fk(action,suffix)])).not.toThrow();
  });
  it("admits the same exact ADD COLUMN and named FK actions in one ALTER", () => {
    expect(() => listed([column.slice(0,-1)+", "+fk("SET NULL"," NOT VALID").split(" ADD CONSTRAINT ")[1]!.replace(/^/,"ADD CONSTRAINT ")])).not.toThrow();
  });
  it("refuses an FK action without an earlier declared ADD COLUMN", () => {
    for (const statements of [[fk("CASCADE","")],[fk("SET NULL",""),column]]) expect(() => listed(statements)).toThrow("requires an earlier same-slot ADD COLUMN");
  });
  it.each(["SET DEFAULT", "CASCADE DEFERRABLE", "SET NULL ON UPDATE CASCADE"])("refuses a broader fresh-column FK action: %s", action => {
    expect(() => listed([column,fk(action,"")])).toThrow("existing-table statement is not expand-only");
  });
  it("refuses dropping or rewriting an existing FK through the companion list", () => {
    expect(() => listed(["ALTER TABLE public.fixture_parameters DROP CONSTRAINT fixture_parent_fk;",column,fk("CASCADE","")])).toThrow("existing-table statement is not expand-only");
    expect(() => parameterForward(`${column}\n${fk("CASCADE","")}`,()=>{})).toThrow("outside its closed shapes");
  });
  it("admits a listed trigger on its earlier same-slot created table", () => {
    const statement=triggerBefore.replace("public.fixture_parameters","public.fixture_fresh");
    expect(() => parameterForward(`CREATE TABLE public.fixture_fresh(id uuid,extra uuid);\n${triggerFunction}\n${triggerRevoke}\n${statement}`,slot=>{
      slot.createdFunctions.push({signature:"public.fixture_trigger_guard()",searchPath:"pg_catalog, pg_temp"});
      slot.createdTriggers=[{name:"fixture_trigger_guard",table:"public.fixture_fresh",sha256:sqlSha256(statement)}];
    })).not.toThrow();
  });
});

describe("replacement of an earlier native-store creation", () => {
  function subject() {
    const value = structuredClone(production), signature = "public.dunning_lifecycle_pause_reminder_dispatch(integer,integer)";
    const creation = value.nativeStoreForwardClass!.slots.find(slot => slot.createdFunctions.some(fn => fn.signature === signature))!;
    const creationPin = value.nativeStoreForwards!.find(pin => pin.path === creation.path)!;
    const predecessor = creationPin.functions.find(fn => fn.signature === signature)!;
    const original = sqlStatements(readFileSync(creation.path, "utf8")).find(statement =>
      nativeStoreFunctionDefinitions(Buffer.from(statement), [signature], true).has(signature))!;
    const text = original.replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION").replace("'ok',true,", "'ok',true,'capabilityWitness',true,");
    // The first-replacement proof uses the exact historical prefix, independently of later issued replacements.
    const slot: NativeStoreSlot = { row: "created-function-replacement", path: "db/platform/migrations/20261106120002_fixture_created_replacement.sql",
      replacedFunctions: [{ signature, beforeSha256: predecessor.afterSha256, searchPath: "pg_catalog" }],
      createdFunctions: [], grantOnlyFunctions: [], dataStatements: [] };
    value.nativeStoreForwardClass!.slots = value.nativeStoreForwardClass!.slots.filter(entry => entry.path < slot.path);
    value.nativeStoreForwards = value.nativeStoreForwards!.filter(entry => entry.path < slot.path);
    value.nativeStoreForwardClass!.slots.push(slot);
    const pin = { path: slot.path, sha256: sqlSha256(text), functions: [{ signature, beforeSha256: predecessor.afterSha256, afterSha256: sqlSha256(text) }] };
    value.nativeStoreForwards!.push(pin);
    const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")) as { baseline: { file: string }; forward: { file: string }[] };
    const prefix = [manifest.baseline, ...manifest.forward].filter(unit => unit.file < slot.path).map(unit => ({ path: unit.file, bytes: readFileSync(unit.file) }));
    return { value, slot, pin, prefix, text, signature, creation, creationPin, predecessor, original };
  }
  it("admits the listed reminder replacement chained to its exact creation pin", () => {
    const s = subject();
    expect(s.predecessor.beforeSha256).toBeNull();
    expect(sqlSha256(s.original)).toBe(s.predecessor.afterSha256);
    expect(s.text).not.toBe(s.original.replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION"));
    expect(() => readReviewedForwardRegistry(encode(s.value))).not.toThrow();
    expect(() => assertNativeStoreForward(s.value, s.slot.path, Buffer.from(s.text), s.prefix)).not.toThrow();
  });
  it.each(["unlisted", "wrong before hash", "drifted creation pin", "missing creation pin", "prefix drift", "changed header", "changed signature"])("refuses %s", attack => {
    const s = subject();
    let text = s.text;
    if (attack === "unlisted") { s.slot.replacedFunctions = []; s.pin.functions = []; }
    if (attack === "wrong before hash") s.slot.replacedFunctions[0]!.beforeSha256 = s.pin.functions[0]!.beforeSha256 = "0".repeat(64);
    if (attack === "drifted creation pin") s.predecessor.afterSha256 = s.slot.replacedFunctions[0]!.beforeSha256 = s.pin.functions[0]!.beforeSha256 = "0".repeat(64);
    if (attack === "missing creation pin") s.value.nativeStoreForwards = s.value.nativeStoreForwards!.filter(pin => pin !== s.creationPin);
    if (attack === "prefix drift") s.prefix.push({ path: "db/platform/migrations/20261106120001_fixture_prior_definition.sql", bytes: Buffer.from(text.replace("capabilityWitness", "prefixDrift")) });
    if (attack === "changed header") text = text.replace("LANGUAGE plpgsql", "LANGUAGE plpgsql SECURITY DEFINER");
    if (attack === "changed signature") text = text.replace("p_pause_window_seconds integer", "p_pause_window_seconds bigint");
    s.pin.sha256 = sqlSha256(text);
    if (s.pin.functions[0]) s.pin.functions[0].afterSha256 = sqlSha256(text);
    const message = attack === "unlisted" || attack === "changed signature" ? /unlisted signature/u
      : attack === "wrong before hash" ? /before-hash differs from preceding after-hash/u
      : attack === "missing creation pin" ? /bound predecessor/u
      : attack === "changed header" ? /replacement header drifted/u : /actual base function before-hash drifted/u;
    expect(() => assertNativeStoreForward(s.value, s.slot.path, Buffer.from(text), s.prefix)).toThrow(message);
  });
});

const assignmentAdd = "ALTER TABLE public.subscriptions ADD COLUMN offer_policy_assignment_state text NOT NULL DEFAULT 'legacy_frozen';";
const assignmentSwitch = "ALTER TABLE public.subscriptions ALTER COLUMN offer_policy_assignment_state SET DEFAULT 'pending_acquisition';";
const baselineTable = "public.commerce_offer_policy_rollout_baselines";
const baselineGrant = `GRANT SELECT, INSERT ON TABLE ${baselineTable} TO service_role;`;
const baselineSelect = `CREATE POLICY commerce_offer_policy_baselines_service_select ON ${baselineTable} FOR SELECT TO service_role USING (true);`;
const baselineInsert = `CREATE POLICY commerce_offer_policy_baselines_service_insert ON ${baselineTable} FOR INSERT TO service_role WITH CHECK (true);`;
const baselineShape = `CREATE TABLE ${baselineTable} (id text PRIMARY KEY);
ALTER TABLE ${baselineTable} ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE ${baselineTable} FROM PUBLIC;
${[baselineGrant, baselineSelect, baselineInsert].map(noticeDo).join("\n")}`;

describe("native baseline admission", () => {
  const assignment = (statements: string[], text = statements.join("\n")) => check(`${sql()}\n${text}`, value => {
    value.nativeStoreForwardClass!.slots[0]!.existingTableStatements = statements;
  });
  const baseline = (text: string, tables = [baselineTable]) => check(`${sql()}\n${text}`, value => {
    value.nativeStoreForwardClass!.slots[0]!.insertSelectTables = tables;
  });
  it("admits the exact fresh-column legacy-to-pending default switch", () => {
    expect(() => assignment([assignmentAdd, assignmentSwitch])).not.toThrow();
    expect(isExpandOnlyPlatformForward(assignmentSwitch)).toBe(false);
  });
  it.each([
    ["other default", [assignmentAdd, assignmentSwitch.replace("pending_acquisition", "assigned_acquisition")]],
    ["other initial default", [assignmentAdd.replace("legacy_frozen", "pending_acquisition"), assignmentSwitch]],
    ["switch before addition", [assignmentSwitch, assignmentAdd]],
    ["no addition", [assignmentSwitch]],
    ["conditional addition", [assignmentAdd.replace("ADD COLUMN", "ADD COLUMN IF NOT EXISTS"), assignmentSwitch]],
    ["other table", [assignmentAdd, assignmentSwitch].map(text => text.replace("public.subscriptions", "public.fixture_row"))],
    ["other column", [assignmentAdd, assignmentSwitch].map(text => text.replace("offer_policy_assignment_state", "other_state"))],
    ["non-expand companion", [assignmentAdd, assignmentSwitch.replace(";", ", DROP COLUMN id;")]],
    ["drop default", [assignmentAdd, assignmentSwitch.replace("SET DEFAULT 'pending_acquisition'", "DROP DEFAULT")]],
  ])("refuses assignment default %s", (_label, statements) => {
    expect(() => assignment(statements)).toThrow(/existing-table statement is not expand-only/u);
  });
  it("refuses the canonical assignment switch when its only legacy ADD targets another table", () => {
    const otherAdd = assignmentAdd.replace("public.subscriptions", "public.fixture_row");
    expect(() => assignment([otherAdd])).not.toThrow();
    expect(() => assignment([otherAdd, assignmentSwitch])).toThrow("reviewed native store existing-table statement is not expand-only");
  });
  it("refuses an unlisted, changed or duplicated switch", () => {
    for (const statements of [[], [assignmentAdd], [assignmentAdd, assignmentSwitch]]) {
      expect(() => assignment(statements, assignmentAdd + assignmentSwitch + assignmentSwitch)).toThrow(/existing-table|closed shapes/u);
    }
  });
  it("admits the pinned baseline service grant and separate policies", () => {
    expect(() => baseline(baselineShape)).not.toThrow();
  });
  it.each([
    ["UPDATE grant", baselineShape.replace("SELECT, INSERT", "SELECT, INSERT, UPDATE")],
    ["DELETE grant", baselineShape.replace("SELECT, INSERT", "SELECT, INSERT, DELETE")],
    ["grant option", baselineShape.replace("TO service_role;", "TO service_role WITH GRANT OPTION;")],
    ["broader policy", baselineShape.replace("FOR SELECT TO", "FOR ALL TO")],
    ["UPDATE policy", baselineShape.replace("FOR SELECT TO", "FOR UPDATE TO")],
    ["DELETE policy", baselineShape.replace("FOR SELECT TO", "FOR DELETE TO")],
    ["other predicate", baselineShape.replace("WITH CHECK (true)", "WITH CHECK (false)")],
    ["other role", baselineShape.replaceAll("service_role", "authenticated")],
    ["other table", baselineShape.replaceAll(baselineTable, "public.fixture_baseline")],
    ["no same-file creation", baselineShape.replace(`CREATE TABLE ${baselineTable} (id text PRIMARY KEY);`, "")],
    ["unconditional grant", baselineShape.replace(noticeDo(baselineGrant), baselineGrant)],
    ["unconditional policy", baselineShape.replace(noticeDo(baselineSelect), baselineSelect)],
    ["mismatched role shell", baselineShape.replace(noticeDo(baselineGrant), noticeDo(baselineGrant).replace("rolname='service_role'", "rolname='authenticated'"))],
    ["duplicate grant", baselineShape + noticeDo(baselineGrant)],
    ["duplicate policy", baselineShape + noticeDo(baselineInsert)],
  ])("refuses baseline %s", (_label, text) => {
    expect(() => baseline(text)).toThrow(/reviewed native store/u);
  });
  it.each(["SELECT", "INSERT", "UPDATE", "DELETE", "REFERENCES", "TRIGGER"].flatMap(privilege =>
    ["table", "column"].flatMap(scope => ["direct", "guarded"].map(shell => ({ privilege, scope, shell }))),
  ))("refuses appended baseline $privilege $scope GRANT in $shell admission", ({ privilege, scope, shell }) => {
    const grant = `GRANT ${privilege}${scope === "column" ? " (id)" : ""} ON TABLE ${baselineTable} TO service_role;`;
    expect(() => baseline(baselineShape + (shell === "guarded" ? noticeDo(grant) : grant)))
      .toThrow(shell === "guarded" ? "reviewed native store conditional privilege target or role refused" : "reviewed native store refuses statement outside its closed shapes");
  });
  it.each([baselineGrant, baselineSelect, baselineInsert])("refuses an incomplete baseline without %s", statement => {
    expect(() => baseline(baselineShape.replace(noticeDo(statement), ""))).toThrow(/requires its grant and both policies/u);
  });
  it("refuses an unlisted or widened baseline allowance", () => {
    expect(() => baseline(baselineShape, [])).toThrow(/G8-only/u);
    expect(() => baseline(baselineShape, [baselineTable, noticeTable])).toThrow(/G8-only/u);
    expect(() => check(`${sql()}\n${baselineShape}`)).toThrow(/baseline requires/u);
  });
});

describe("closed same-SKU composite foreign key", () => {
  const column = "ALTER TABLE public.subscription_lines ADD COLUMN catalog_sku_revision_id uuid;";
  const fk = "ALTER TABLE public.subscription_lines ADD CONSTRAINT subscription_lines_catalog_sku_revision_fkey FOREIGN KEY (variant_id, catalog_sku_revision_id) REFERENCES public.catalog_sku_revisions (sku_id, id) ON DELETE RESTRICT NOT VALID;";
  const validate = "ALTER TABLE public.subscription_lines VALIDATE CONSTRAINT subscription_lines_catalog_sku_revision_fkey;";
  const listed = (statements: string[], actual = statements.join("\n")) => parameterForward(actual, slot => { slot.existingTableStatements = statements; });
  it("admits only the ordered same-SKU RESTRICT NOT VALID shape and its later validation", () => {
    for (const statements of [[column, fk], [column, fk, validate]]) {
      expect(() => listed(statements)).not.toThrow();
      expect(nativeStoreAddedForeignKeys(statements)).toMatchObject([{ table: "public.subscription_lines",
        columns: ["variant_id", "catalog_sku_revision_id"], reference: "public.catalog_sku_revisions",
        keys: ["sku_id", "id"], deletion: "r", validated: statements.includes(validate) }]);
    }
    expect(isExpandOnlyPlatformForward(fk)).toBe(false);
  });
  it.each([
    ["source arity", fk.replace("variant_id, ", "")],
    ["target arity", fk.replace("sku_id, ", "")],
    ["both arities", fk.replace("variant_id, ", "").replace("sku_id, ", "")],
    ["source order", fk.replace("variant_id, catalog_sku_revision_id", "catalog_sku_revision_id, variant_id")],
    ["target order", fk.replace("sku_id, id", "id, sku_id")],
    ["both orders", fk.replace("variant_id, catalog_sku_revision_id", "catalog_sku_revision_id, variant_id").replace("sku_id, id", "id, sku_id")],
    ["other source column", fk.replace("(variant_id,", "(other_id,")],
    ["other target column", fk.replace("(sku_id,", "(other_id,")],
    ["other source relation", fk.replace("public.subscription_lines", "public.other_lines")],
    ["other target relation", fk.replace("public.catalog_sku_revisions", "public.other_revisions")],
    ["other constraint", fk.replace("subscription_lines_catalog_sku_revision_fkey", "other_fkey")],
    ["VALID on add", fk.replace(" NOT VALID", "")],
    ["implicit NO ACTION", fk.replace(" ON DELETE RESTRICT", "")],
    ...["CASCADE", "SET NULL", "SET DEFAULT", "NO ACTION"].map(action => [`ON DELETE ${action}`, fk.replace("DELETE RESTRICT", `DELETE ${action}`)]),
    ...["RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT", "NO ACTION"].map(action => [`ON UPDATE ${action}`, fk.replace(" NOT VALID", ` ON UPDATE ${action} NOT VALID`)]),
    ["deferrable", fk.replace(" NOT VALID", " DEFERRABLE NOT VALID")],
    ["MATCH FULL", fk.replace(" ON DELETE", " MATCH FULL ON DELETE")],
    ["appended SELECT", `${fk} SELECT 1;`],
    ["appended DELETE", `${fk} DELETE FROM public.subscription_lines;`],
    ["appended ALTER", `${fk} ALTER TABLE public.subscription_lines DROP COLUMN variant_id;`],
    ["another ALTER action", fk.replace(";", ", ADD COLUMN extra text;")],
    ["literal smuggling", fk.replace(" NOT VALID", " NOT VALID 'SELECT'")],
    ["incomplete tokens", fk.replace(" NOT VALID", " NOT VALID \\")],
  ])("refuses same-SKU FK %s", (_label, statement) => {
    expect(() => listed([column, statement])).toThrow(/reviewed native store/u);
  });
  it("requires the exact same-SKU statements once in their declared order", () => {
    expect(() => listed([column, fk], column + fk + fk)).toThrow(/reviewed native store/u);
    expect(() => listed([column, fk], fk + column)).toThrow(/reviewed native store/u);
    expect(() => listed([column, fk], column)).toThrow(/reviewed native store/u);
    expect(() => listed([fk])).toThrow(/earlier same-slot ADD COLUMN/u);
  });
  it.each(["SELECT 1;", "DELETE FROM public.subscription_lines;", "UPDATE public.subscription_lines SET variant_id=NULL;", "GRANT UPDATE ON TABLE public.subscription_lines TO service_role;"])("retains generic refusal after a same-SKU FK: %s", extra => {
    expect(() => listed([column, fk], column + fk + extra)).toThrow(/reviewed native store/u);
  });
});


describe("closed successor new-table RESTRICT foreign keys", () => {
  const create = `CREATE TABLE public.catalog_sku_successors (
    predecessor_sku_id uuid NOT NULL REFERENCES public.catalog_skus(id) ON DELETE RESTRICT,
    successor_sku_id uuid NOT NULL REFERENCES public.catalog_skus(id) ON DELETE RESTRICT,
    publication_id uuid NOT NULL REFERENCES public.catalog_publications(id) ON DELETE RESTRICT,
    PRIMARY KEY (predecessor_sku_id, successor_sku_id),
    CHECK (predecessor_sku_id <> successor_sku_id)
  );`;
  it("admits exactly the successor new-table RESTRICT shape without broadening expand-only modes", () => {
    for (const statement of [create, create.toLowerCase().replaceAll("on delete", "on /* action */\n delete")]) {
      expect(() => check(`${sql()}\n${statement}`)).not.toThrow();
      expect(isExpandOnlyPlatformForward(statement)).toBe(false);
      expect(isExpandOnlyPlatformForward(statement, true)).toBe(false);
    }
  });
  it.each([
    ...["CASCADE", "SET NULL", "SET DEFAULT", "NO ACTION"].map(action => [`delete ${action}`, create.replace("DELETE RESTRICT", `DELETE ${action}`)]),
    ["implicit action", create.replace(" ON DELETE RESTRICT", "")],
    ["update action", create.replace("DELETE RESTRICT", "DELETE RESTRICT ON UPDATE RESTRICT")],
    ["deferrable", create.replace("DELETE RESTRICT", "DELETE RESTRICT DEFERRABLE")],
    ["match full", create.replace(" ON DELETE", " MATCH FULL ON DELETE")],
    ["other table", create.replace("public.catalog_sku_successors", "public.other_successors")],
    ["other SKU target", create.replace("public.catalog_skus", "public.other_skus")],
    ["other publication target", create.replace("public.catalog_publications", "public.other_publications")],
    ["other target key", create.replace("(id)", "(other_id)")],
    ["target arity", create.replace("(id)", "(id, other_id)")],
    ["composite source", create.replace("predecessor_sku_id uuid NOT NULL REFERENCES", "predecessor_sku_id uuid NOT NULL, FOREIGN KEY (predecessor_sku_id, successor_sku_id) REFERENCES")],
    ["PK order", create.replace("PRIMARY KEY (predecessor_sku_id, successor_sku_id)", "PRIMARY KEY (successor_sku_id, predecessor_sku_id)")],
    ["PK arity", create.replace("PRIMARY KEY (predecessor_sku_id, successor_sku_id)", "PRIMARY KEY (predecessor_sku_id)")],
    ...["predecessor_sku_id", "successor_sku_id", "publication_id"].map(column => [`nullable ${column}`, create.replace(`${column} uuid NOT NULL`, `${column} uuid`)]),
    ["wrong type", create.replace("publication_id uuid", "publication_id text")],
    ["missing check", create.replace(",\n    CHECK (predecessor_sku_id <> successor_sku_id)", "")],
    ["broader check", create.replace("<>", "=")],
    ["extra column", create.replace("PRIMARY KEY", "extra text, PRIMARY KEY")],
    ["conditional creation", create.replace("CREATE TABLE", "CREATE TABLE IF NOT EXISTS")],
    ["quoted syntax", create.replace("predecessor_sku_id uuid", '"predecessor_sku_id" uuid')],
    ["literal syntax", create.replace("predecessor_sku_id uuid", "'predecessor_sku_id' uuid")],
    ["literal smuggling", create.replace("<> successor_sku_id", "<> successor_sku_id OR 'DELETE' = 'DELETE'")],
    ["comment smuggling", create.replace("RESTRICT,", "RESTRICT /*,*/ SELECT 1,")],
    ["control character", create.replace(" ON DELETE", " ON\rDELETE")],
    ["incomplete tokens", create.replace("<> successor_sku_id", "<> successor_sku_id \\ ")],
    ...["SELECT 1;", "DELETE FROM public.catalog_skus;", "ALTER TABLE public.catalog_skus DROP COLUMN id;", "GRANT SELECT ON TABLE public.catalog_sku_successors TO PUBLIC;", "UPDATE public.catalog_sku_successors SET publication_id=NULL;"].map(extra => [`appended ${extra}`, create + extra]),
  ])("refuses successor new-table shape: %s", (_label, statement) => {
    expect(() => check(`${sql()}\n${statement}`)).toThrow(/reviewed native store/u);
  });
});


describe("closed successor storage RESTRICT tables", () => {
  it.each(Object.entries(NATIVE_SUCCESSOR_TABLE_SQL))("admits exact successor storage: %s without broadening other modes", (_name, create) => {
    for (const statement of [create, create.toLowerCase().replaceAll("on delete", "on /* action */\n delete")]) {
      expect(() => check(`${sql()}\n${statement}`)).not.toThrow();
      expect(isExpandOnlyPlatformForward(statement)).toBe(false);
      expect(isExpandOnlyPlatformForward(statement, true)).toBe(false);
    }
  });
  const refusals = Object.entries(NATIVE_SUCCESSOR_TABLE_SQL).flatMap(([name, create]) => {
    const cases: [string, string][] = [
      ["other table", create.replace(name, "public.other_successor_storage")],
      ["conditional creation", create.replace("CREATE TABLE", "CREATE TABLE IF NOT EXISTS")],
      ["extra column", create.replace("id uuid PRIMARY KEY,", "id uuid PRIMARY KEY, extra text,")],
      ["extra CHECK", create.replace(/\);$/u, ", CHECK (true));")],
      ["extra UNIQUE", create.replace(/\);$/u, ", UNIQUE (id));")],
      ["column order", create.replace("id uuid PRIMARY KEY,\n", "").replace(/\);$/u, ", id uuid PRIMARY KEY);")],
      ["quoted syntax", create.replace("id uuid PRIMARY KEY", '"id" uuid PRIMARY KEY')],
      ["literal syntax", create.replace("id uuid PRIMARY KEY", "'id' uuid PRIMARY KEY")],
      ["literal case", create.replace("'abcdef0123456789'", "'ABCDEF0123456789'")],
      ["comment smuggling", create.replace("RESTRICT,", "RESTRICT /*,*/ SELECT 1,")],
      ["control smuggling", create.replace(" ON DELETE", " ON\rDELETE")],
      ["dollar smuggling", create.replace("id uuid PRIMARY KEY", () => "id uuid PRIMARY KEY DEFAULT $$DELETE$$")],
      ...["SELECT 1;", `DELETE FROM ${name};`, `UPDATE ${name} SET id=NULL;`, `ALTER TABLE ${name} DROP COLUMN id;`, `GRANT SELECT ON ${name} TO PUBLIC;`].map(extra => [`appended ${extra}`, create + extra] as [string, string]),
    ];
    for (const line of create.split("\n").slice(1, -1)) {
      const column = line.trim().split(" ")[0]!;
      cases.push([`${column} name`, create.replace(line, line.replace(column, "unlisted_column"))]);
      cases.push([`${column} type`, create.replace(line, line.replace(/ (uuid|jsonb|integer|bigint|text|timestamptz)(?= |,|$)/u, " numeric"))]);
      if (line.includes("NOT NULL")) cases.push([`${column} nullable`, create.replace(line, line.replace(" NOT NULL", ""))]);
      if (line.includes("PRIMARY KEY")) cases.push([`${column} missing PK`, create.replace(line, line.replace(" PRIMARY KEY", ""))]);
      if (line.includes(" UNIQUE")) cases.push([`${column} missing UNIQUE`, create.replace(line, line.replace(" UNIQUE", ""))]);
      if (line.includes(" CHECK")) cases.push([`${column} changed CHECK`, create.replace(line, line.replace(/ CHECK \(.*\)(,?)$/u, " CHECK (true)$1"))]);
      if (line.includes(" DEFAULT")) cases.push([`${column} changed DEFAULT`, create.replace(line, line.replace(/ DEFAULT (?:'[^']*'|now\(\)|1)/u, " DEFAULT NULL"))]);
      if (line.includes(" REFERENCES")) {
        for (const action of ["CASCADE", "SET NULL", "SET DEFAULT", "NO ACTION", ""]) cases.push([`${column} action ${action || "implicit"}`, create.replace(line, line.replace("ON DELETE RESTRICT", action ? `ON DELETE ${action}` : ""))]);
        for (const [label, actual] of [
          ["target", line.replace(/REFERENCES public\.\w+/u, "REFERENCES public.other_target")],
          ["target key", line.replace("(id)", "(other_id)")],
          ["target arity", line.replace("(id)", "(id, other_id)")],
          ["missing FK", line.replace(/ REFERENCES .*?(,?)$/u, "$1")],
          ["update", line.replace("DELETE RESTRICT", "DELETE RESTRICT ON UPDATE CASCADE")],
          ["match", line.replace(" ON DELETE", " MATCH FULL ON DELETE")],
          ["deferred", line.replace("DELETE RESTRICT", "DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED")],
        ]) cases.push([`${column} ${label}`, create.replace(line, actual!)]);
      }
    }
    return cases.map(([label, statement]) => {
      if (statement === create) throw new Error(`ineffective refusal fixture: ${name}: ${label}`);
      return [`${name}: ${label}`, statement];
    });
  });
  it.each(refusals)("refuses successor storage statement: %s", (_label, statement) => {
    expect(() => check(`${sql()}\n${statement}`)).toThrow(/reviewed native store/u);
  });
});

describe("SECURITY DEFINER trailing pg_temp rule", () => {
  const fnSql = (clauses: string, body = "AS $$ SELECT 'ok'; $$", kind = "CREATE") =>
    `${kind} FUNCTION public.fixture_definer(p_id uuid) RETURNS text LANGUAGE sql ${clauses} ${body};`;

  it.each([
    ["omitted SET search_path", fnSql("SECURITY DEFINER")],
    ["CREATE OR REPLACE omitting SET search_path", fnSql("SECURITY DEFINER", "AS $$ SELECT 'ok'; $$", "CREATE OR REPLACE")],
    ["public, pg_catalog without pg_temp", fnSql("SECURITY DEFINER SET search_path = public, pg_catalog")],
    ["pg_catalog without pg_temp", fnSql("SECURITY DEFINER SET search_path = pg_catalog")],
    ["pg_temp first instead of last", fnSql("SECURITY DEFINER SET search_path = pg_temp, pg_catalog")],
    ["pg_temp in the middle", fnSql("SECURITY DEFINER SET search_path = public, pg_temp, pg_catalog")],
    ["duplicate pg_temp", fnSql("SECURITY DEFINER SET search_path = pg_temp, public, pg_temp")],
    ["numbered pg_temp earlier", fnSql("SECURITY DEFINER SET search_path = pg_temp_1, pg_catalog, pg_temp")],
    ["SET search_path FROM CURRENT", fnSql("SECURITY DEFINER SET search_path FROM CURRENT")],
    ["SET search_path = DEFAULT", fnSql("SECURITY DEFINER SET search_path = DEFAULT")],
    ["empty string search_path", fnSql("SECURITY DEFINER SET search_path = ''")],
    ["double-quoted uppercase PG_TEMP", fnSql('SECURITY DEFINER SET search_path = "pg_catalog", "PG_TEMP"')],
    ["single-quoted comma list", fnSql("SECURITY DEFINER SET search_path = 'pg_catalog, pg_temp'")],
    ["duplicate SET search_path clauses", fnSql("SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET search_path = public")],
    ["SET search_path only inside line comment", fnSql("SECURITY DEFINER -- SET search_path = pg_catalog, pg_temp\n")],
    ["SET search_path only inside block comment", fnSql("SECURITY DEFINER /* SET search_path = pg_catalog, pg_temp */")],
    ["SET search_path only inside dollar body", fnSql("SECURITY DEFINER", "AS $$ SET search_path = pg_catalog, pg_temp; SELECT 'ok'; $$")],
    ["SET search_path only inside BEGIN ATOMIC body", fnSql("SECURITY DEFINER", "BEGIN ATOMIC SET search_path = pg_catalog, pg_temp; SELECT 'ok'; END")],
    ["SECURITY DEFINER after BEGIN ATOMIC END", fnSql("", "BEGIN ATOMIC SELECT 'ok'; END SECURITY DEFINER")],
    ["SECURITY DEFINER with RETURN expression body", fnSql("SECURITY DEFINER", "RETURN 'ok'")],
    ["block-comment split SECURITY DEFINER", fnSql("SECURITY/* gap */DEFINER SET search_path = public, pg_catalog")],
    ["trailing SECURITY DEFINER after body", fnSql("", "AS $$ SELECT 'ok'; $$ SECURITY DEFINER SET search_path = public, pg_catalog")],
    ["quoted uppercase SEARCH_PATH GUC without pg_temp", fnSql('SECURITY DEFINER SET "SEARCH_PATH" = public, pg_catalog')],
    ["duplicate search_path via quoted uppercase SEARCH_PATH", fnSql('SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET "SEARCH_PATH" = public')],
    ["schema-qualified pg_catalog.search_path GUC", fnSql("SECURITY DEFINER SET pg_catalog.search_path = pg_catalog, pg_temp")],
    ["splitter desync via standard-conforming backslash quote", `SELECT '\\'; ${fnSql("SECURITY DEFINER")} --';`],
    ["splitter desync via identifier-adjacent dollar tag", `SELECT a$tag$; ${fnSql("SECURITY DEFINER", "AS $tag$ SELECT 'ok'; $tag$")}`],
    ["splitter desync via E'...' quotecontinue escape mode", `SELECT E'a'\n'b\\'' ; ${fnSql("SECURITY DEFINER")} --'\n;`],
    ["SET search_path quotecontinue across newline", fnSql("SECURITY DEFINER SET search_path = 'pg_catalog', 'pg_temp'\n'x'")],
    ["SET search_path quotecontinue across -- comment", fnSql("SECURITY DEFINER SET search_path = 'pg_catalog', 'pg_temp' -- comment\n'x'")],
    ["SET search_path stray string literal after multiline block comment", fnSql("SECURITY DEFINER SET search_path = 'pg_catalog', 'pg_temp' /* a\nb */ 'x'")],
    ["SET search_path stray string literal on same line", fnSql("SECURITY DEFINER SET search_path = 'pg_catalog', 'pg_temp' 'x'")],
    ["decoy BEGIN ATOMIC with SELECT 1 AS case before hidden definer", `CREATE FUNCTION public.decoy1() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1 AS case; END; ${fnSql("SECURITY DEFINER")}`],
    ["BEGIN ATOMIC with AS end before body SET search_path = pg_temp", "CREATE FUNCTION public.fixture_definer(p_id uuid) RETURNS void LANGUAGE sql SECURITY DEFINER BEGIN ATOMIC INSERT INTO public.t SELECT 1 AS end ON CONFLICT (id) DO UPDATE SET search_path = pg_temp; END;"],
    ["BEGIN ATOMIC with THEN atomic END before body SET search_path = pg_temp", "CREATE FUNCTION public.fixture_definer(p_id uuid) RETURNS void LANGUAGE sql SECURITY DEFINER BEGIN ATOMIC INSERT INTO public.t SELECT CASE WHEN true THEN atomic END FROM (SELECT 1 AS atomic) t ON CONFLICT (id) DO UPDATE SET search_path = pg_temp; END;"],
    ["decoy BEGIN ATOMIC with SELECT begin atomic before hidden definer", `BEGIN; CREATE FUNCTION public.decoy() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT begin atomic FROM (SELECT 1 AS begin) t; END; ${fnSql("SECURITY DEFINER")} END;`],
    ["single-routine BEGIN ATOMIC with SELECT begin atomic followed by SECURITY DEFINER", "CREATE FUNCTION public.fixture_definer(p_id uuid) RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT begin atomic FROM (SELECT 1 AS begin) t; END SECURITY DEFINER; BEGIN; END;"],
    ["empty BEGIN ATOMIC END followed by SECURITY DEFINER", fnSql("", "BEGIN ATOMIC END SECURITY DEFINER")],
    ["astral Unicode dollar-quote tag hiding SET search_path in body", "CREATE FUNCTION public.fixture_definer(p_id uuid) RETURNS void LANGUAGE sql SECURITY DEFINER AS $😀$ SET search_path = pg_catalog, pg_temp; SELECT 1; $😀$;"],
    ["astral Unicode dollar-quote tag splitter desync", "SELECT $😀$'; $😀$; CREATE FUNCTION public.fixture_definer(p_id uuid) RETURNS void LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1; $$; SELECT $😀$' $😀$;"],
    ["astral Unicode identifier-adjacent dollar tag", `SELECT foo😀$tag$; ${fnSql("SECURITY DEFINER", "AS $tag$ SELECT 'ok'; $tag$")}`],
    ["single-quoted backslash default without search_path", "CREATE FUNCTION public.fixture_definer(p_id uuid) RETURNS text LANGUAGE sql SECURITY DEFINER AS 'SELECT ''\\\\''';"],
  ])("refuses %s with an actionable signature error", (_label, statement) => {
    expect(() => assertSecurityDefinerSearchPath(statement))
      .toThrow("SECURITY DEFINER function public.fixture_definer(uuid) must place pg_temp last in SET search_path (for example: SET search_path = pg_catalog, pg_temp)");
  });

  it.each([
    ["CRLF control bytes", `${fnSql("SECURITY DEFINER")}\r\n`, /control characters/u],
    ["CRLF before hidden definer", `SELECT 1;\r\n${fnSql("SECURITY DEFINER")}`, /control characters/u],
    ["NUL control byte", `SELECT '\u0000'; ${fnSql("SECURITY DEFINER")}`, /control characters/u],
    ["Unicode escape GUC name", fnSql('SECURITY DEFINER SET U&"\\0073earch_path" = pg_catalog, pg_temp'), /Unicode escape syntax/u],
    ["Unicode escape schema name", fnSql('SECURITY DEFINER SET search_path = pg_catalog, U&"pg_temp"'), /Unicode escape syntax/u],
    ["UESCAPE clause in routine header", fnSql("SECURITY DEFINER SET search_path = U&'pg_temp' UESCAPE '\\'"), /Unicode escape syntax/u],
    ["ALTER FUNCTION Unicode escape reset", 'ALTER FUNCTION public.fixture_definer(uuid) RESET U&"\\0073earch_path";', /Unicode escape syntax/u],
    ["CREATE PROCEDURE omitting SET search_path", "CREATE PROCEDURE public.fixture_proc(p_id uuid) LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN NULL; END; $$;", /SECURITY DEFINER procedure public\.fixture_proc\(uuid\) must place pg_temp last in SET search_path/u],
    ["CREATE OR REPLACE PROCEDURE missing pg_temp", "CREATE OR REPLACE PROCEDURE public.fixture_proc(p_id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$ BEGIN NULL; END; $$;", /SECURITY DEFINER procedure public\.fixture_proc\(uuid\) must place pg_temp last in SET search_path/u],
    ["ALTER FUNCTION setting SECURITY DEFINER without search_path", "ALTER FUNCTION public.fixture_definer(uuid) SECURITY DEFINER;", /SECURITY DEFINER function public\.fixture_definer\(uuid\) must place pg_temp last in SET search_path/u],
    ["ALTER PROCEDURE setting SECURITY DEFINER without search_path", "ALTER PROCEDURE public.fixture_proc(uuid) SECURITY DEFINER;", /SECURITY DEFINER procedure public\.fixture_proc\(uuid\) must place pg_temp last in SET search_path/u],
    ["ALTER ROUTINE without arglist setting SECURITY DEFINER", "ALTER ROUTINE public.fixture_routine SECURITY DEFINER;", /SECURITY DEFINER routine public\.fixture_routine must place pg_temp last in SET search_path/u],
    ["ALTER FUNCTION RESET search_path", "ALTER FUNCTION public.fixture_definer(uuid) RESET search_path;", /ALTER FUNCTION public\.fixture_definer\(uuid\) must not reset search_path/u],
    ["ALTER FUNCTION RESET quoted uppercase SEARCH_PATH", 'ALTER FUNCTION public.fixture_definer(uuid) RESET "SEARCH_PATH";', /ALTER FUNCTION public\.fixture_definer\(uuid\) must not reset search_path/u],
    ["ALTER PROCEDURE RESET ALL", "ALTER PROCEDURE public.fixture_proc(uuid) RESET ALL;", /ALTER PROCEDURE public\.fixture_proc\(uuid\) must not reset search_path/u],
    ["ALTER ROUTINE RESET ALL", "ALTER ROUTINE public.fixture_routine RESET ALL;", /ALTER ROUTINE public\.fixture_routine must not reset search_path/u],
    ["ALTER FUNCTION SET search_path without pg_temp", "ALTER FUNCTION public.fixture_definer(uuid) SET search_path = public, pg_catalog;", /ALTER FUNCTION public\.fixture_definer\(uuid\) must place pg_temp last in SET search_path/u],
    ["ALTER FUNCTION SET search_path FROM CURRENT", "ALTER FUNCTION public.fixture_definer(uuid) SET search_path FROM CURRENT;", /ALTER FUNCTION public\.fixture_definer\(uuid\) must place pg_temp last in SET search_path/u],
    ["ALTER FUNCTION SET search_path = DEFAULT", "ALTER FUNCTION public.fixture_definer(uuid) SET search_path = DEFAULT;", /ALTER FUNCTION public\.fixture_definer\(uuid\) must place pg_temp last in SET search_path/u],
    ["ALTER FUNCTION SECURITY DEFINER + valid SET + RESET search_path", "ALTER FUNCTION public.fixture_definer(uuid) SECURITY DEFINER SET search_path = pg_catalog, pg_temp RESET search_path;", /must not reset search_path/u],
    ["nested CREATE FUNCTION inside BEGIN ATOMIC", "CREATE FUNCTION public.outer_fn() RETURNS void LANGUAGE sql BEGIN ATOMIC CREATE FUNCTION public.inner_evil() RETURNS void LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1; $$; END;", /nested routine DDL inside BEGIN ATOMIC is not permitted/u],
    ["nested ALTER FUNCTION inside BEGIN ATOMIC after earlier statement", "CREATE FUNCTION public.outer_fn() RETURNS void LANGUAGE sql BEGIN ATOMIC SELECT 1; ALTER FUNCTION public.fixture_definer(uuid) RESET search_path; END;", /nested routine DDL inside BEGIN ATOMIC is not permitted/u],
    ["CREATE FUNCTION SECURITY DEFINER + SET + RESET search_path", fnSql("SECURITY DEFINER SET search_path = pg_catalog, pg_temp RESET search_path"), /SECURITY DEFINER function public\.fixture_definer\(uuid\) must not reset search_path/u],
    ["CREATE FUNCTION SECURITY DEFINER + SET + RESET ALL", fnSql("SECURITY DEFINER SET search_path = pg_catalog, pg_temp RESET ALL"), /SECURITY DEFINER function public\.fixture_definer\(uuid\) must not reset search_path/u],
    ["CREATE FUNCTION SECURITY DEFINER + SET + RESET pg_catalog.search_path", fnSql("SECURITY DEFINER SET search_path = pg_catalog, pg_temp RESET pg_catalog.search_path"), /SECURITY DEFINER function public\.fixture_definer\(uuid\) must not reset search_path/u],
    ["CREATE PROCEDURE SECURITY DEFINER + SET + RESET search_path", "CREATE PROCEDURE public.fixture_proc(p_id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp RESET search_path AS $$ BEGIN NULL; END; $$;", /SECURITY DEFINER procedure public\.fixture_proc\(uuid\) must not reset search_path/u],
    ["CREATE PROCEDURE SECURITY DEFINER + SET + RESET ALL", "CREATE PROCEDURE public.fixture_proc(p_id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp RESET ALL AS $$ BEGIN NULL; END; $$;", /SECURITY DEFINER procedure public\.fixture_proc\(uuid\) must not reset search_path/u],
    ["CREATE FUNCTION SECURITY DEFINER + SET SCHEMA single-quoted", fnSql("SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET SCHEMA 'public'"), /use explicit SET search_path = \.\.\., pg_temp instead of SET SCHEMA literal/u],
    ["CREATE FUNCTION SECURITY DEFINER + SET SCHEMA escape-string", fnSql("SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET SCHEMA E'public'"), /use explicit SET search_path = \.\.\., pg_temp instead of SET SCHEMA literal/u],
    ["CREATE FUNCTION SECURITY DEFINER + SET SCHEMA dollar-string", fnSql("SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET SCHEMA $$public$$"), /use explicit SET search_path = \.\.\., pg_temp instead of SET SCHEMA literal/u],
    ["CREATE FUNCTION SECURITY DEFINER + SET SCHEMA unicode-escape", fnSql("SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET SCHEMA U&'public'"), /Unicode escape syntax|SET SCHEMA literal/u],
    ["CREATE PROCEDURE SECURITY DEFINER + SET SCHEMA single-quoted", "CREATE PROCEDURE public.fixture_proc(p_id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET SCHEMA 'public' AS $$ BEGIN NULL; END; $$;", /SECURITY DEFINER procedure public\.fixture_proc\(uuid\) must use explicit SET search_path = \.\.\., pg_temp instead of SET SCHEMA literal/u],
    ["ALTER FUNCTION SET SCHEMA single-quoted", "ALTER FUNCTION public.fixture_definer(uuid) SET SCHEMA 'public';", /ALTER FUNCTION public\.fixture_definer\(uuid\) must use explicit SET search_path = \.\.\., pg_temp instead of SET SCHEMA literal/u],
    ["ALTER PROCEDURE SET SCHEMA dollar-string", "ALTER PROCEDURE public.fixture_proc(uuid) SET SCHEMA $$public$$;", /ALTER PROCEDURE public\.fixture_proc\(uuid\) must use explicit SET search_path = \.\.\., pg_temp instead of SET SCHEMA literal/u],
    ["ALTER ROUTINE SET SCHEMA escape-string", "ALTER ROUTINE public.fixture_routine SET SCHEMA E'public';", /ALTER ROUTINE public\.fixture_routine must use explicit SET search_path = \.\.\., pg_temp instead of SET SCHEMA literal/u],
  ])("refuses hardened edge case: %s", (_label, statement, pattern) => {
    expect(() => assertSecurityDefinerSearchPath(statement)).toThrow(pattern);
  });

  it.each([
    ["pg_catalog, pg_temp", fnSql("SECURITY DEFINER SET search_path = pg_catalog, pg_temp")],
    ["public, pg_catalog, pg_temp", fnSql("SECURITY DEFINER SET search_path = public, pg_catalog, pg_temp")],
    ["uppercase PG_CATALOG, PG_TEMP", fnSql("SECURITY DEFINER SET search_path = PG_CATALOG, PG_TEMP")],
    ["double-quoted lowercase identifiers", fnSql('SECURITY DEFINER SET search_path = "public", "pg_catalog", "pg_temp"')],
    ["single-quoted schema items", fnSql("SECURITY DEFINER SET search_path = 'pg_catalog', 'pg_temp'")],
    ["SET search_path TO syntax", fnSql("SECURITY DEFINER SET search_path TO public, pg_catalog, pg_temp")],
    ["quoted search_path GUC name", fnSql('SECURITY DEFINER SET "search_path" = pg_catalog, pg_temp')],
    ["quoted mixed-case Search_Path GUC name", fnSql('SECURITY DEFINER SET "Search_Path" = pg_catalog, pg_temp')],
    ["SET search_path before SECURITY DEFINER", fnSql("SET search_path = pg_catalog, pg_temp SECURITY DEFINER")],
    ["pg_temp alone", fnSql("SECURITY DEFINER SET search_path = pg_temp")],
    ["BEGIN ATOMIC with trailing pg_temp", fnSql("SECURITY DEFINER SET search_path = pg_catalog, pg_temp", "BEGIN ATOMIC SELECT 'ok'; END")],
    ["BEGIN ATOMIC with $1 positional parameter", "CREATE FUNCTION public.fixture_pos(int) RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp BEGIN ATOMIC SELECT $1 + 1; END;"],
    ["BEGIN ATOMIC with CASE ... END and $1", "CREATE FUNCTION public.fixture_pos_case(int) RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp BEGIN ATOMIC SELECT CASE WHEN $1 > 0 THEN $1 ELSE 0 END; END;"],
    ["BEGIN ATOMIC selecting column named case (c.case)", "CREATE FUNCTION public.fixture_col_case(p_id uuid) RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp BEGIN ATOMIC SELECT c.case FROM public.cases c WHERE c.id = p_id; END;"],
    ["BEGIN ATOMIC aliasing 1 AS case", "CREATE FUNCTION public.fixture_as_case() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp BEGIN ATOMIC SELECT 1 AS case; END;"],
    ["BEGIN ATOMIC aliasing 1 AS end and column t.end", "CREATE FUNCTION public.fixture_as_end() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp BEGIN ATOMIC SELECT t.end AS end FROM public.t; END;"],
    ["BEGIN ATOMIC selecting begin aliased as atomic", "CREATE FUNCTION public.fixture_begin_atomic_alias() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp BEGIN ATOMIC SELECT begin atomic FROM (SELECT 1 AS begin) t; END;"],
    ["empty BEGIN ATOMIC END with trailing pg_temp", "CREATE FUNCTION public.fixture_empty_atomic() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp BEGIN ATOMIC END;"],
    ["SET search_path with quotecontinue building pg_temp", fnSql("SECURITY DEFINER SET search_path = 'pg_catalog', 'pg_'\n'temp'")],
    ["SECURITY INVOKER with RETURN $1 + 1", "CREATE FUNCTION public.fixture_pos_invoker(int) RETURNS int LANGUAGE sql SECURITY INVOKER RETURN $1 + 1;"],
    ["SECURITY DEFINER with trailing pg_temp and RETURN $1 + 1", "CREATE FUNCTION public.fixture_pos_definer(int) RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp RETURN $1 + 1;"],
    ["standard-conforming backslash in DEFAULT and single-quoted body", "CREATE FUNCTION public.fixture_bs(p_pat text DEFAULT '\\s+') RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS 'SELECT ''\\\\''';"],
    ["CREATE PROCEDURE with trailing pg_temp", "CREATE PROCEDURE public.fixture_proc(p_id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ BEGIN NULL; END; $$;"],
    ["CREATE PROCEDURE SECURITY INVOKER without pg_temp", "CREATE PROCEDURE public.fixture_proc(p_id uuid) LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_catalog AS $$ BEGIN NULL; END; $$;"],
    ["ALTER FUNCTION SECURITY DEFINER with trailing pg_temp", "ALTER FUNCTION public.fixture_definer(uuid) SECURITY DEFINER SET search_path = pg_catalog, pg_temp;"],
    ["ALTER FUNCTION SET search_path with trailing pg_temp", "ALTER FUNCTION public.fixture_definer(uuid) SET search_path = pg_catalog, pg_temp;"],
    ["ALTER FUNCTION unrelated OWNER / SET SCHEMA / INVOKER", 'ALTER FUNCTION public.fixture_definer(uuid) OWNER TO postgres; ALTER FUNCTION public.fixture_definer(uuid) SET SCHEMA app_internal; ALTER FUNCTION public.fixture_definer(uuid) SET SCHEMA "app_internal"; ALTER FUNCTION public.fixture_definer(uuid) SECURITY INVOKER;'],
    ["astral Unicode dollar-quote tag with valid trailing pg_temp", "CREATE FUNCTION public.fixture_astral() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $😀$ SELECT 1; $😀$;"],
    ["SECURITY INVOKER without pg_temp", fnSql("SECURITY INVOKER SET search_path = public, pg_catalog")],
    ["SECURITY INVOKER without SET search_path", fnSql("SECURITY INVOKER")],
    ["default invoker without SECURITY clause", fnSql("SET search_path = pg_catalog")],
    ["RETURNS TABLE with security/definer column names", "CREATE FUNCTION public.fixture_table_ret() RETURNS TABLE (security text, definer text) LANGUAGE sql AS $$ SELECT 'a', 'b'; $$;"],
  ])("accepts %s", (_label, statement) => {
    expect(() => assertSecurityDefinerSearchPath(statement)).not.toThrow();
  });

  const nativeDefinerCheck = (security: "DEFINER" | "INVOKER", searchPathSql: string | null, slotSearchPath: string | null) => {
    const signature = "public.fixture_new_definer(uuid)";
    const clause = searchPathSql === null ? "" : ` SET search_path = ${searchPathSql}`;
    const definition = `CREATE FUNCTION public.fixture_new_definer(p_id uuid) RETURNS text LANGUAGE sql SECURITY ${security}${clause} AS $$ SELECT 'ok'; $$;`;
    const text = `${definition}\nREVOKE ALL ON FUNCTION ${signature} FROM PUBLIC;`;
    const value = registry();
    const slot = value.nativeStoreForwardClass!.slots[0]!;
    slot.replacedFunctions = [];
    slot.createdFunctions = [{ signature, searchPath: slotSearchPath }];
    value.nativeStoreForwards = [{ path: slot.path, sha256: sqlSha256(text), functions: [{ signature, beforeSha256: null, afterSha256: sqlSha256(definition) }] }];
    assertNativeStoreForward(value, slot.path, Buffer.from(text), [{ path: PLATFORM_BASELINE_FILE, bytes: before }]);
  };

  it.each([
    ["omitted SET search_path", null, null],
    ["public, pg_catalog", "public, pg_catalog", "public, pg_catalog"],
    ["pg_temp, pg_catalog", "pg_temp, pg_catalog", "pg_temp, pg_catalog"],
    ["pg_temp, public, pg_temp", "pg_temp, public, pg_temp", "pg_temp, public, pg_temp"],
  ])("refuses new native-store SECURITY DEFINER with %s even when slot searchPath matches", (_label, searchPathSql, slotSearchPath) => {
    expect(() => nativeDefinerCheck("DEFINER", searchPathSql, slotSearchPath))
      .toThrow("SECURITY DEFINER function public.fixture_new_definer(uuid) must place pg_temp last in SET search_path (for example: SET search_path = pg_catalog, pg_temp)");
  });

  it.each([
    ["DEFINER with pg_catalog, pg_temp", "DEFINER", "pg_catalog, pg_temp", "pg_catalog, pg_temp"],
    ["DEFINER with public, pg_catalog, pg_temp", "DEFINER", "public, pg_catalog, pg_temp", "public, pg_catalog, pg_temp"],
    ["DEFINER with uppercase PG_CATALOG, PG_TEMP", "DEFINER", "PG_CATALOG, PG_TEMP", "pg_catalog, pg_temp"],
    ["INVOKER with public, pg_catalog", "INVOKER", "public, pg_catalog", "public, pg_catalog"],
    ["INVOKER without search_path", "INVOKER", null, null],
  ] as const)("admits new native-store %s", (_label, security, searchPathSql, slotSearchPath) => {
    expect(() => nativeDefinerCheck(security, searchPathSql, slotSearchPath)).not.toThrow();
  });

  it("preserves admission of every already-landed historical native-store slot on main", () => {
    const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")) as { baseline: { file: string }; forward: { file: string }[] };
    const all = [manifest.baseline, ...manifest.forward].map(unit => ({ path: unit.file, bytes: readFileSync(unit.file) }));
    const landedSlots = production.nativeStoreForwardClass!.slots;
    expect(landedSlots.length).toBeGreaterThanOrEqual(77);
    for (const slot of landedSlots) {
      const bytes = readFileSync(slot.path);
      const prefix = all.filter(unit => unit.path < slot.path);
      expect(() => assertNativeStoreForward(production, slot.path, bytes, prefix), slot.path).not.toThrow();
    }
  });
});

describe("native-store replacement search_path pg_temp tightening", () => {
  it("admits a later replacement of the installed channel listing function with its compact defining header", () => {
    const value = structuredClone(production);
    const slot = emptySlot("db/platform/migrations/20990101000000_fixture_followup.sql", "FixtureFollowup");
    const signature = "public.channel_listing_read(uuid,uuid)";
    const priorClause = "SET search_path=pg_catalog,public";
    const searchPath = "pg_catalog, public, pg_temp";
    const definitionPath = "db/platform/migrations/20261030121000_channel_retained_basis.sql";
    const definition = sqlStatements(readFileSync(definitionPath, "utf8"))
      .find(statement => statement.startsWith("CREATE FUNCTION public.channel_listing_read("))!;
    expect(definition).toContain(priorClause);
    const replacement = definition.replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION")
      .replace(priorClause, `SET search_path = ${searchPath}`);
    slot.replacedFunctions.push({ signature, beforeSha256: sqlSha256(definition), searchPath });
    const slots = value.nativeStoreForwardClass!.slots;
    bind(value, slots.push(slot) - 1, replacement);
    const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")) as { baseline: { file: string }; forward: { file: string }[] };
    const history = [manifest.baseline, ...manifest.forward].map(unit => ({ path: unit.file, bytes: readFileSync(unit.file) }));
    expect(() => assertNativeStoreForward(value, slot.path, Buffer.from(replacement), history)).not.toThrow();
  });

  const signature = "public.fixture_tighten(text)";
  const nativeReplacementCheck = (priorAttrs: string, nextAttrs: string, slotSearchPath: string | null, priorArg = "p_id text", nextArg = priorArg) => {
    const priorDef = `CREATE FUNCTION public.fixture_tighten(${priorArg}) RETURNS text LANGUAGE sql ${priorAttrs} AS $$ SELECT 'before'; $$;`;
    const nextDef = `CREATE OR REPLACE FUNCTION public.fixture_tighten(${nextArg}) RETURNS text LANGUAGE sql ${nextAttrs} AS $$ SELECT 'after'; $$;`;
    const beforeSha256 = sqlSha256(priorDef);
    const afterSha256 = sqlSha256(nextDef);
    const value = registry();
    const slot = value.nativeStoreForwardClass!.slots[0]!;
    slot.replacedFunctions = [{ signature, beforeSha256, searchPath: slotSearchPath }];
    slot.createdFunctions = [];
    value.nativeStoreForwards = [{ path: slot.path, sha256: sqlSha256(nextDef), functions: [{ signature, beforeSha256, afterSha256 }] }];
    assertNativeStoreForward(value, slot.path, Buffer.from(nextDef), [{ path: PLATFORM_BASELINE_FILE, bytes: Buffer.from(priorDef) }]);
  };

  it.each([
    [
      "SECURITY DEFINER tightening pg_catalog, public -> pg_catalog, public, pg_temp",
      "SECURITY DEFINER SET search_path = pg_catalog, public",
      "SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp",
      "pg_catalog, public, pg_temp",
    ],
    [
      "SECURITY INVOKER tightening pg_catalog, public -> pg_catalog, public, pg_temp",
      "SECURITY INVOKER SET search_path = pg_catalog, public",
      "SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp",
      "pg_catalog, public, pg_temp",
    ],
    [
      "compact legacy SET search_path=pg_catalog -> SET search_path=pg_catalog, pg_temp",
      "SECURITY INVOKER SET search_path=pg_catalog",
      "SECURITY INVOKER SET search_path=pg_catalog, pg_temp",
      "pg_catalog, pg_temp",
    ],
    [
      "TO, flexible spacing and whitespace normalization around a non-final clause",
      "SECURITY  INVOKER SET search_path=pg_catalog,public STABLE",
      "SECURITY INVOKER SET\tsearch_path TO pg_catalog ,\npublic,pg_temp  STABLE",
      "pg_catalog, public, pg_temp",
    ],
  ])("accepts %s", (_label, priorAttrs, nextAttrs, slotSearchPath) => {
    expect(() => nativeReplacementCheck(priorAttrs, nextAttrs, slotSearchPath)).not.toThrow();
  });

  it.each([
    ["single-quoted", "'a b'", "'a  b'"],
    ["dollar-quoted", "$value$a b$value$", "$value$a  b$value$"],
  ])("refuses changing whitespace in a %s DEFAULT alongside pg_temp", (_label, priorDefault, nextDefault) => {
    expect(() => nativeReplacementCheck(
      "SECURITY INVOKER SET search_path = pg_catalog, public",
      "SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp",
      "pg_catalog, public, pg_temp",
      `p_id text DEFAULT ${priorDefault}`,
      `p_id text DEFAULT ${nextDefault}`,
    )).toThrow("reviewed native store replacement header drifted");
  });

  it.each(["RESET search_path", "RESET ALL"])("refuses tightening with a top-level %s", reset => {
    expect(() => nativeReplacementCheck(
      `SECURITY INVOKER SET search_path = pg_catalog, public ${reset}`,
      `SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp ${reset}`,
      "pg_catalog, public, pg_temp",
    )).toThrow("reviewed native store replacement header drifted");
  });

  it.each([
    [
      "dropping pg_temp from INVOKER",
      "SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp",
      "SECURITY INVOKER SET search_path = pg_catalog, public",
      "pg_catalog, public",
    ],
    [
      "dropping pg_temp from DEFINER",
      "SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp",
      "SECURITY DEFINER SET search_path = pg_catalog, public",
      "pg_catalog, public",
    ],
    [
      "appending pg_temp when prior already has pg_temp",
      "SECURITY INVOKER SET search_path = pg_catalog, pg_temp",
      "SECURITY INVOKER SET search_path = pg_catalog, pg_temp, pg_temp",
      "pg_catalog, pg_temp, pg_temp",
    ],
    [
      "appending pg_temp when prior already has uppercase PG_TEMP",
      "SECURITY INVOKER SET search_path = pg_catalog, PG_TEMP",
      "SECURITY INVOKER SET search_path = pg_catalog, PG_TEMP, pg_temp",
      "pg_catalog, pg_temp, pg_temp",
    ],
    [
      "appending pg_temp when prior already has pg_temp_1",
      "SECURITY INVOKER SET search_path = pg_catalog, pg_temp_1",
      "SECURITY INVOKER SET search_path = pg_catalog, pg_temp_1, pg_temp",
      "pg_catalog, pg_temp_1, pg_temp",
    ],
    [
      "appending uppercase PG_TEMP",
      "SECURITY INVOKER SET search_path = pg_catalog, public",
      "SECURITY INVOKER SET search_path = pg_catalog, public, PG_TEMP",
      "pg_catalog, public, pg_temp",
    ],
    [
      "reordering schemas while adding pg_temp",
      "SECURITY INVOKER SET search_path = public, pg_catalog",
      "SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp",
      "pg_catalog, public, pg_temp",
    ],
    [
      "appending a schema other than pg_temp",
      "SECURITY INVOKER SET search_path = pg_catalog, public",
      "SECURITY INVOKER SET search_path = pg_catalog, public, extra",
      "pg_catalog, public, extra",
    ],
    [
      "adding an extra schema and a final pg_temp",
      "SECURITY INVOKER SET search_path=pg_catalog,public",
      "SECURITY INVOKER SET search_path = pg_catalog, public, extra, pg_temp",
      "pg_catalog, public, extra, pg_temp",
    ],
    [
      "putting pg_temp before the final schema",
      "SECURITY INVOKER SET search_path=pg_catalog,public",
      "SECURITY INVOKER SET search_path = pg_catalog, pg_temp, public",
      "pg_catalog, pg_temp, public",
    ],
    [
      "appending two pg_temp schemas",
      "SECURITY INVOKER SET search_path=pg_catalog,public",
      "SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp, pg_temp",
      "pg_catalog, public, pg_temp, pg_temp",
    ],
    [
      "tightening with more than one top-level SET search_path clause",
      "SECURITY INVOKER SET search_path TO pg_catalog SET search_path=pg_catalog,public",
      "SECURITY INVOKER SET search_path TO pg_catalog SET search_path = pg_catalog, public, pg_temp",
      "pg_catalog, public, pg_temp",
    ],
    [
      "changing an existing identifier's spelling",
      "SECURITY INVOKER SET search_path=pg_catalog,PUBLIC",
      "SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp",
      "pg_catalog, public, pg_temp",
    ],
    [
      "tightening a quoted schema list",
      'SECURITY INVOKER SET search_path=pg_catalog,"public"',
      'SECURITY INVOKER SET search_path=pg_catalog,"public",pg_temp',
      "pg_catalog, public, pg_temp",
    ],
    [
      "treating a string literal as a search_path clause",
      "SECURITY INVOKER SET other TO 'SET search_path=pg_catalog,public'",
      "SECURITY INVOKER SET other TO 'SET search_path=pg_catalog,public,pg_temp'",
      null,
    ],
    [
      "adding SET search_path when prior had none",
      "SECURITY INVOKER",
      "SECURITY INVOKER SET search_path = pg_catalog, pg_temp",
      "pg_catalog, pg_temp",
    ],
    [
      "changing STABLE to VOLATILE alongside pg_temp",
      "STABLE SECURITY INVOKER SET search_path = pg_catalog, public",
      "VOLATILE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp",
      "pg_catalog, public, pg_temp",
    ],
    [
      "changing STABLE to VOLATILE after the tightened search_path clause",
      "SECURITY INVOKER SET search_path = pg_catalog, public STABLE",
      "SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp VOLATILE",
      "pg_catalog, public, pg_temp",
    ],
    [
      "changing whitespace in a SET literal alongside pg_temp",
      "SECURITY INVOKER SET application_name TO 'a b' SET search_path = pg_catalog, public",
      "SECURITY INVOKER SET application_name TO 'a  b' SET search_path = pg_catalog, public, pg_temp",
      "pg_catalog, public, pg_temp",
    ],
    [
      "changing VOLATILE to STABLE alongside pg_temp",
      "VOLATILE SECURITY INVOKER SET search_path = pg_catalog, public",
      "STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp",
      "pg_catalog, public, pg_temp",
    ],
    [
      "changing SECURITY INVOKER to SECURITY DEFINER alongside pg_temp",
      "SECURITY INVOKER SET search_path = pg_catalog, public",
      "SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp",
      "pg_catalog, public, pg_temp",
    ],
    [
      "changing SECURITY DEFINER to SECURITY INVOKER alongside pg_temp",
      "SECURITY DEFINER SET search_path = pg_catalog, public",
      "SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp",
      "pg_catalog, public, pg_temp",
    ],
  ])("refuses %s", (_label, priorAttrs, nextAttrs, slotSearchPath) => {
    expect(() => nativeReplacementCheck(priorAttrs, nextAttrs, slotSearchPath))
      .toThrow("reviewed native store replacement header drifted");
  });

  it.each([
    [
      "SECURITY DEFINER",
      "SECURITY DEFINER SET search_path = pg_catalog, public",
      "SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp",
    ],
    [
      "SECURITY INVOKER",
      "SECURITY INVOKER SET search_path = pg_catalog, public",
      "SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp",
    ],
  ])("refuses %s pg_temp tightening when slot.replacedFunctions[].searchPath stays pinned to the old value", (_label, priorAttrs, nextAttrs) => {
    expect(() => nativeReplacementCheck(priorAttrs, nextAttrs, "pg_catalog, public"))
      .toThrow("reviewed native store unpinned SECURITY DEFINER or search_path");
  });

  describe("expectedReplacedFunctionAttrs (catalog parity)", () => {
    const baseAttrs = (proconfig: unknown) => ({ prosecdef: true, provolatile: "v", proconfig });

    it("tightens a single search_path proconfig entry with trailing , pg_temp and preserves other entries and attrs", () => {
      const oldSingle = baseAttrs(["search_path=pg_catalog, public"]);
      expect(expectedReplacedFunctionAttrs(oldSingle, "pg_catalog, public, pg_temp")).toEqual(
        baseAttrs(["search_path=pg_catalog, public, pg_temp"]),
      );
      expect(oldSingle.proconfig).toEqual(["search_path=pg_catalog, public"]);

      const oldWithOtherGuc = baseAttrs(["work_mem=4MB", "search_path=pg_catalog"]);
      expect(expectedReplacedFunctionAttrs(oldWithOtherGuc, "pg_catalog, pg_temp")).toEqual(
        baseAttrs(["work_mem=4MB", "search_path=pg_catalog, pg_temp"]),
      );
    });

    it("keeps attrs unchanged when proconfig already matches the tightened search_path (e.g. qualified-v2)", () => {
      const alreadyTightened = baseAttrs(["search_path=pg_catalog, public, pg_temp"]);
      expect(expectedReplacedFunctionAttrs(alreadyTightened, "pg_catalog, public, pg_temp")).toBe(alreadyTightened);
    });

    it.each([
      ["slot pins null searchPath", ["search_path=pg_catalog, public"], null],
      ["unchanged search_path without tightening", ["search_path=pg_catalog, public"], "pg_catalog, public"],
      ["dropping pg_temp", ["search_path=pg_catalog, public, pg_temp"], "pg_catalog, public"],
      ["prior already has pg_temp", ["search_path=pg_catalog, pg_temp"], "pg_catalog, pg_temp, pg_temp"],
      ["prior already has uppercase PG_TEMP", ["search_path=pg_catalog, PG_TEMP"], "pg_catalog, PG_TEMP, pg_temp"],
      ["prior already has pg_temp_1", ["search_path=pg_catalog, pg_temp_1"], "pg_catalog, pg_temp_1, pg_temp"],
      ["uppercase PG_TEMP target", ["search_path=pg_catalog, public"], "pg_catalog, public, PG_TEMP"],
      ["reordering schemas", ["search_path=public, pg_catalog"], "pg_catalog, public, pg_temp"],
      ["appending non-pg_temp schema", ["search_path=pg_catalog, public"], "pg_catalog, public, extra"],
      ["prior proconfig is null", null, "pg_catalog, pg_temp"],
      ["prior proconfig has no search_path", ["work_mem=4MB"], "pg_catalog, pg_temp"],
      ["prior proconfig has duplicate search_path entries", ["search_path=pg_catalog", "search_path=public"], "pg_catalog, pg_temp"],
    ])("does not allow tightening for %s", (_label, oldProconfig, slotSearchPath) => {
      const oldAttrs = baseAttrs(oldProconfig);
      expect(expectedReplacedFunctionAttrs(oldAttrs, slotSearchPath)).toBe(oldAttrs);
    });
  });
});

describe("PostgreSQL suite closures SQL guard", () => {
  const closuresJson = (suites: Record<string, string[]>, schemaVersion = 1) =>
    `${JSON.stringify({ schemaVersion, suites }, null, 2)}\n`;
  const initialClosures = closuresJson({
    "tests/postgres/a.test.ts": ["@api", "tests/postgres/a.fixture.ts"],
    "tests/postgres/m.test.ts": ["@starter"],
  });

  function setupGuardRepo(
    put: (path: string, bytes: string | Buffer) => void,
    commit: () => string,
  ) {
    put(PLATFORM_BASELINE_FILE, before);
    put("config/reviewed-platform-forwards.json", encode(registry()));
    put(PG_SUITE_CLOSURES_PATH, initialClosures);
    return commit();
  }

  it.each(["db/platform/migrations/20990101000000_expand.sql", "supabase/migrations/20990101000000_expand.sql"])(
    "allows appending new suites and new inputs alongside added SQL in %s",
    (sqlPath) => {
      nativeGitFixture(({ folder, put, commit }) => {
        const base = setupGuardRepo(put, commit);
        put(sqlPath, "CREATE TABLE public.fixture_expand (id uuid);\n");
        put(PG_SUITE_CLOSURES_PATH, closuresJson({
          "tests/postgres/a.test.ts": ["@api", "tests/postgres/a.fixture.ts", "tests/postgres/b.fixture.ts"],
          "tests/postgres/m.test.ts": ["@starter"],
          "tests/postgres/z.test.ts": ["@src"],
        }));
        const head = commit();
        expect(() => assertAppendOnlyPostgresSuiteClosures(folder, base, head)).not.toThrow();
        expect(() => assertCoLocatedForwardApproval(folder, base, head)).not.toThrow();
      });
    },
  );

  it("allows removing or narrowing suite closures in non-SQL cleanup commits", () => {
    nativeGitFixture(({ folder, git, put, commit }) => {
      const base = setupGuardRepo(put, commit);
      put("README.md", "cleanup note\n");
      put(PG_SUITE_CLOSURES_PATH, closuresJson({ "tests/postgres/m.test.ts": [] }));
      const head = commit();
      expect(() => assertAppendOnlyPostgresSuiteClosures(folder, base, head)).not.toThrow();
      expect(() => assertCoLocatedForwardApproval(folder, base, head)).not.toThrow();

      git("rm", PG_SUITE_CLOSURES_PATH);
      const deletedHead = commit();
      expect(() => assertAppendOnlyPostgresSuiteClosures(folder, base, deletedHead)).not.toThrow();
    });
  });

  it.each<[string, string | null]>([
    ["removing a suite", closuresJson({ "tests/postgres/m.test.ts": ["@starter"] })],
    ["removing an input from an existing suite", closuresJson({ "tests/postgres/a.test.ts": ["@api"], "tests/postgres/m.test.ts": ["@starter"] })],
    ["deleting the closures file", null],
    ["changing schemaVersion", closuresJson({ "tests/postgres/a.test.ts": ["@api", "tests/postgres/a.fixture.ts"], "tests/postgres/m.test.ts": ["@starter"] }, 2)],
    ["adding a control suite", closuresJson({ "tests/postgres/a.test.ts": ["@api", "tests/postgres/a.fixture.ts"], "tests/postgres/m.test.ts": ["@starter"], "tests/postgres/subscriptionExactInstallation.test.ts": [] })],
    ["unsorted inputs", closuresJson({ "tests/postgres/a.test.ts": ["tests/postgres/a.fixture.ts", "@api"], "tests/postgres/m.test.ts": ["@starter"] })],
    ["unknown @axis", closuresJson({ "tests/postgres/a.test.ts": ["@api", "tests/postgres/a.fixture.ts"], "tests/postgres/m.test.ts": ["@starter"], "tests/postgres/z.test.ts": ["@unknown"] })],
    ["broad tests/postgres/ prefix", closuresJson({ "tests/postgres/a.test.ts": ["@api", "tests/postgres/a.fixture.ts"], "tests/postgres/m.test.ts": ["@starter"], "tests/postgres/z.test.ts": ["tests/postgres/"] })],
  ])("refuses %s alongside newly added SQL across direct guard and co-located queue check", (_label, candidate) => {
    nativeGitFixture(({ folder, git, put, commit }) => {
      const base = setupGuardRepo(put, commit);
      put("db/platform/migrations/20990101000000_expand.sql", "CREATE TABLE public.fixture_expand (id uuid);\n");
      if (candidate === null) git("rm", PG_SUITE_CLOSURES_PATH);
      else put(PG_SUITE_CLOSURES_PATH, candidate);
      const head = commit();
      expect(() => assertAppendOnlyPostgresSuiteClosures(folder, base, head)).toThrow();
      expect(() => assertCoLocatedForwardApproval(folder, base, head)).toThrow();
    });
  });

  it("refuses symlink replacement of PostgreSQL suite closures alongside newly added SQL", () => {
    nativeGitFixture(({ folder, git, put, commit }) => {
      const base = setupGuardRepo(put, commit);
      put("db/platform/migrations/20990101000000_expand.sql", "CREATE TABLE public.fixture_expand (id uuid);\n");
      put("config/other.json", initialClosures);
      git("rm", PG_SUITE_CLOSURES_PATH);
      symlinkSync("other.json", resolve(folder, PG_SUITE_CLOSURES_PATH));
      const head = commit();
      expect(() => assertAppendOnlyPostgresSuiteClosures(folder, base, head)).toThrow("reviewed replacement requires a regular file");
      expect(() => assertCoLocatedForwardApproval(folder, base, head)).toThrow("reviewed replacement requires a regular file");
    });
  });
});
