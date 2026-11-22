import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { env } from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import { needsForwardApproval } from "./agent-review-queue.mjs";
import { assertAppendOnlyMigrationHistory } from "./oss-published-tree-check.ts";
import { assertAdmittedPlatformForward } from "./oss-source-release-contract.ts";
import { PLATFORM_BASELINE_FILE, PLATFORM_MIGRATION_MANIFEST, sha256 } from "./platform-migration-manifest.ts";
import { assertNativeStoreForward, isExpandOnlyPlatformForward, assertCoLocatedForwardApproval, hasExactManagedForward, managedForwardPrefixSha256, readReviewedForwardRegistry, renderQualifiedSecurityDefiner, REVIEWED_FORWARD_PATH, sqlSha256, type NativeStoreSlot, type ReviewedForwardRegistry } from "./reviewed-platform-forward.ts";
import { admissionRuleFiles } from "./sql-admit.ts";

const CLI = resolve("scripts/sql-admit.ts");
const MANAGED_BASELINE = "supabase/migrations/00000000000000_platform_schema_baseline.sql";
const RAILS = ["db/platform/migrations/", "supabase/migrations/"];
const production = readReviewedForwardRegistry(readFileSync(REVIEWED_FORWARD_PATH));
const baseline = readFileSync("scripts/fixtures/reviewed-native-store/before.sql", "utf8");
const encode = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const slot = (path: string, row = "Future"): NativeStoreSlot => ({ row, path, replacedFunctions: [], createdFunctions: [], grantOnlyFunctions: [], dataStatements: [] });
const manifest = (forward: { file: string; sha256: string }[], baselineSql = baseline) =>
  encode({ schemaVersion: 1, baseline: { file: PLATFORM_BASELINE_FILE, sha256: sha256(baselineSql) }, forward, objectInventorySha256: "0".repeat(64) });
// An independent synthetic registry, as in the native store witness: an empty sealed class and no issued qualified approval.
function registry(): ReviewedForwardRegistry {
  const value = structuredClone(production);
  delete value.portableReplacementForwards; delete value.portableCreationForwards; delete value.batchedForwards;
  delete value.managedCommerceForwards; delete value.supportAuthorityForwards; delete value.channelIngestForwards; delete value.qualifiedInstallations;
  value.nativeStoreForwardClass = { sealed: true, slots: [] }; value.nativeStoreForwards = [];
  return value;
}

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
type Fixture = ReturnType<typeof fixture>;
function fixture(baselineSql = baseline) {
  const root = mkdtempSync(join(tmpdir(), "openlup-sql-admit-fixture-"));
  roots.push(root);
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" }).trim();
  const put = (path: string, value: string | Buffer) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), value); };
  const commit = () => { git("add", "--all"); git("commit", "-qm", "SQL admission fixture"); return git("rev-parse", "HEAD"); };
  git("init", "-q", "-b", "main");
  put(PLATFORM_BASELINE_FILE, baselineSql); put(MANAGED_BASELINE, "-- Synthetic managed baseline.\n");
  put(PLATFORM_MIGRATION_MANIFEST, manifest([], baselineSql)); put(REVIEWED_FORWARD_PATH, encode(registry()));
  return { root, git, put, commit, baselineSql, base: commit() };
}
// Fixture bases hold no admission code, so the version check would refuse them; the stale-rules tests below cover that gate.
const STALE = "--allow-stale-rules";
function cli(root: string, args: string[], extra?: Record<string, string>) {
  return spawnSync(process.execPath, ["--experimental-strip-types", CLI, ...args], { cwd: root, encoding: "utf8", timeout: 60_000, ...(extra ? { env: { ...env, ...extra } } : {}) });
}
const verdictLines = (stdout: string) => stdout.split("\n").flatMap((line) => {
  const match = /^(PASS|REFUSED) +(.+?) \[(.+?)\](?:: (.*))?$/u.exec(line);
  return match ? [match[4] === undefined ? [match[1]!] : [match[1]!, match[4]]] : [];
});

function repositorySnapshot(f: Fixture, files: string[]) {
  return {
    refs: f.git("for-each-ref", "--format=%(refname) %(objectname)"), head: f.git("symbolic-ref", "HEAD"), commit: f.git("rev-parse", "HEAD"),
    index: createHash("sha256").update(readFileSync(join(f.root, ".git/index"))).digest("hex"),
    status: f.git("--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all", "--ignored"), objects: f.git("count-objects", "-v"),
    files: files.map((path) => existsSync(join(f.root, path)) ? readFileSync(join(f.root, path), "utf8") : null),
  };
}

// The underlying checks, called directly on the same commits: the self-check on main and the PR merge commit,
// then, when the queue's trigger applies, its guard on the PR's own fork point and on the merge-group head.
function directVerdicts(f: Fixture, base: string, head: string) {
  const fork = f.git("merge-base", base, head);
  const merge = f.git("commit-tree", f.git("merge-tree", "--write-tree", base, head).split("\n")[0]!, "-p", base, "-p", head, "-m", "Synthetic pull-request merge");
  f.git("checkout", "-q", "--detach", merge);
  const verdict = (action: () => void) => { try { action(); return ["PASS"]; } catch (error) { return ["REFUSED", (error as Error).message]; } };
  const added = f.git("diff", "--name-only", "--no-renames", "--diff-filter=A", base, merge, "--", ...RAILS).split("\n").filter((path) => path.endsWith(".sql"));
  const verdicts = added.map((path) => verdict(() => assertAdmittedPlatformForward(f.root, base, merge, path, readFileSync(join(f.root, path)))));
  verdicts.push(verdict(() => assertAppendOnlyMigrationHistory(f.root, base, merge)));
  if (!needsForwardApproval(f.git("diff", "--name-only", "--no-renames", fork, head).split("\n"), path => hasExactManagedForward(f.root, fork, path) || hasExactManagedForward(f.root, base, path))) verdicts.push(["PASS"]);
  else verdicts.push(verdict(() => assertCoLocatedForwardApproval(f.root, fork, head)), verdict(() => assertCoLocatedForwardApproval(f.root, base, merge)));
  return { verdicts, fork };
}

const nativePath = "db/platform/migrations/20271106100000_future.sql", nativeText = "CREATE TABLE public.future (id uuid);\n";
function stageNativeForward(f: Fixture, text = nativeText, entry = slot(nativePath), functions: NonNullable<ReviewedForwardRegistry["nativeStoreForwards"]>[number]["functions"] = []) {
  const value = registry();
  value.nativeStoreForwardClass!.slots.push(entry); value.nativeStoreForwards!.push({ path: entry.path, sha256: sqlSha256(text), functions });
  f.put(REVIEWED_FORWARD_PATH, encode(value)); f.put(PLATFORM_MIGRATION_MANIFEST, manifest([{ file: entry.path, sha256: sha256(text) }], f.baselineSql)); f.put(entry.path, text);
}

const authorityPath = "db/platform/migrations/q2_20261123192500_catalog_publication_authority.sql";
const authoritySha256 = sha256(readFileSync(authorityPath));
const ledgerGuard = `    AND EXISTS (SELECT 1 FROM ONLY public.platform_schema_migrations
      WHERE catalog_path OPERATOR(pg_catalog.=) '${authorityPath}'::pg_catalog.text
        AND sha256 OPERATOR(pg_catalog.=) '${authoritySha256}'::pg_catalog.text)
`;

