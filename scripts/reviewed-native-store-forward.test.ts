import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PLATFORM_BASELINE_FILE } from "./platform-migration-manifest.ts";
import { assertAdmittedPlatformForward } from "./oss-source-release-contract.ts";
import { waitNativeAdmission } from "./agent-review-queue.mjs";
import { captureCommittedReviewCandidate, git as reviewGit } from "./agent-review-session.mjs";
import { prepareCandidate, receiptSummary, recordReport, RECEIPT_MARKER } from "./agent-review-decide.mjs";
import { NATIVE_CATALOG_CONTROLS, assertCoLocatedForwardApproval, assertNativeStoreForward, assertReviewedPlatformForward, assertUnchangedForwardApproval, nativeStoreFunctionDefinitions, reviewedFunctionDefinitions, sqlStatements, isExpandOnlyPlatformForward, changedForwardApprovals, readReviewedForwardRegistry, sqlSha256, type NativeStoreForwardClass, type NativeStoreSlot, type ReviewedForwardRegistry } from "./reviewed-platform-forward.ts";

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
    for (const slot of control.slots) expect(production.nativeStoreForwardClass!.slots.some(real => real.path === slot.path)).toBe(false);
    expect(control.slots).toHaveLength(7);
    const old = structuredClone(production); delete old.nativeStoreForwardClass; delete old.nativeStoreForwards;
    expect(() => readReviewedForwardRegistry(encode(old))).not.toThrow();
  });
  it.each(["eighth slot", "wrong rail", "unknown row", "wrong order", "duplicate slot", "before last forward", "unknown signature type", "bad before hash", "CHECK on another row"])("refuses %s", attack => {
    const value = registry(), slots = value.nativeStoreForwardClass!.slots;
    if (attack === "eighth slot") slots.push(structuredClone(slots[0]!));
    if (attack === "wrong rail") slots[0]!.path = slots[0]!.path.replace("db/platform", "supabase");
    if (attack === "unknown row") slots[0]!.row = "G5";
    if (attack === "wrong order") slots.reverse();
    if (attack === "duplicate slot") slots[1] = structuredClone(slots[0]!);
    if (attack === "before last forward") slots[0]!.path = "db/platform/migrations/20261030121900_fixture.sql";
    if (attack === "unknown signature type") slots[0]!.replacedFunctions[0]!.signature = "public.fixture_existing(regclass)";
    if (attack === "bad before hash") slots[0]!.replacedFunctions[0]!.beforeSha256 = "bad";
    if (attack === "CHECK on another row") slots[0]!.purposeCheck = slots[6]!.purposeCheck;
    expect(() => readReviewedForwardRegistry(encode(value))).toThrow(/reviewed native store/u);
  });
  it("refuses inventory changes in SQL approvals and adding or changing a slot after S1 sealing", () => {
    const prior = registry(), next = registry(); next.nativeStoreForwardClass!.slots.pop();
    expect(() => changedForwardApprovals(encode(prior), encode(next))).toThrow(/approved separately/u);
    prior.nativeStoreForwardClass!.sealed = true;
    next.nativeStoreForwardClass!.sealed = true;
    expect(() => changedForwardApprovals(encode(prior), encode(next))).toThrow(/after S1/u);
    const partial = registry(); partial.nativeStoreForwardClass!.slots.pop(); partial.nativeStoreForwardClass!.sealed = true;
    const added = registry(); added.nativeStoreForwardClass!.sealed = true;
    expect(() => changedForwardApprovals(encode(partial), encode(added))).toThrow(/after S1/u);
    added.nativeStoreForwardClass!.sealed = false;
    expect(() => changedForwardApprovals(encode(prior), encode(added))).toThrow(/after S1/u);
  });
  it("refuses replacing one normalized signature in a second slot", () => {
    const value = registry();
    value.nativeStoreForwardClass!.slots[1]!.replacedFunctions.push(structuredClone(control.slots[0]!.replacedFunctions[0]!));
    expect(() => readReviewedForwardRegistry(encode(value))).toThrow(/replaced by only one slot/u);
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
    expect(() => assertNativeStoreForward(value, pin.path, Buffer.from(text), [{ path: PLATFORM_BASELINE_FILE, bytes: before }])).toThrow(/earlier slot/u);
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
    if (attack === "quoted intervening DDL") preceding.push({ path: "db/platform/migrations/20261101231999_fixture_history.sql", bytes: Buffer.from('ALTER TABLE "public"."communication_native_sync_state" ADD COLUMN fixture_note text;') });
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
  it("pins only firm production rows and finds every replacement/grant-only signature in the immutable base prefix", () => {
    const slots = production.nativeStoreForwardClass!.slots;
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
  it.each(["pull_request", "merge_group"])("refuses unbound expand-only reserved SQL at native %s admission", async eventName => {
    mkdirSync(".context/scratch", { recursive: true });
    const folder = mkdtempSync(resolve(".context/scratch/native-store-queue-"));
    const git = (...args: string[]) => execFileSync("git", ["-C", folder, "-c", "user.name=Control Test", "-c", "user.email=control@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
    const put = (path: string, bytes: Buffer | string) => { mkdirSync(dirname(resolve(folder, path)), { recursive: true }); writeFileSync(resolve(folder, path), bytes); };
    const commit = () => { git("add", "."); git("commit", "-qm", "Synthetic queue witness"); return git("rev-parse", "HEAD"); };
    try {
      git("init", "-q", "-b", "main"); put("config/reviewed-platform-forwards.json", encode(registry())); const base = commit();
      git("update-ref", "refs/remotes/origin/main", base);
      put(control.slots[0]!.path, "CREATE TABLE public.fixture_unbound (id uuid);"); const head = commit();
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
  it("requires prior class approval, feature pins, unchanged controls and immutable issued SQL", () => {
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
      expect(() => assertCoLocatedForwardApproval(folder, base, mixed)).toThrow(/machinery/u);
      git("reset", "--hard", feature);
      // The real-PostgreSQL catalog test is the truth for function attributes: a feature PR cannot edit it, or the named
      // files that select, run and containerize it, unseen. Code those files run is a review duty, not a control.
      for (const control of [...NATIVE_CATALOG_CONTROLS, "tests/setup/disposable-docker.ts"]) {
        put(control, "// Changed catalog test input"); const controlEdit = commit();
        expect(() => assertCoLocatedForwardApproval(folder, base, controlEdit), control).toThrow(/machinery/u);
        git("reset", "--hard", feature);
      }
      const changed = structuredClone(value); changed.nativeStoreForwardClass!.slots[0]!.replacedFunctions[0]!.searchPath = null;
      put(registryPath, encode(changed)); const enlarged = commit();
      expect(() => assertCoLocatedForwardApproval(folder, base, enlarged)).toThrow(/approved separately/u);
      git("reset", "--hard", feature);
      value.nativeStoreForwards![0]!.sha256 = sqlSha256(text + " "); put(registryPath, encode(value)); const repin = commit();
      expect(() => assertCoLocatedForwardApproval(folder, feature, repin)).toThrow(/immutable/u);
      git("reset", "--hard", base);
      const unknown = path.replace("fixture_1", "unknown"); const expand = "CREATE TABLE public.fixture_unknown (id uuid);";
      put(unknown, expand); const unbound = commit();
      expect(() => assertAdmittedPlatformForward(folder, base, unbound, unknown, Buffer.from(expand))).toThrow(/reviewed replacement path/u);
      expect(() => assertCoLocatedForwardApproval(folder, base, unbound)).toThrow(/prior exact slot/u);
      git("reset", "--hard", base);
      const noClass = registry(); delete noClass.nativeStoreForwardClass; delete noClass.nativeStoreForwards;
      put(registryPath, encode(noClass)); const older = commit();
      const initial = registry(); bind(initial, 0, text); put(registryPath, encode(initial)); put(path, text); const simultaneous = commit();
      expect(() => assertCoLocatedForwardApproval(folder, older, simultaneous)).toThrow(/approved separately/u);
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
  it("keeps the slots in order with four feature bindings, without sealing or whole-file class pins", () => {
    const slots = production.nativeStoreForwardClass!.slots;
    expect(slots.map(slot => slot.row)).toEqual(["G6", "G2", "G4", "G3", "G7", "G8", "G11-c"]);
    expect(production.nativeStoreForwardClass!.sealed).toBe(false);
    expect(production.nativeStoreForwards!.map(pin => pin.path)).toEqual(slots.slice(0, 7).map(slot => slot.path));
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
  it.each(g4g3.listRefusals)("refuses $label in the pinned class list before SQL exists", attack => {
    const value = registry(), statements = attack.order?.map(index => g4g3.g4Statements[index]!) ?? [...g4g3.g4Statements];
    if (attack.replace !== undefined) statements[attack.replace] = attack.sql!;
    value.nativeStoreForwardClass!.slots[2]!.existingTableStatements = statements;
    expect(() => readReviewedForwardRegistry(encode(value))).toThrow(/existing-table list is pinned/u);
  });
  it("refuses the pinned list on another slot during class validation", () => {
    const value = registry(); value.nativeStoreForwardClass!.slots[0]!.existingTableStatements = [...g4g3.g4Statements];
    expect(() => readReviewedForwardRegistry(encode(value))).toThrow(/G4-only/u);
  });
  it("requires a list target in the prefix, not a new table created by this file", () => {
    const value = registry(), preceding = [{ path: PLATFORM_BASELINE_FILE, bytes: before }];
    value.nativeStoreForwardClass!.slots[2]!.existingTableStatements = [...g4g3.g4Statements];
    for (let index = 0; index < 2; index++) {
      const source = sql(index), pin = bind(value, index, source);
      preceding.push({ path: pin.path, bytes: Buffer.from(source) });
    }
    const text = `${g4g3.prefix}\n${g4()}`, pin = bind(value, 2, text);
    expect(() => assertNativeStoreForward(value, pin.path, Buffer.from(text), preceding)).toThrow(/target absent from prefix/u);
  });
  it("keeps exact-statement inventory changes separate from feature approval changes", () => {
    const prior = registry(), next = registry();
    next.nativeStoreForwardClass!.slots[2]!.existingTableStatements = [...g4g3.g4Statements];
    expect(() => changedForwardApprovals(encode(prior), encode(next))).toThrow(/approved separately/u);
    prior.nativeStoreForwardClass!.sealed = true; next.nativeStoreForwardClass!.sealed = true;
    expect(() => changedForwardApprovals(encode(prior), encode(next))).toThrow(/after S1/u);
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
