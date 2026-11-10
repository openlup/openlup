import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PLATFORM_BASELINE_FILE } from "./platform-migration-manifest.ts";
import { assertAdmittedPlatformForward } from "./oss-source-release-contract.ts";
import { waitNativeAdmission } from "./agent-review-queue.mjs";
import { captureCommittedReviewCandidate, git as reviewGit } from "./agent-review-session.mjs";
import { prepareCandidate, receiptSummary, recordReport, RECEIPT_MARKER } from "./agent-review-decide.mjs";
import { NATIVE_CATALOG_CONTROLS, isNativeStoreMigrationPath, assertCoLocatedForwardApproval, assertNativeStoreForward, assertReviewedPlatformForward, assertUnchangedForwardApproval, nativeStoreFunctionDefinitions, reviewedFunctionDefinitions, sqlStatements, isExpandOnlyPlatformForward, changedForwardApprovals, readReviewedForwardRegistry, sqlSha256, type NativeStoreForwardClass, type NativeStoreSlot, type ReviewedForwardRegistry } from "./reviewed-platform-forward.ts";

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

describe("the sole conditional role rule", () => {
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
  it("keeps the issued slot and binding prefix in order, without sealing or whole-file class pins", () => {
    const slots = production.nativeStoreForwardClass!.slots.slice(0, 7);
    expect(slots.map(slot => slot.row)).toEqual(["G6", "G2", "G4", "G3", "G7", "G8", "G11-c"]);
    expect(production.nativeStoreForwardClass!.sealed).toBe(false);
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
  it("admits both guarded existing-table trigger shapes with PUBLIC and conditional revokes", () => {
    const revokes = ["anon", "authenticated", "service_role"].map(role => block(role, "REVOKE ALL", "public.fixture_trigger_guard()")).join("\n");
    expect(() => triggerForward(triggerBefore, `${triggerAfter}\n${revokes}`, slot => {
      slot.createdTriggers!.push({ name: "fixture_trigger_event", table: "public.fixture_row", sha256: sqlSha256(triggerAfter) });
    })).not.toThrow();
  });
  it.each([
    ["WHEN", triggerBefore.replace("FOR EACH ROW EXECUTE", "FOR EACH ROW WHEN (true) EXECUTE")],
    ["FOR EACH STATEMENT", triggerBefore.replace("FOR EACH ROW", "FOR EACH STATEMENT")],
    ["CONSTRAINT TRIGGER", triggerBefore.replace("CREATE TRIGGER", "CREATE CONSTRAINT TRIGGER")],
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
    put(path, text); put("tests/postgres/nativeStoreForwardCatalog.test.ts", "// Changed observer"); const head = commit();
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
    put(path, text); put("tests/postgres/nativeStoreForwardCatalog.test.ts", "// Ordinary additive test change"); const head = commit();
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