describe("qualified catalogue read grant in sql:admit and hosted checks", () => {
  const text = `DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='openlup_catalog_publication')
${ledgerGuard}  THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.catalog_offer_memberships_page(text,jsonb,integer,text),
      public.catalog_publication_activation_readiness(text[],text) TO openlup_catalog_publication;';
  END IF;
END; $$;
`;
  const predecessors = ["20261124120000_catalog_publication_reads.sql", "20261124140000_catalog_publication_readiness.sql"]
    .map(file => `db/platform/migrations/${file}`);
  const coLocated = "reviewed replacement admission machinery must be approved separately before co-located SQL/pins";
  const unissued = `reviewed native store qualified catalogue read predecessor must already be issued: ${predecessors[0]}`;
  const noAuthorityLedger = "reviewed native store qualified catalogue read forward must contain exactly the EXECUTE grant guarded by role existence and the authority ledger path and hash";
  const pass = ["PASS"];
  const refuse = (message: string) => ["REFUSED", message];

  function stagePredecessors(f: Fixture) {
    const value = registry();
    value.nativeStoreForwardClass!.slots = production.nativeStoreForwardClass!.slots.filter(entry => predecessors.includes(entry.path));
    value.nativeStoreForwards = production.nativeStoreForwards!.filter(pin => predecessors.includes(pin.path));
    for (const path of predecessors) f.put(path, readFileSync(path));
    f.put(REVIEWED_FORWARD_PATH, encode(value));
    const rows = value.nativeStoreForwards.map(pin => ({ file: pin.path, sha256: pin.sha256 }));
    f.put(PLATFORM_MIGRATION_MANIFEST, manifest(rows));
    return { value, rows };
  }

  it.each([
    ["issued predecessors", 0, [pass, pass, pass, pass]],
    ["a co-located rule change", 1, [pass, pass, refuse(coLocated), refuse(coLocated)]],
    ["co-introduced predecessors", 1, [pass, pass, refuse(unissued), refuse(unissued), refuse(unissued), refuse(unissued)]],
    ["the old function lookup without the authority ledger", 1, Array.from({ length: 4 }, () => refuse(noAuthorityLedger))],
  ] as const)("checks %s for the qualified catalogue read grant", (scenario, exit, expected) => {
    const f = fixture(), { value, rows } = stagePredecessors(f);
    const base = scenario === "co-introduced predecessors" ? f.base : f.commit();
    const entry = slot(nativePath, "catalogue-read-grant");
    entry.grantOnlyFunctions = ["public.catalog_offer_memberships_page(text,jsonb,integer,text)", "public.catalog_publication_activation_readiness(text[],text)"]
      .map(signature => ({ signature, grantTo: ["openlup_catalog_publication"], revokeFrom: [] }));
    const sql = scenario === "the old function lookup without the authority ledger"
      ? text.replace(ledgerGuard, "    AND pg_catalog.to_regprocedure('public.catalog_publication_bind_live_write()') IS NOT NULL\n") : text;
    value.nativeStoreForwardClass!.slots.push(entry);
    value.nativeStoreForwards!.push({ path: nativePath, sha256: sqlSha256(sql), functions: [] });
    f.put(REVIEWED_FORWARD_PATH, encode(value));
    f.put(PLATFORM_MIGRATION_MANIFEST, manifest([...rows, { file: nativePath, sha256: sha256(sql) }]));
    f.put(nativePath, sql);
    if (scenario === "a co-located rule change") f.put("scripts/reviewed-platform-forward.ts", "// Changed admission rule.\n");
    const head = f.commit();
    const result = cli(f.root, ["--base", base, "--head", head, STALE]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(exit);
    const reported = verdictLines(result.stdout);
    expect(reported).toEqual(directVerdicts(f, base, head).verdicts);
    expect(reported).toEqual(expected);
  }, 20_000);
});

describe("qualified price list basis SELECT in sql:admit and hosted checks", () => {
  const column = "db/platform/migrations/20990102000000_price_list_basis_column.sql";
  const outside = "db/platform/migrations/20990101000000_price_list_basis_outside_slot.sql";
  const path = "db/platform/migrations/20990103000000_price_list_basis_read.sql";
  const guarded = `DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='openlup_catalog_publication')
${ledgerGuard}  THEN
    EXECUTE 'GRANT SELECT (amount_basis) ON TABLE public.price_lists TO openlup_catalog_publication;';
  END IF;
END; $$;
`;
  const addColumn = "ALTER TABLE public.price_lists ADD COLUMN amount_basis text;";
  const addCheck = "ALTER TABLE public.price_lists ADD CONSTRAINT price_lists_basis_check CHECK (amount_basis IN ('tax_inclusive', 'tax_exclusive'));";
  const columnSql = `${addColumn}\n${addCheck}\n`;
  const pass = ["PASS"];
  const ruleChange = ["REFUSED", "reviewed replacement admission machinery must be approved separately before co-located SQL/pins"];
  const unissued = ["REFUSED", `reviewed native store qualified price list basis SELECT predecessor must already be issued: ${column}`];
  const unregistered = ["REFUSED", `non-expand-only forward differs from reviewed replacement path or bytes: ${outside}`];

  it.each([
    ["an issued predecessor", 0, [pass, pass, pass, pass]],
    ["a co-introduced predecessor", 1, [pass, unissued, unissued, unissued, unissued]],
    ["the grant outside a declared slot", 1, [unregistered, pass, unregistered, pass, pass]],
    ["a co-located rule change", 1, [pass, pass, ruleChange, ruleChange]],
  ] as const)("checks %s for the qualified price list basis SELECT", (scenario, exit, expected) => {
    const f = fixture(`${baseline}\nCREATE TABLE public.price_lists (id uuid);\n`);
    const value = registry(), slots = value.nativeStoreForwardClass!.slots, pins = value.nativeStoreForwards!;
    slots.push({ ...slot(column, "price-list-basis-column"), existingTableStatements: [addColumn, addCheck] });
    pins.push({ path: column, sha256: sha256(columnSql), functions: [] });
    f.put(column, columnSql);
    f.put(REVIEWED_FORWARD_PATH, encode(value));
    f.put(PLATFORM_MIGRATION_MANIFEST, manifest([{ file: column, sha256: sha256(columnSql) }], f.baselineSql));
    const base = scenario === "a co-introduced predecessor" ? f.base : f.commit();
    slots.push({ ...slot(path, "price-list-basis-read"), qualifiedPriceListBasisSelect: true });
    pins.push({ path, sha256: sha256(guarded), functions: [] });
    const rows = pins.map(pin => ({ file: pin.path, sha256: pin.sha256 }));
    if (scenario === "the grant outside a declared slot") {
      f.put(outside, guarded);
      rows.unshift({ file: outside, sha256: sha256(guarded) });
    }
    f.put(path, guarded);
    f.put(REVIEWED_FORWARD_PATH, encode(value));
    f.put(PLATFORM_MIGRATION_MANIFEST, manifest(rows, f.baselineSql));
    if (scenario === "a co-located rule change") f.put("scripts/reviewed-platform-forward.ts", "// Changed admission rule.\n");
    const head = f.commit();
    const result = cli(f.root, ["--base", base, "--head", head, STALE]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(exit);
    const reported = verdictLines(result.stdout);
    expect(reported).toEqual(directVerdicts(f, base, head).verdicts);
    expect(reported).toEqual(expected);
  }, 20_000);
});

const previewNoopSql = `ALTER TABLE public.subscription_quote_previews ADD COLUMN accepted_noop_receipt_id uuid REFERENCES public.subscription_command_receipts(id);
ALTER TABLE public.subscription_quote_previews DROP CONSTRAINT subscription_quote_previews_acceptance_check;
ALTER TABLE public.subscription_quote_previews ADD CONSTRAINT subscription_quote_previews_acceptance_check CHECK (
  (status = 'previewed' AND accepted_at IS NULL AND accepted_idempotency_key IS NULL AND accepted_event_id IS NULL AND accepted_noop_receipt_id IS NULL)
  OR (status = 'accepted' AND accepted_at IS NOT NULL AND accepted_idempotency_key IS NOT NULL AND accepted_event_id IS NOT NULL AND accepted_noop_receipt_id IS NULL)
  OR (status = 'accepted' AND accepted_at IS NOT NULL AND accepted_idempotency_key IS NOT NULL AND accepted_event_id IS NULL AND accepted_noop_receipt_id IS NOT NULL)
);
`;

describe("receipt-backed preview acceptance", () => {
  const sql = previewNoopSql;
  const [column, drop, add, previewed, event, noop] = sql.split("\n") as [string, string, string, string, string, string];
  const path = "db/platform/migrations/20990103000000_preview_noop_acceptance.sql";
  const preimage = "db/platform/migrations/20261109120000_subscription_package_editor.sql";
  const history = "db/platform/migrations/20261109140000_subscription_sized_editor.sql";
  const triggerForward = {
    path: "db/platform/migrations/20990101000000_preview_catalog_trigger.sql",
    bytes: Buffer.from(`CREATE FUNCTION public.preview_catalog_final() RETURNS trigger LANGUAGE plpgsql AS $trigger$
BEGIN
  PERFORM (SELECT id FROM public.subscription_quote_previews WHERE id = NEW.id);
  RETURN NULL;
END;
$trigger$;
CREATE CONSTRAINT TRIGGER subscription_quote_previews_catalog_final AFTER INSERT OR UPDATE OR DELETE ON public.subscription_quote_previews DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.preview_catalog_final();
`),
  };
  const slotError = "preview acceptance requires one slot listing only the receipt column";
  const sqlError = "preview acceptance forward requires exactly the receipt column and adjacent validated CHECK replacement";
  const preimageError = "preview acceptance CHECK preimage file or hash drifted";
  const prefix = () => [PLATFORM_BASELINE_FILE, preimage, history].map(path => ({
    path, bytes: path === PLATFORM_BASELINE_FILE ? Buffer.from(baseline) : readFileSync(path),
  }));
  const entry = (): NativeStoreSlot => ({
    path, row: "preview-noop-acceptance", replacedFunctions: [], createdFunctions: [], grantOnlyFunctions: [], dataStatements: [],
    previewNoopAcceptance: true, existingTableStatements: [column],
  });
  function admit(text = sql, preceding = prefix(), slots = [entry()]) {
    const value = registry();
    value.nativeStoreForwardClass!.slots = slots;
    value.nativeStoreForwards = [{ path, sha256: sqlSha256(text), functions: [] }];
    return assertNativeStoreForward(value, path, Buffer.from(text), preceding);
  }
  it("admits the exact receipt column and adjacent validated CHECK replacement", () => {
    expect(isExpandOnlyPlatformForward(column)).toBe(true);
    expect(admit(sql, [...prefix(), triggerForward]).slot).toEqual(entry());
    const directory = "db/platform/migrations";
    const cutoff = production.nativeStoreForwardClass!.slots.find(slot => slot.previewNoopAcceptance)?.path ?? path;
    const preceding = readdirSync(directory).filter(file => /^\d{14}_.*\.sql$/u.test(file))
      .map(file => `${directory}/${file}`).filter(file => file < cutoff).sort()
      .map(path => ({ path, bytes: readFileSync(path) }));
    expect(admit(sql, preceding).slot).toEqual(entry());
  });
  it.each([
    ["missing preimage", (sources: ReturnType<typeof prefix>) => { sources.splice(1, 1); }],
    ["wrong path for identical preimage bytes", (sources: ReturnType<typeof prefix>) => { sources[1]!.path = "db/platform/migrations/20261109120000_wrong.sql"; }],
    ["drifted preimage hash", (sources: ReturnType<typeof prefix>) => { sources[1]!.bytes = Buffer.concat([sources[1]!.bytes, Buffer.from("\n")]); }],
  ] as const)("refuses %s", (_label, change) => {
    const sources = prefix();
    change(sources);
    expect(() => admit(sql, sources)).toThrow(preimageError);
  });
  it("refuses a later rewrite of the pinned CHECK", () => {
    const path = "db/platform/migrations/20990102000000_rewritten_check.sql";
    const bytes = Buffer.from(`${drop}\n${add}status IS NOT NULL);`);
    expect(() => admit(sql, [...prefix(), { path, bytes }])).toThrow(`preview acceptance CHECK refuses other preview history: ${path}`);
  });
  it.each([
    ["a deferred constraint trigger and its preview-reading function", triggerForward.bytes],
    ["a replacement trigger", "CREATE OR REPLACE TRIGGER preview_final AFTER UPDATE ON public.subscription_quote_previews FOR EACH ROW EXECUTE FUNCTION public.preview_catalog_final();"],
    ["a trigger procedure call with arguments", "CREATE TRIGGER preview_final AFTER UPDATE ON public.subscription_quote_previews FOR EACH ROW WHEN (NEW.id IS NOT NULL) EXECUTE PROCEDURE public.preview_catalog_final(');', 2);"],
    ["a trigger drop", 'DROP TRIGGER IF EXISTS "preview_final" ON "subscription_quote_previews";'],
    ["a trigger comment", `COMMENT ON TRIGGER preview_final ON "public"."subscription_quote_previews" IS 'Finalizes the preview';`],
    ["a grant", "GRANT SELECT ON TABLE public.subscription_quote_previews TO authenticated;"],
    ["a revoke", "REVOKE SELECT ON subscription_quote_previews FROM authenticated;"],
    ["a preview-reading procedure", "CREATE PROCEDURE public.preview_read() LANGUAGE plpgsql AS $$ BEGIN PERFORM (SELECT count(*) FROM public.subscription_quote_previews); END; $$;"],
  ])("admits earlier preview history with %s", (_label, earlierSql) => {
    const bytes = typeof earlierSql === "string" ? Buffer.from(earlierSql) : earlierSql;
    expect(admit(sql, [...prefix(), { ...triggerForward, bytes }]).slot).toEqual(entry());
  });
  const trailingBackslash = String.raw`COMMENT ON TABLE public.other IS 'ends in \';`;
  it("ignores an unrelated file with the review's trailing-backslash comment", () => {
    expect(admit(sql, [...prefix(), { ...triggerForward, bytes: Buffer.from(trailingBackslash) }]).slot).toEqual(entry());
  });
  const triggerCall = "CREATE TRIGGER preview_final AFTER UPDATE ON public.subscription_quote_previews FOR EACH ROW EXECUTE FUNCTION public.preview_catalog_final";
  it.each([
    ["an unclosed argument list", "(;", "cannot split SQL: close all parentheses before the statement terminator"],
    ["trailing tokens after the call", "() trailing;", "preview reference outside the trigger, table privilege and routine-body allowlist"],
  ])("refuses a preview trigger with %s", (_label, tail, reason) => {
    const bytes = Buffer.from(triggerCall + tail);
    expect(() => admit(sql, [...prefix(), { ...triggerForward, bytes }]))
      .toThrow(`preview acceptance CHECK refuses other preview history: ${triggerForward.path}: ${reason}`);
  });
  it.each([
    ["schema-qualified ALTER TABLE", "ALTER TABLE public.subscription_quote_previews ADD COLUMN other uuid;"],
    ["unqualified ALTER TABLE", "alter table SUBSCRIPTION_QUOTE_PREVIEWS add column other uuid;"],
    ["quoted ALTER TABLE", 'ALTER TABLE "public" /* schema */ . "subscription_quote_previews" ADD COLUMN other uuid;'],
    ["ALTER TABLE ONLY", "ALTER TABLE ONLY (public.subscription_quote_previews) ADD COLUMN other uuid;"],
    ["ALTER TABLE IF EXISTS", "ALTER TABLE IF EXISTS ONLY subscription_quote_previews ADD COLUMN other uuid;"],
    ["CREATE TABLE", 'CREATE UNLOGGED TABLE IF NOT EXISTS public."subscription_quote_previews" (id uuid);'],
    ["DROP TABLE", "DROP TABLE IF EXISTS public.retired_previews, subscription_quote_previews;"],
    ["a constraint on previews", "ALTER TABLE public.subscription_quote_previews ADD CONSTRAINT preview_check CHECK (true);"],
    ["a constraint referencing previews", "ALTER TABLE public.other ADD CONSTRAINT preview_fk FOREIGN KEY (preview_id) REFERENCES public.subscription_quote_previews(id);"],
    ["a rename from the preview name", "ALTER TABLE public.subscription_quote_previews RENAME TO retired_previews;"],
    ["a rename into the preview name", 'ALTER TABLE public.other RENAME TO "subscription_quote_previews";'],
    ["a unique index", "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS preview_unique ON ONLY public.subscription_quote_previews(id);"],
    ["a non-unique index", "CREATE INDEX preview_status ON public.subscription_quote_previews(status);"],
    ["an index drop", "DROP INDEX public.subscription_quote_previews_lookup;"],
    ["a table in a different schema", "ALTER TABLE private.subscription_quote_previews ADD COLUMN other uuid;"],
    ["a table comment", "COMMENT ON TABLE public.subscription_quote_previews IS 'Preview rows';"],
    ["the review's CRLF before ADD COLUMN", "ALTER TABLE public.subscription_quote_previews\r\nADD COLUMN other uuid;"],
    ["the review's Unicode schema", 'ALTER TABLE U&"public".subscription_quote_previews ADD COLUMN other uuid;'],
    ["the review's quoted semicolon before a foreign key", 'CREATE TABLE public.other (";" uuid, preview_id uuid REFERENCES public.subscription_quote_previews(id));'],
    ["the review's three-part table name", "ALTER TABLE postgres.public.subscription_quote_previews ADD COLUMN other uuid;"],
    ["the review's dollar sign in the preceding drop target", "DROP TABLE public.other$archive, public.subscription_quote_previews;"],
    ["the review's literal DDL in a DO block", "DO $$ BEGIN ALTER TABLE public.subscription_quote_previews ADD COLUMN other uuid; END; $$;"],
    ["the review's foreign key in a CREATE SCHEMA subcommand", "CREATE SCHEMA review_fixture CREATE TABLE other (preview_id uuid REFERENCES public.subscription_quote_previews(id));"],
    ["the review's primary-key index rename", "ALTER INDEX public.subscription_quote_previews_pkey RENAME TO renamed_preview_pkey;"],
    ["the review's trailing-backslash split error in a mentioning file", trailingBackslash + "\nGRANT SELECT ON public.subscription_quote_previews TO authenticated;"],
    ["a trigger targeting another schema", "CREATE TRIGGER subscription_quote_previews_trigger AFTER UPDATE ON private.subscription_quote_previews FOR EACH ROW EXECUTE FUNCTION public.preview_catalog_final();"],
    ["a trigger targeting a dollar-suffixed table", "CREATE TRIGGER preview_trigger AFTER UPDATE ON public.subscription_quote_previews$archive FOR EACH ROW EXECUTE FUNCTION public.preview_catalog_final();"],
    ["a reference in a routine header", "CREATE FUNCTION public.preview_read() RETURNS SETOF public.subscription_quote_previews LANGUAGE sql AS $$ SELECT 1 $$;"],
    ["a routine body with dynamic DDL", "CREATE PROCEDURE public.preview_write() LANGUAGE plpgsql AS $$ BEGIN EXECUTE 'ALTER TABLE public.subscription_quote_previews ADD COLUMN other uuid'; END; $$;"],
    ["a file with both allowed and unlisted statements", "GRANT SELECT ON public.subscription_quote_previews TO authenticated; COMMENT ON TABLE public.subscription_quote_previews IS 'Preview rows';"],
    ["a preview mention outside any statement", "-- subscription_quote_previews\nSELECT 1;"],
  ])("refuses earlier preview history with %s", (_label, earlierSql) => {
    expect(() => admit(sql, [...prefix(), { ...triggerForward, bytes: Buffer.from(earlierSql) }]))
      .toThrow(`preview acceptance CHECK refuses other preview history: ${triggerForward.path}`);
  });
  it.each([
    ["a missing branch", sql.replace(`${event}\n`, "")],
    ["an extra branch", sql.replace(noop, `${noop}\n  OR (status = 'accepted' AND accepted_at IS NULL)`)],
    ["an altered previewed branch", sql.replace(previewed, previewed.replace("accepted_at IS NULL", "accepted_at IS NOT NULL"))],
    ["an accepted branch with neither event nor receipt", sql.replace(noop, noop.replace("accepted_noop_receipt_id IS NOT NULL", "accepted_noop_receipt_id IS NULL"))],
    ["NOT VALID", sql.replace("\n);", "\n) NOT VALID;")],
    ["a different constraint", sql.replaceAll("subscription_quote_previews_acceptance_check", "other_check")],
    ["a different table", sql.replaceAll("public.subscription_quote_previews", "public.other_previews")],
    ["DROP without ADD", `${column}\n${drop}\n`],
    ["a non-adjacent DROP and ADD", sql.replace(drop, `${drop}\nSELECT 1;`)],
    ["an extra statement", `${sql}SELECT 1;\n`],
    ["an extra column", `${sql}ALTER TABLE public.subscription_quote_previews ADD COLUMN other uuid;\n`],
    ["an ACL change", `${sql}GRANT SELECT ON TABLE public.subscription_quote_previews TO authenticated;\n`],
    ["a trigger change", `${sql}ALTER TABLE public.subscription_quote_previews DISABLE TRIGGER USER;\n`],
    ["another constraint", `${sql}ALTER TABLE public.subscription_quote_previews ADD CONSTRAINT other_check CHECK (true);\n`],
    ["a changed receipt FK", sql.replace("subscription_command_receipts", "subscription_events")],
  ])("refuses %s", (_label, altered) => {
    expect(() => admit(altered)).toThrow(sqlError);
  });
  it("refuses a slot declaring another allowed table change", () => {
    const slot = entry();
    slot.existingTableStatements!.push("ALTER TABLE public.subscription_quote_previews ADD COLUMN other uuid;");
    expect(() => admit(sql, prefix(), [slot])).toThrow(slotError);
  });
  it("refuses a second slot for the same replacement", () => {
    const second = { ...entry(), row: "second-preview-acceptance", path: "db/platform/migrations/20990104000000_repeat.sql" };
    expect(() => admit(sql, prefix(), [entry(), second])).toThrow(slotError);
  });

  const ok = ["PASS"], refused = (message: string) => ["REFUSED", message];
  const unissued = refused("reviewed native store preview acceptance CHECK predecessor must already be issued");
  const coLocated = refused("reviewed replacement admission machinery must be approved separately before co-located SQL/pins");
  const unapproved = refused(`non-expand-only forward differs from reviewed replacement path or bytes: ${preimage}`);

  it.each([
    ["issued predecessor", 0, [ok, ok, ok, ok]],
    ["a co-located rule change", 1, [ok, ok, coLocated, coLocated]],
    ["a co-located installation matrix change", 1, [ok, ok, coLocated, coLocated]],
    ["a co-introduced predecessor", 1, [unapproved, unissued, unapproved, unissued, unissued]],
  ] as const)("checks %s for receipt-backed preview acceptance", (scenario, exit, verdicts) => {
    const f = fixture(), source = readFileSync(preimage);
    const rows = [{ file: preimage, sha256: sha256(source) }];
    f.put(preimage, source);
    if (scenario !== "a co-introduced predecessor") {
      f.put(triggerForward.path, triggerForward.bytes);
      rows.push({ file: triggerForward.path, sha256: sha256(triggerForward.bytes) });
    }
    f.put(PLATFORM_MIGRATION_MANIFEST, manifest(rows));
    const base = scenario === "a co-introduced predecessor" ? f.base : f.commit();
    stageNativeForward(f, sql, entry());
    f.put(PLATFORM_MIGRATION_MANIFEST, manifest([...rows, { file: path, sha256: sha256(sql) }]));
    if (scenario === "a co-located rule change") f.put("scripts/reviewed-platform-forward.ts", "// Changed admission rule.\n");
    if (scenario === "a co-located installation matrix change") f.put("tests/postgres/subscriptionExactInstallation.test.ts", "// Changed installation proof.\n");
    const head = f.commit();
    const result = cli(f.root, ["--base", base, "--head", head, STALE]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(exit);
    const reported = verdictLines(result.stdout);
    expect(reported).toEqual(directVerdicts(f, base, head).verdicts);
    expect(reported).toEqual(verdicts);
  }, 20_000);
});

describe("qualified SECURITY DEFINER replacement in sql:admit", () => {
  it.each([true, false])("matches PR and queue admission with the exact guard present = %s", withGuard => {
    const signature = "public.catalog_price_setup_region_code()", searchPath = "pg_catalog, pg_temp";
    const prior = `CREATE FUNCTION ${signature} RETURNS text LANGUAGE sql SECURITY INVOKER SET search_path = ${searchPath} AS $$ SELECT 'prior' $$;`;
    const replacement = prior.replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION").replace("'prior'", "'replacement'");
    const guard = renderQualifiedSecurityDefiner(signature);
    const f = fixture(`${baseline}\n${prior}\n`), entry = slot(nativePath);
    const beforeSha256 = sqlSha256(prior);
    entry.replacedFunctions = [{ signature, searchPath, beforeSha256, qualifiedSecurityDefiner: true }];
    stageNativeForward(f, withGuard ? `${replacement}\n${guard}` : replacement, entry, [
      { signature, beforeSha256, afterSha256: sqlSha256(replacement) },
    ]);
    const head = f.commit();
    const result = cli(f.root, ["--base", f.base, "--head", head, STALE]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(withGuard ? 0 : 1);
    const direct = directVerdicts(f, f.base, head).verdicts;
    expect(verdictLines(result.stdout)).toEqual(direct.map(([status, message]) =>
      message === undefined ? [status] : [status, message.split("\n", 1)[0]]));
    if (!withGuard) {
      const refusal = `${signature}: expected this exact statement immediately after its CREATE OR REPLACE FUNCTION:\n${guard}`;
      expect(direct).toEqual(Array.from({ length: 4 }, () => ["REFUSED", `reviewed native store ${refusal}`]));
      expect(result.stdout).toContain(refusal);
    }
  }, 20_000);
});

type Case = { name: string; exit: number; refusal?: string; hint?: string; queue?: "not run"; build: (f: Fixture) => { base: string; head: string }; also?: (f: Fixture, base: string, head: string, fork: string) => void };
const cases: Case[] = [
  { name: "an admitted native forward with its slot, pin and manifest row", exit: 0, build: (f) => { stageNativeForward(f); return { base: f.base, head: f.commit() }; } },
  ...["exact", "drift", "conflict"].map((scenario): Case => {
    const name = "fixture_deferred", relation = "public.fixture_row", signature = "public.fixture_deferred()";
    const canonical = `CREATE CONSTRAINT TRIGGER ${name} AFTER UPDATE OR DELETE ON ${relation} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${signature};`;
    const definition = `CREATE FUNCTION ${signature} RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END; $$;`;
    const refusal = scenario === "exact" ? undefined : `deferred trigger ${name} is pinned; only these statements may name ${name}: ${canonical} ${definition} REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC; remove it, or rewrite it to exactly one of these`;
    return { name: `a pinned deferred trigger with ${scenario} SQL`, exit: refusal ? 1 : 0, refusal, build: (f) => {
        const statement = scenario === "drift" ? canonical.replace("CREATE", "create") : canonical;
        const entry = slot(nativePath);
        entry.createdFunctions = [{ signature, searchPath: null }];
        entry.createdTriggers = [{ name, relation, events: ["UPDATE", "DELETE"], function: signature, deferred: true, sha256: sqlSha256(statement) }];
        const companion = scenario === "conflict" ? `CREATE OR REPLACE TRIGGER other BEFORE INSERT ON ${relation} FOR EACH ROW EXECUTE FUNCTION ${signature};` : "";
        stageNativeForward(f, `${definition}\nREVOKE ALL ON FUNCTION ${signature} FROM PUBLIC;\n${statement}\n${companion}`, entry,
          [{ signature, beforeSha256: null, afterSha256: sqlSha256(definition) }]);
        return { base: f.base, head: f.commit() };
      } };
  }),
  { name: "a replacement pin whose SQL this change does not introduce", exit: 1, refusal: "reviewed replacement pin must be approved separately unless its SQL is introduced in this PR",
    hint: "a separate approval PR", build: (f) => {
      const value = registry(); value.qualifiedInstallations = production.qualifiedInstallations!.slice(0, 4);
      f.put(REVIEWED_FORWARD_PATH, encode(value)); f.put("supabase/migrations/20271106100000_fixture.sql", "CREATE TABLE public.fixture (id uuid);\n");
      return { base: f.base, head: f.commit() };
    } },
  { name: "a new slot that is not later than every base migration", exit: 1, refusal: "reviewed native store new slot time must be later than every base migration",
    hint: "slot order", build: (f) => {
      const landed = "db/platform/migrations/20271106100000_landed.sql", text = "CREATE TABLE public.landed (id uuid);\n";
      f.put(landed, text); f.put(PLATFORM_MIGRATION_MANIFEST, manifest([{ file: landed, sha256: sha256(text) }])); const base = f.commit();
      const value = registry(); value.nativeStoreForwardClass!.slots.push(slot("db/platform/migrations/20271105100000_earlier.sql"));
      f.put(REVIEWED_FORWARD_PATH, encode(value)); return { base, head: f.commit() };
    } },
  { name: "a malformed registry slot", exit: 1, refusal: "reviewed native store slot path, row or order drifted", hint: "strict reader", build: (f) => {
    const value = registry(); value.nativeStoreForwardClass!.slots.push(slot(nativePath, "malformed row"));
    f.put(REVIEWED_FORWARD_PATH, encode(value)); return { base: f.base, head: f.commit() };
  } },
  { name: "an expand-only managed forward without a registry or reviewed-class change", exit: 0, queue: "not run", build: (f) => {
    f.put("supabase/migrations/20271106100000_fixture.sql", "CREATE TABLE public.fixture (id uuid);\n"); return { base: f.base, head: f.commit() };
  } },
  // Main changed a workflow after the fork. The queue reads the PR on its fork point; reading it on main would refuse it as machinery.
  { name: "a native forward on a branch behind a main that changed admission machinery", exit: 0, build: (f) => {
    f.git("switch", "-q", "-c", "feature"); stageNativeForward(f); const head = f.commit();
    f.git("switch", "-q", "main"); f.put(".github/workflows/fixture.yml", "name: fixture\n"); return { base: f.commit(), head };
  }, also: (f, base, head, fork) => {
    expect(fork).not.toBe(base);
    expect(() => assertCoLocatedForwardApproval(f.root, base, head)).toThrow("reviewed replacement admission machinery must be approved separately");
  } },
];

describe("sql:admit", () => {
  // The slowest case measured 4.8 s on a laptop at load average 5; the bound is four times that.
  it.each(cases)("reports the hosted verdict for $name", ({ exit, refusal, hint, queue, build, also }) => {
    const f = fixture(), { base, head } = build(f);
    const result = cli(f.root, ["--base", base, "--head", head, STALE]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(exit);
    expect(result.stdout).toContain("WARNING  admission code differs from");
    const reported = verdictLines(result.stdout), direct = directVerdicts(f, base, head);
    expect(reported).toEqual(direct.verdicts);
    also?.(f, base, head, direct.fork);
    if (queue) expect(result.stdout).toContain("PASS     co-located approval [queue: not run");
    if (refusal === undefined) expect(reported.every(([status]) => status === "PASS")).toBe(true);
    else {
      expect(reported.filter(([status]) => status === "REFUSED").map(([, message]) => message)).toEqual(expect.arrayContaining([expect.stringContaining(refusal)]));
      if (hint) expect(result.stdout).toMatch(new RegExp(`capability needed:[^\\n]+${hint}`, "u"));
      else expect(result.stdout).not.toContain("capability needed:");
    }
  }, 20_000);

  // Measured 5.2 s on a laptop at load average 5; the bound is four times that.
  it("refuses admission code that differs from the base unless --allow-stale-rules is given", () => {
    const f = fixture();
    const linear = cli(f.root, ["--base", f.base, "--head", f.base]);
    expect(linear.status).toBe(2);
    expect(linear.stdout).toBe("");
    expect(linear.stderr).toContain("--allow-stale-rules");
    // A base that carries this checkout's exact admission code runs without a warning.
    const rules = admissionRuleFiles();
    expect(rules).toEqual(expect.arrayContaining(["scripts/agent-review-queue.mjs", "scripts/oss-published-tree-check.ts", "scripts/oss-source-release-contract.ts",
      "scripts/platform-migration-manifest.ts", "scripts/reviewed-platform-forward.ts", "scripts/sql-admit.ts"]));
    for (const path of rules) f.put(path, readFileSync(path));
    const current = f.commit();
    f.git("switch", "-q", "-c", "feature"); stageNativeForward(f); const head = f.commit();
    const fresh = cli(f.root, ["--base", current, "--head", head]);
    expect(fresh.stderr).toBe(""); expect(fresh.status).toBe(0); expect(fresh.stdout).not.toContain("WARNING");
    // Main then changes one admission file: the checkout is behind, so its verdict may differ from the hosted one.
    f.git("switch", "-q", "main"); f.put("scripts/platform-migration-manifest.ts", `${readFileSync("scripts/platform-migration-manifest.ts", "utf8")}// Main moved.\n`);
    const moved = f.commit();
    const refused = cli(f.root, ["--base", moved, "--head", head]);
    expect(refused.status).toBe(2); expect(refused.stdout).toBe("");
    expect(refused.stderr).toContain("differs from");
    expect(refused.stderr).toContain("in scripts/platform-migration-manifest.ts; hosted CI and the queue would judge with the base's code");
    const allowed = cli(f.root, ["--base", moved, "--head", head, STALE]);
    expect(allowed.stderr).toBe(""); expect(allowed.status).toBe(0);
    expect(allowed.stdout).toContain(`WARNING  admission code differs from ${moved} in scripts/platform-migration-manifest.ts;`);
  }, 21_000);

  it("refuses uncommitted new forwards until committed, unless --head is explicit", () => {
    const f = fixture(), path = "supabase/migrations/20271106100000_drop.sql";
    const scratch = mkdtempSync(join(tmpdir(), "openlup-sql-admit-tmp-")); roots.push(scratch);
    f.put(path, "DROP TABLE public.fixture;\n");
    for (const state of ["untracked", "staged"]) {
      if (state === "staged") f.git("add", path);
      const before = repositorySnapshot(f, [path]);
      const result = cli(f.root, ["--base", f.base], { TMPDIR: scratch });
      expect(result.status, state).toBe(2);
      expect(result.stderr).toBe("not checked: uncommitted changes; commit first (a local commit can be amended), or pass --head <rev>\n");
      expect(result.stdout).toBe("");
      expect(repositorySnapshot(f, [path])).toEqual(before);
      expect(readdirSync(scratch)).toEqual([]);
    }
    // An explicit revision also works from the Git directory, where status would fail.
    const beforeExplicit = repositorySnapshot(f, [path]);
    const explicit = cli(join(f.root, ".git"), ["--base", f.base, "--head", f.base, STALE], { TMPDIR: scratch });
    expect(explicit.stderr).toBe(""); expect(explicit.status).toBe(0);
    expect(explicit.stdout).toContain("PASS");
    expect(repositorySnapshot(f, [path])).toEqual(beforeExplicit);
    expect(readdirSync(scratch)).toEqual([]);
    const head = f.commit(), beforeCommitted = repositorySnapshot(f, [path]);
    const committed = cli(f.root, ["--base", f.base, STALE], { TMPDIR: scratch });
    expect(committed.stderr).toBe(""); expect(committed.status).toBe(1);
    expect(committed.stdout).toContain(`head ${head} (HEAD)`);
    expect(committed.stdout).toContain(`REFUSED  ${path} [self-check forward admission]`);
    expect(repositorySnapshot(f, [path])).toEqual(beforeCommitted);
    expect(readdirSync(scratch)).toEqual([]);
    expect(verdictLines(committed.stdout)).toEqual(directVerdicts(f, f.base, head).verdicts);
  }, 20_000);

  it("refuses usage errors, Git errors and a head that does not merge into the base with exit code 2", () => {
    const f = fixture();
    for (const args of [["--unknown"], ["--base"], ["--base", "missing-revision", STALE], ["--allow-stale-rules", "--allow-stale-rules"]]) {
      const result = cli(f.root, args);
      expect(result.status, args.join(" ")).toBe(2);
      expect(result.stdout).toBe("");
    }
    f.git("switch", "-q", "-c", "feature"); stageNativeForward(f); const head = f.commit();
    f.git("switch", "-q", "main");
    const other = registry(); other.nativeStoreForwardClass!.slots.push(slot("db/platform/migrations/20271107100000_other.sql", "Other"));
    f.put(REVIEWED_FORWARD_PATH, encode(other)); const base = f.commit();
    const conflict = cli(f.root, ["--base", base, "--head", head, STALE]);
    expect(conflict.status).toBe(2); expect(conflict.stdout).toBe("");
    expect(conflict.stderr).toContain("head does not merge cleanly into base");
  });
});

describe("upstream exact managed migration approval", () => {
  const path = "supabase/migrations/20271106100000_reviewed.sql";
  const sql = "REVOKE SELECT ON public.example FROM authenticated;\n";
  const approve = (f: Fixture) => {
    const value = registry();
    value.managedExactForwards = [{ path, sha256: sqlSha256(sql),
      prefixSha256: managedForwardPrefixSha256(f.root, f.base, path) }];
    f.put(REVIEWED_FORWARD_PATH, encode(value));
  };

  it("admits the exact bytes from an upstream pin, including in release history", () => {
    const f = fixture();
    approve(f);
    const approval = f.commit();
    f.put(path, sql);
    const head = f.commit();
    expect(() => assertAdmittedPlatformForward(f.root, approval, head, path, Buffer.from(sql))).not.toThrow();
    expect(() => assertAdmittedPlatformForward(f.root, f.base, head, path, Buffer.from(sql), true)).not.toThrow();
  });

  it("refuses exact approval retroactively for an already committed managed migration", () => {
    const f = fixture();
    f.put(path, "CREATE TABLE public.example (id uuid);\n");
    const issued = f.commit();
    approve(f);
    const latePin = f.commit();
    expect(() => assertCoLocatedForwardApproval(f.root, issued, latePin))
      .toThrow("exact managed forward approval must precede its SQL");
  });

  it("refuses repairing an unapproved introduction before the first release", () => {
    const f = fixture();
    approve(f);
    f.commit();
    f.put(path, sql + "-- changed at introduction\n");
    f.commit();
    f.put(path, sql);
    const repaired = f.commit();
    expect(() => assertAdmittedPlatformForward(f.root, f.base, repaired, path, Buffer.from(sql), true))
      .toThrow("exact managed forward introduction differs from upstream approval");
  });

  it("selects exact-only changes in the trusted queue and refuses a simultaneous machinery edit", () => {
    const f = fixture();
    approve(f);
    const approval = f.commit();
    expect(needsForwardApproval([path], candidate => hasExactManagedForward(f.root, approval, candidate))).toBe(true);
    f.put(path, sql);
    const head = f.commit();
    expect(() => assertCoLocatedForwardApproval(f.root, approval, head)).not.toThrow();
    f.put("scripts/oss-source-release-contract.ts", "");
    const cochanged = f.commit();
    expect(() => assertCoLocatedForwardApproval(f.root, approval, cochanged)).toThrow(/machinery must be approved separately/);
  });

  it.each(["edit", "delete", "executable", "registry removal"] as const)("refuses an issued migration %s in the trusted queue", tamper => {
    const f = fixture();
    approve(f);
    f.commit();
    f.put(path, sql);
    const issued = f.commit();
    if (tamper === "edit") f.put(path, sql + "-- changed\n");
    else if (tamper === "delete") f.git("rm", path);
    else if (tamper === "registry removal") f.git("rm", REVIEWED_FORWARD_PATH);
    else f.git("update-index", "--chmod=+x", path);
    const drift = tamper === "executable"
      ? (f.git("commit", "-qm", "Change migration file mode"), f.git("rev-parse", "HEAD"))
      : f.commit();
    expect(() => assertCoLocatedForwardApproval(f.root, issued, drift)).toThrow(/issued exact managed forward|requires a regular file/);
  });

  it("refuses a pin introduced with its migration", () => {
    const f = fixture();
    approve(f);
    f.put(path, sql);
    const head = f.commit();
    expect(() => assertCoLocatedForwardApproval(f.root, f.base, head)).toThrow(/must be approved separately/);
  });

  it("refuses a different prefix or bytes, including an expand-only substitution", () => {
    const f = fixture();
    approve(f);
    const approval = f.commit();
    f.put(path, "CREATE TABLE public.substitute (id uuid);\n");
    const substitute = f.commit();
    expect(() => assertAdmittedPlatformForward(f.root, approval, substitute, path,
      readFileSync(join(f.root, path)))).toThrow("exact managed forward bytes differ");
    f.put("supabase/migrations/20271105100000_other.sql", "CREATE TABLE public.other (id uuid);\n");
    f.put(path, sql);
    const drift = f.commit();
    expect(() => assertAdmittedPlatformForward(f.root, approval, drift, path, Buffer.from(sql)))
      .toThrow("exact managed forward managed prefix differs");
  });
});

describe("SECURITY DEFINER trailing pg_temp rule in sql:admit and hosted checks", () => {
  const signature = "public.fixture_sec_definer(uuid)";
  const nativeFnSql = (security: "DEFINER" | "INVOKER", searchPathSql: string | null) => {
    const clause = searchPathSql === null ? "" : ` SET search_path = ${searchPathSql}`;
    const def = `CREATE FUNCTION public.fixture_sec_definer(p_id uuid) RETURNS text LANGUAGE sql SECURITY ${security}${clause} AS $$ SELECT 'ok'; $$;`;
    return { def, text: `${def}\nREVOKE ALL ON FUNCTION ${signature} FROM PUBLIC;\n` };
  };

  it.each([
    ["omitted SET search_path", null, null],
    ["public, pg_catalog (missing pg_temp)", "public, pg_catalog", "public, pg_catalog"],
    ["pg_temp, pg_catalog (pg_temp not last)", "pg_temp, pg_catalog", "pg_temp, pg_catalog"],
    ["pg_temp, public, pg_temp (duplicate pg_temp)", "pg_temp, public, pg_temp", "pg_temp, public, pg_temp"],
  ])("refuses a new native-store SECURITY DEFINER forward with %s in sql:admit and direct checks", (_label, searchPathSql, slotSearchPath) => {
    const f = fixture();
    const { def, text } = nativeFnSql("DEFINER", searchPathSql);
    const entry = slot(nativePath);
    entry.createdFunctions = [{ signature, searchPath: slotSearchPath }];
    stageNativeForward(f, text, entry, [{ signature, beforeSha256: null, afterSha256: sqlSha256(def) }]);
    const head = f.commit();
    const result = cli(f.root, ["--base", f.base, "--head", head, STALE]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(1);
    const expected = `SECURITY DEFINER function ${signature} must place pg_temp last in SET search_path (for example: SET search_path = pg_catalog, pg_temp)`;
    expect(result.stdout).toContain(expected);
    expect(verdictLines(result.stdout)).toEqual(directVerdicts(f, f.base, head).verdicts);
  }, 20_000);

  it.each([
    ["DEFINER with pg_catalog, pg_temp", "DEFINER", "pg_catalog, pg_temp", "pg_catalog, pg_temp"],
    ["DEFINER with public, pg_catalog, pg_temp", "DEFINER", "public, pg_catalog, pg_temp", "public, pg_catalog, pg_temp"],
    ["INVOKER with public, pg_catalog", "INVOKER", "public, pg_catalog", "public, pg_catalog"],
  ] as const)("admits a new native-store forward with %s in sql:admit and direct checks", (_label, security, searchPathSql, slotSearchPath) => {
    const f = fixture();
    const { def, text } = nativeFnSql(security, searchPathSql);
    const entry = slot(nativePath);
    entry.createdFunctions = [{ signature, searchPath: slotSearchPath }];
    stageNativeForward(f, text, entry, [{ signature, beforeSha256: null, afterSha256: sqlSha256(def) }]);
    const head = f.commit();
    const result = cli(f.root, ["--base", f.base, "--head", head, STALE]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(verdictLines(result.stdout)).toEqual(directVerdicts(f, f.base, head).verdicts);
  }, 20_000);

  const managedPath = "supabase/migrations/20271106100000_definer_check.sql";
  const stageManaged = (f: Fixture, sqlText: string) => {
    const value = registry();
    value.managedExactForwards = [{ path: managedPath, sha256: sqlSha256(sqlText), prefixSha256: managedForwardPrefixSha256(f.root, f.base, managedPath) }];
    f.put(REVIEWED_FORWARD_PATH, encode(value));
    const approval = f.commit();
    f.put(managedPath, sqlText);
    return { approval, head: f.commit() };
  };

  it.each([
    ["omitted SET search_path", "CREATE FUNCTION public.fixture_managed(p_id uuid) RETURNS void LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1; $$;\n"],
    ["public, pg_catalog", "CREATE OR REPLACE FUNCTION public.fixture_managed(p_id uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_catalog AS $$ SELECT 1; $$;\n"],
    ["pg_temp, pg_catalog", "CREATE FUNCTION public.fixture_managed(p_id uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_temp, pg_catalog AS $$ SELECT 1; $$;\n"],
    ["pg_temp, public, pg_temp", "CREATE FUNCTION public.fixture_managed(p_id uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_temp, public, pg_temp AS $$ SELECT 1; $$;\n"],
    ["duplicate quoted SEARCH_PATH", 'CREATE FUNCTION public.fixture_managed(p_id uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET "SEARCH_PATH" = public AS $$ SELECT 1; $$;\n'],
  ])("refuses a newly added managed exact forward with %s across sql:admit, self-check and queue", (_label, sqlText) => {
    const f = fixture();
    const { approval, head } = stageManaged(f, sqlText);
    const expected = "SECURITY DEFINER function public.fixture_managed(uuid) must place pg_temp last in SET search_path (for example: SET search_path = pg_catalog, pg_temp)";
    expect(() => assertAdmittedPlatformForward(f.root, approval, head, managedPath, Buffer.from(sqlText))).toThrow(expected);
    expect(() => assertCoLocatedForwardApproval(f.root, approval, head)).toThrow(expected);
    const result = cli(f.root, ["--base", approval, "--head", head, STALE]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(expected);
    expect(verdictLines(result.stdout)).toEqual(directVerdicts(f, approval, head).verdicts);
  }, 20_000);

  it.each([
    ["CREATE PROCEDURE SECURITY DEFINER without pg_temp", "CREATE PROCEDURE public.fixture_proc(p_id uuid) LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN NULL; END; $$;\n", "SECURITY DEFINER procedure public.fixture_proc(uuid) must place pg_temp last in SET search_path"],
    ["ALTER FUNCTION SECURITY DEFINER without search_path", "ALTER FUNCTION public.fixture_managed(uuid) SECURITY DEFINER;\n", "SECURITY DEFINER function public.fixture_managed(uuid) must place pg_temp last in SET search_path"],
    ["ALTER FUNCTION RESET search_path", "ALTER FUNCTION public.fixture_managed(uuid) RESET search_path;\n", "ALTER FUNCTION public.fixture_managed(uuid) must not reset search_path"],
    ["ALTER ROUTINE RESET ALL", "ALTER ROUTINE public.fixture_managed RESET ALL;\n", "ALTER ROUTINE public.fixture_managed must not reset search_path"],
    ["ALTER FUNCTION SET search_path = public", "ALTER FUNCTION public.fixture_managed(uuid) SET search_path = public;\n", "ALTER FUNCTION public.fixture_managed(uuid) must place pg_temp last in SET search_path"],
    ["CREATE FUNCTION SECURITY DEFINER RESET search_path", "CREATE FUNCTION public.fixture_managed(p_id uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp RESET search_path AS $$ SELECT 1; $$;\n", "SECURITY DEFINER function public.fixture_managed(uuid) must not reset search_path"],
    ["CREATE FUNCTION SECURITY DEFINER SET SCHEMA literal", "CREATE FUNCTION public.fixture_managed(p_id uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET SCHEMA 'public' AS $$ SELECT 1; $$;\n", "must use explicit SET search_path = ..., pg_temp instead of SET SCHEMA literal"],
    ["ALTER FUNCTION SET SCHEMA literal", "ALTER FUNCTION public.fixture_managed(uuid) SET SCHEMA 'public';\n", "ALTER FUNCTION public.fixture_managed(uuid) must use explicit SET search_path = ..., pg_temp instead of SET SCHEMA literal"],
    ["astral Unicode dollar-tag body hiding search_path", "CREATE FUNCTION public.fixture_managed(p_id uuid) RETURNS void LANGUAGE sql SECURITY DEFINER AS $😀$ SET search_path = pg_catalog, pg_temp; SELECT 1; $😀$;\n", "SECURITY DEFINER function public.fixture_managed(uuid) must place pg_temp last in SET search_path"],
  ])("refuses a newly added managed exact forward with %s across self-check and queue", (_label, sqlText, expected) => {
    const f = fixture();
    const { approval, head } = stageManaged(f, sqlText);
    expect(() => assertAdmittedPlatformForward(f.root, approval, head, managedPath, Buffer.from(sqlText))).toThrow(expected);
    expect(() => assertCoLocatedForwardApproval(f.root, approval, head)).toThrow(expected);
  });

  it("grandfathers only the exact frozen historical managed exact forward bytes and refuses any 1-byte modification", () => {
    const historicalPath = "supabase/migrations/20261123144000_checkout_account_ownership.sql";
    const exactBytes = readFileSync(historicalPath);
    const f = fixture();
    const value = registry();
    value.managedExactForwards = [{ path: historicalPath, sha256: sqlSha256(exactBytes), prefixSha256: managedForwardPrefixSha256(f.root, f.base, historicalPath) }];
    f.put(REVIEWED_FORWARD_PATH, encode(value));
    const approval = f.commit();
    f.put(historicalPath, exactBytes);
    const exactHead = f.commit();
    expect(() => assertAdmittedPlatformForward(f.root, approval, exactHead, historicalPath, exactBytes)).not.toThrow();
    expect(() => assertCoLocatedForwardApproval(f.root, approval, exactHead)).not.toThrow();

    const modifiedBytes = Buffer.concat([exactBytes, Buffer.from("\n")]);
    const f2 = fixture();
    const value2 = registry();
    value2.managedExactForwards = [{ path: historicalPath, sha256: sqlSha256(modifiedBytes), prefixSha256: managedForwardPrefixSha256(f2.root, f2.base, historicalPath) }];
    f2.put(REVIEWED_FORWARD_PATH, encode(value2));
    const approval2 = f2.commit();
    f2.put(historicalPath, modifiedBytes);
    const modifiedHead = f2.commit();
    expect(() => assertAdmittedPlatformForward(f2.root, approval2, modifiedHead, historicalPath, modifiedBytes)).toThrow(/must place pg_temp last in SET search_path/u);
    expect(() => assertCoLocatedForwardApproval(f2.root, approval2, modifiedHead)).toThrow(/must place pg_temp last in SET search_path/u);
  });

  it.each([
    ["quoted public, pg_catalog, pg_temp", 'CREATE FUNCTION public.fixture_managed(p_id uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = "public", "pg_catalog", "pg_temp" AS $$ SELECT 1; $$;\n'],
    ["uppercase PG_CATALOG, PG_TEMP", "CREATE FUNCTION public.fixture_managed(p_id uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = PG_CATALOG, PG_TEMP AS $$ SELECT 1; $$;\n"],
    ["SECURITY INVOKER without pg_temp", "CREATE FUNCTION public.fixture_managed(p_id uuid) RETURNS void LANGUAGE sql SECURITY INVOKER SET search_path = public, pg_catalog AS $$ SELECT 1; $$;\n"],
  ])("admits a newly added managed exact forward with %s", (_label, sqlText) => {
    const f = fixture();
    const { approval, head } = stageManaged(f, sqlText);
    expect(() => assertAdmittedPlatformForward(f.root, approval, head, managedPath, Buffer.from(sqlText))).not.toThrow();
    expect(() => assertCoLocatedForwardApproval(f.root, approval, head)).not.toThrow();
    const result = cli(f.root, ["--base", approval, "--head", head, STALE]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(verdictLines(result.stdout)).toEqual(directVerdicts(f, approval, head).verdicts);
  }, 20_000);
});
