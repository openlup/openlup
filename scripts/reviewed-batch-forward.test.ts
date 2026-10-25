import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { reviewedBatchBytes, reviewedBatchPaths } from "./reviewed-batch-rail.ts";
import { describe, expect, it } from "vitest";
import { assertBatchedForward, assertManagedCommerceForward, assertCoLocatedForwardApproval, assertForwardApproval, assertReviewedPlatformForward, assertUnchangedForwardApproval, batchedFunctionDefinitions, changedForwardApprovals, readReviewedForwardRegistry, reviewedFunctionDefinitions, sqlSha256, sqlStatements, type BatchedForwardBinding, type ManagedCommerceForwardBinding } from "./reviewed-platform-forward.ts";
import { assertAppendOnlyMigrationHistory } from "./oss-published-tree-check.ts";
import { resolveDocumentationBase } from "./documentation-git.ts";
import { waitNativeAdmission } from "./agent-review-queue.mjs";
import { captureCommittedReviewCandidate, git as reviewGit } from "./agent-review-session.mjs";
import { prepareCandidate, receiptSummary, recordReport, RECEIPT_MARKER } from "./agent-review-decide.mjs";

const registryBytes = readFileSync("config/reviewed-platform-forwards.json");
const registry = readReviewedForwardRegistry(registryBytes);
const pins = registry.batchedForwards!;
const bytes = (pin: BatchedForwardBinding) => readFileSync(`scripts/fixtures/reviewed-m10/${pin.path}`);
const rail = (pin: BatchedForwardBinding) => pin.path.startsWith("db/") ? "db/platform/migrations" : "supabase/migrations";
function prefix(pin: BatchedForwardBinding): Buffer[] {
  const folder = rail(pin);
  const railPins = pins.filter(prior => rail(prior) === folder);
  return reviewedBatchPaths(process.cwd(), folder, railPins).filter(path => path < pin.path)
    .map(path => { const prior = railPins.find(pin => pin.path === path); return prior ? bytes(prior) : readFileSync(path); });
}
const repin = (pin: BatchedForwardBinding, sql: string): BatchedForwardBinding => ({ ...structuredClone(pin), sha256: sqlSha256(sql), statements: sqlStatements(sql).map(statement => ({ sha256: sqlSha256(statement), ...(!/^CREATE(?: OR REPLACE)? FUNCTION /u.test(statement) ? { sql: statement } : {}) })) });

it.each(pins)("accepts the exact packet after its current prefix: $path", pin => {
  expect(() => assertBatchedForward(pin, bytes(pin), prefix(pin))).not.toThrow();
});

describe.each([
  "db/platform/migrations/20261022160000_subscription_retry_lifecycle.sql",
  "db/platform/migrations/20261024170000_subscription_command_lifecycle.sql",
  "db/platform/migrations/20261024180000_subscription_stock_wait.sql",
  "db/platform/migrations/20261024183000_inventory_available_to_promise.sql",
])("native creation classifier: %s", path => {
  it.each(["SECURITY DEFINER", "non-pg_catalog search_path"])("refuses fully repinned %s", attack => {
    const pin = pins.find(pin => pin.path === path)!;
    const sql = bytes(pin).toString().replace("SET search_path = pg_catalog", attack === "SECURITY DEFINER"
      ? "SECURITY DEFINER SET search_path = pg_catalog" : "SET search_path = public");
    expect(sql).not.toBe(bytes(pin).toString());
    const changed = repin(pin, sql);
    const definitions = batchedFunctionDefinitions(Buffer.from(sql));
    for (const fn of changed.functions) fn.afterSha256 = definitions.get(fn.signature)!;
    expect(() => assertBatchedForward(changed, Buffer.from(sql), prefix(pin))).toThrow(/reviewed portable creation/u);
  });
});

describe.each([
  "db/platform/migrations/20261024184500_subscription_retry_late_positive_stock.sql",
  "db/platform/migrations/20261024184600_subscription_retry_candidate_payment_filter.sql",
])("native replacement header: %s", path => {
  it.each(["SECURITY DEFINER", "non-pg_catalog search_path"])("refuses fully repinned %s", attack => {
    const pin = pins.find(pin => pin.path === path)!;
    const sql = bytes(pin).toString().replace("SET search_path = pg_catalog", attack === "SECURITY DEFINER"
      ? "SECURITY DEFINER SET search_path = pg_catalog" : "SET search_path = public");
    expect(sql).not.toBe(bytes(pin).toString());
    const changed = repin(pin, sql);
    const definitions = batchedFunctionDefinitions(Buffer.from(sql));
    for (const fn of changed.functions) fn.afterSha256 = definitions.get(fn.signature)!;
    expect(() => assertBatchedForward(changed, Buffer.from(sql), prefix(pin)))
      .toThrow(/^reviewed batch portable replacement attributes drifted$/u);
  });
});

it("refuses a fully repinned X SECURITY DEFINER replacement at the shared header check", () => {
  const pin = pins.find(pin => pin.path.includes("20261024184500"))!;
  expect(() => assertBatchedForward(pin, bytes(pin), prefix(pin))).not.toThrow();
  const sql = bytes(pin).toString().replace("SET search_path = pg_catalog", "SECURITY DEFINER SET search_path = pg_catalog");
  expect(sql).not.toBe(bytes(pin).toString());
  const changed = repin(pin, sql);
  const definitions = batchedFunctionDefinitions(Buffer.from(sql));
  for (const fn of changed.functions) fn.afterSha256 = definitions.get(fn.signature)!;
  expect(() => assertBatchedForward(changed, Buffer.from(sql), prefix(pin)))
    .toThrow(/^reviewed batch portable replacement attributes drifted$/u);
});

describe.each(pins)("refusal plants: $path", pin => {
  it.each(["missing definition", "duplicate definition", "extra definition"])("refuses actual SQL %s after file/statement repinning", attack => {
    const statements = sqlStatements(bytes(pin).toString());
    const index = statements.findIndex(sql => /^CREATE(?: OR REPLACE)? FUNCTION /u.test(sql));
    if (attack === "missing definition") statements.splice(index,1);
    if (attack === "duplicate definition") statements.push(statements[index]!);
    if (attack === "extra definition") statements.push("CREATE FUNCTION public.unpinned_signature() RETURNS text LANGUAGE sql AS $$ SELECT ''; $$;");
    const sql = statements.join("\n");
    expect(() => assertBatchedForward(repin(pin,sql),Buffer.from(sql),prefix(pin))).toThrow(/reviewed batch/u);
  });
  it.each(["changed byte", "another path", "missing signature", "duplicate signature", "extra signature", "before drift", "extra grant (count/classifier)", "wider grantee (count/classifier)", "private function (signature count)", "unexpected statement (count/classifier)"])("refuses %s", attack => {
    const changed = structuredClone(pin);
    let sql = bytes(pin).toString("utf8");
    if (attack === "changed byte") sql += " ";
    if (attack === "another path") changed.path = changed.path.replace(/202610(?:22|24|25)/u, "20261023");
    if (attack === "missing signature") changed.functions.pop();
    if (attack === "duplicate signature") changed.functions.push(changed.functions[0]!);
    if (attack === "extra signature") changed.functions.push({ ...changed.functions[0]!, signature: "public.unpinned()" });
    if (attack === "before drift") changed.functions[0]!.beforeSha256 = "0".repeat(64);
    if (attack === "extra grant (count/classifier)") sql += "\nGRANT SELECT ON public.subscriptions TO service_role;";
    if (attack === "wider grantee (count/classifier)") sql += "\nGRANT EXECUTE ON FUNCTION public.unpinned() TO PUBLIC;";
    // The unpinned private-object plant is refused structurally by statement/signature counts.
    if (attack === "private function (signature count)") sql += "\nCREATE FUNCTION private.unpinned() RETURNS text LANGUAGE sql AS $$ SELECT 'attack'; $$;";
    if (attack === "unexpected statement (count/classifier)") sql += "\nCREATE SCHEMA unpinned;";
    // Statement plants repin the file, but leave the independent ordered pins.
    if (["extra grant (count/classifier)", "wider grantee (count/classifier)", "private function (signature count)", "unexpected statement (count/classifier)"].includes(attack)) changed.sha256 = sqlSha256(sql);
    expect(() => assertBatchedForward(changed, Buffer.from(sql), prefix(pin))).toThrow(/reviewed batch|reviewed portable creation/u);
  });
});

it.each(["order", "chain", "path", "private signature", "portable replacement collision", "missing", "duplicate", "extra"])("refuses malformed registry %s", attack => {
  const changed = structuredClone(registry);
  const batch = changed.batchedForwards!;
  if (attack === "order") {
    const m2 = batch.findIndex(pin => pin.path === "supabase/migrations/20261024160000_subscription_dunning_continuity.sql");
    const m4 = batch.findIndex(pin => pin.path === "supabase/migrations/20261024181000_subscription_stock_wait_due.sql");
    [batch[m2], batch[m4]] = [batch[m4]!, batch[m2]!];
  }
  if (attack === "chain") batch.find(pin => pin.path === "supabase/migrations/20261024181000_subscription_stock_wait_due.sql")!.functions[0]!.beforeSha256 = "0".repeat(64);
  if (attack === "path") batch[0]!.path += ".sql";
  if (attack === "private signature") batch.find(pin => pin.path === "supabase/migrations/20261024182000_subscription_lifecycle_message_scan.sql")!.functions[0]!.signature = "private.unpinned()";
  if (attack === "portable replacement collision") changed.portableReplacementForwards![0]!.path = batch[0]!.path;
  if (attack === "missing") batch[0]!.functions.pop();
  if (attack === "duplicate") batch[0]!.functions.push(batch[0]!.functions[0]!);
  if (attack === "extra") batch.push(batch[0]!);
  expect(() => readReviewedForwardRegistry(Buffer.from(JSON.stringify(changed)))).toThrow(/reviewed batch|reviewed portable creation/u);
});

it("normalizes both timestamp identity spellings while hashing the raw CREATE statement", () => {
  const short = "CREATE FUNCTION public.batch_time(p_when timestamptz DEFAULT now()) RETURNS text LANGUAGE sql AS $$ SELECT ''; $$;";
  const long = short.replace("timestamptz", "timestamp with time zone");
  expect([...batchedFunctionDefinitions(Buffer.from(short)).keys()]).toEqual([...batchedFunctionDefinitions(Buffer.from(long)).keys()]);
  expect([...batchedFunctionDefinitions(Buffer.from(short)).values()]).not.toEqual([...batchedFunctionDefinitions(Buffer.from(long)).values()]);
});

it.each([
  "GRANT SELECT (id, retry_attempt, status) ON public.subscription_cycles TO service_role;",
  "GRANT SELECT (id, retry_attempt) ON public.subscription_cycles TO authenticated;",
  "GRANT EXECUTE ON FUNCTION public.subscription_list_due_for_renewal(integer,timestamptz) TO service_role;",
  "INSERT INTO public.comms_notification_controls(slug,enabled) VALUES ('unpinned',true) ON CONFLICT(slug) DO NOTHING;",
  "ALTER TABLE public.subscriptions DISABLE ROW LEVEL SECURITY;",
  "CREATE FUNCTION private.unpinned() RETURNS text LANGUAGE sql AS $$ SELECT 'attack'; $$;",
])("refuses an independently repinned statement-kind/target attack: %s", statement => {
  const pin = pins.find(pin => pin.path === "supabase/migrations/20261024160000_subscription_dunning_continuity.sql")!;
  const sql = bytes(pin).toString() + "\n" + statement;
  expect(() => assertBatchedForward(repin(pin, sql), Buffer.from(sql), prefix(pin))).toThrow(/reviewed batch|reviewed portable creation/u);
});

it("preserves N1 historical 14-pin approval through the re-pin and separately approves X", () => {
  const folder = mkdtempSync(join(tmpdir(), "openlup-batch-history-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", folder, ...args], { encoding: "utf8" }).trim();
  const put = (path: string, value: Buffer | string) => { mkdirSync(dirname(join(folder, path)), { recursive: true }); writeFileSync(join(folder, path), value); };
  const commit = (message: string) => { git("add", "."); git("-c", "user.name=Control Test", "-c", "user.email=control@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", message); return git("rev-parse", "HEAD"); };
  const historical = structuredClone(registry);
  historical.batchedForwards = pins.slice(0, 16).filter(pin => !/20261024184[56]00/u.test(pin.path))
    .map(pin => ({ ...structuredClone(pin), path: pin.path.replace("20261024", "20261022") }));
  const historicalN2 = historical.batchedForwards[1]!;
  const oldN2 = bytes(pins[1]!).toString().replace("(r.command->'payload')-'acceptedQuoteHash'", "r.command->'payload'-'acceptedQuoteHash'")
    .replace('-- Raw preview replay extracts the stored payload before subtracting acceptedQuoteHash.\n', '');
  historicalN2.sha256 = sqlSha256(oldN2);
  historicalN2.statements = repin(historicalN2, oldN2).statements;
  historicalN2.functions[0]!.afterSha256 = batchedFunctionDefinitions(Buffer.from(oldN2)).get(historicalN2.functions[0]!.signature)!;
  const n1 = pins[0]!;
  const x = pins.find(pin => pin.path.includes("20261024184500"))!;
  const registryPath = "config/reviewed-platform-forwards.json";
  try {
    git("init", "--quiet");
    for (const directory of ["db/platform/migrations", "supabase/migrations"]) for (const file of readdirSync(directory)) {
      const path = `${directory}/${file}`;
      if (!pins.some(pin => pin.path === path)) put(path, readFileSync(path));
    }
    expect(historical.batchedForwards).toHaveLength(14);
    // A historical set must never become a valid current-candidate inventory.
    expect(() => readReviewedForwardRegistry(Buffer.from(JSON.stringify(historical)))).toThrow("reviewed batch requires exactly the approved forwards");
    put(registryPath, JSON.stringify(historical));
    const approval14 = commit("Earlier 14-pin control");
    put(n1.path, bytes(n1));
    const feature = commit("Separately approved N1 feature");
    put(registryPath, registryBytes);
    const approval16 = commit("CTL-2 adds only native approvals");
    for (const pin of [n1]) expect(() => assertReviewedPlatformForward(folder, approval14, approval16, pin.path, bytes(pin), true)).not.toThrow();
    for (const pin of pins.filter(pin => pin.path.startsWith("db/") && pin.path <= x.path)) put(pin.path, bytes(pin));
    const landedX = commit("X lands after separate 16-pin approval");
    for (const pin of [n1, x]) expect(() => assertReviewedPlatformForward(folder, approval14, landedX, pin.path, bytes(pin), true)).not.toThrow();

    for (const attack of ["digest drift", "signature drift", "non-N1 signature drift", "chain drift", "reordered", "non-N1 reordered", "extra", "unknown size", "current prefix"]) {
      git("reset", "--hard", approval14);
      const changed = structuredClone(historical), batch = changed.batchedForwards!;
      if (attack === "digest drift") batch[0]!.sha256 = "0".repeat(64);
      if (attack === "signature drift") batch[0]!.functions[0]!.signature = "public.unpinned()";
      if (attack === "non-N1 signature drift") batch[1]!.functions[0]!.signature = "public.unpinned()";
      if (attack === "chain drift") batch.find(pin => pin.path.includes("181000"))!.functions[0]!.beforeSha256 = "0".repeat(64);
      if (attack === "reordered") [batch[0], batch[1]] = [batch[1]!, batch[0]!];
      if (attack === "non-N1 reordered") [batch[1], batch[2]] = [batch[2]!, batch[1]!];
      if (attack === "extra") batch.push(batch[0]!);
      if (attack === "unknown size") batch.pop();
      if (attack === "current prefix") changed.batchedForwards = pins.slice(0, 14);
      put(registryPath, JSON.stringify(changed));
      const invalid = commit(`Historical approval plant: ${attack}`);
      expect(() => assertUnchangedForwardApproval(folder, invalid, approval16, n1.path), attack).toThrow(/approved separately/u);
    }
    git("reset", "--hard", feature);
    put(registryPath, registryBytes);
    for (const pin of pins.filter(pin => pin.path.startsWith("db/") && pin.path <= x.path)) put(pin.path, bytes(pin));
    const self = commit("X attempts approval and SQL in the same commit");
    expect(() => assertReviewedPlatformForward(folder, approval14, self, x.path, bytes(x), true)).toThrow(/approved separately|exactly the approved forwards/u);
  } finally { rmSync(folder, { recursive: true, force: true }); }
}, 60_000);

// Measured alone at 74.99 s (2026-10-23); about 3x keeps shared-machine load from timing it out.
it("retains separate prior approval in CI and release, and refuses incorrect pins", () => {
  const folder = mkdtempSync(join(tmpdir(), "openlup-batch-control-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", folder, ...args], { encoding: "utf8" }).trim();
  const put = (path: string, value: Buffer | string) => { mkdirSync(dirname(join(folder, path)), { recursive: true }); writeFileSync(join(folder, path), value); };
  const commit = (message: string) => { git("add", "."); git("-c", "user.name=Control Test", "-c", "user.email=control@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", message); return git("rev-parse", "HEAD"); };
  try {
    git("init", "--quiet");
    for (const folderName of ["db/platform/migrations", "supabase/migrations"]) {
      for (const file of readdirSync(folderName)) {
        const path = `${folderName}/${file}`;
        if (!pins.some(pin => pin.path === path)) put(path, readFileSync(path));
      }
    }
    put("config/reviewed-platform-forwards.json", registryBytes);
    const approval = commit("Exact control approval");
    for (const pin of [pins[0]!, ...registry.portableReplacementForwards!, ...registry.portableCreationForwards!, ...registry.managedInvoicingForwards!]
      .filter(pin => pin.path === pins[0]!.path || /202610221(?:65000|9[0-9]{4})_/u.test(pin.path))) {
      put(pin.path, pin.path === pins[0]!.path ? bytes(pins[0]!) : readFileSync(pin.path));
      put("classification.txt", pin.path);
      const head = commit(`Preserve landed classification: ${pin.path}`);
      expect(() => assertReviewedPlatformForward(folder, approval, head, pin.path, readFileSync(join(folder, pin.path)))).not.toThrow();
      git("reset", "--hard", approval);
    }
    // Every same-rail prefix is admissible; a hole is never filled by a fixture.
    for (const directory of ["db/platform/migrations", "supabase/migrations"]) {
      const railPins = pins.filter(pin => rail(pin) === directory);
      for (const pin of railPins) {
        put(pin.path, bytes(pin));
        const head = commit("Next same-rail prefix");
        expect(() => reviewedBatchPaths(folder, directory, railPins)).not.toThrow();
        expect(() => assertReviewedPlatformForward(folder, approval, head, pin.path, bytes(pin))).not.toThrow();
      }
      git("reset", "--hard", approval);
    }
    for (const [suffix, earlier] of [
      ["20261024184500_subscription_retry_late_positive_stock.sql", "20261024184000_subscription_renewal_reserve_uses_seam.sql"],
      ["20261024184600_subscription_retry_candidate_payment_filter.sql", "20261024184500_subscription_retry_late_positive_stock.sql"],
      ["20261024184000_subscription_renewal_reserve_uses_seam.sql", "20261024183000_inventory_available_to_promise.sql"],
      ["20261024184000_inventory_reserve_order_uses_seam.sql", "20261024175000_inventory_available_to_promise.sql"],
      ["20261024185000_provider_refund_evidence.sql", "20261024175000_inventory_available_to_promise.sql"],
    ]) {
      const pin = pins.find(pin => pin.path.endsWith(suffix!))!;
      const railPins = pins.filter(prior => rail(prior) === rail(pin));
      for (const prior of railPins.filter(prior => prior.path <= pin.path && !prior.path.endsWith(earlier!))) put(prior.path, bytes(prior));
      // F17 after P3b, with the entire P5 suffix absent.
      if (suffix!.includes("185000")) for (const prior of railPins.filter(prior => /202610241[78]/u.test(prior.path) && prior.path < pin.path)) rmSync(join(folder, prior.path), { force: true });
      const head = commit("Hole in landed rail");
      expect(() => assertReviewedPlatformForward(folder, approval, head, pin.path, bytes(pin))).toThrow("reviewed batch requires every earlier same-rail pin landed first");
      expect(() => reviewedBatchPaths(folder, rail(pin), railPins)).toThrow("reviewed batch requires every earlier same-rail pin landed first");
      git("reset", "--hard", approval);
    }
    // D-earlier-pin-digest-unplanted: unchanged SQL semantics, changed whole-file digest.
    const managed = pins.filter(pin => rail(pin) === "supabase/migrations");
    const earlier = managed[0]!;
    const later = managed[1]!;
    expect(earlier.path).toContain("20261024155000");
    expect(later.path).toContain("20261024160000");
    put(earlier.path, Buffer.concat([bytes(earlier), Buffer.from(" ")]));
    put(later.path, bytes(later));
    const drifted = commit("Earlier same-rail pin has changed bytes");
    for (const release of [false, true]) {
      expect(() => assertReviewedPlatformForward(folder, approval, drifted, later.path, bytes(later), release))
        .toThrow("reviewed batch requires every earlier same-rail pin landed first");
    }
    git("reset", "--hard", approval);
    for (const pin of pins) put(pin.path, bytes(pin));
    const head = commit("Pinned feature bytes");
    for (const pin of pins) for (const release of [false, true]) expect(() => assertReviewedPlatformForward(folder, approval, head, pin.path, bytes(pin), release)).not.toThrow();
    const changed = structuredClone(registry); changed.batchedForwards![0]!.sha256 = "0".repeat(64);
    put("config/reviewed-platform-forwards.json", JSON.stringify(changed));
    const self = commit("Feature attempts to change its own approval");
    expect(() => assertReviewedPlatformForward(folder, approval, self, pins[0]!.path, bytes(pins[0]!))).toThrow(/path or bytes/u);
  } finally { rmSync(folder, { recursive: true, force: true }); }
}, 240_000);

// Repin the changed statement so refusal reaches the grantee predicate.
it.each(["authenticated", "service_role, authenticated"])("refuses a repinned managed creation grantee: %s", grantee => {
  const pin = pins.find(item => item.path.endsWith("20261024185000_provider_refund_evidence.sql"))!;
  const sql = bytes(pin).toString().replace(/ TO service_role;/gu, ` TO ${grantee};`);
  expect(sql).not.toBe(bytes(pin).toString());
  expect(() => assertBatchedForward(repin(pin, sql), Buffer.from(sql), prefix(pin)))
    .toThrow("reviewed batch function privilege target or grantee drifted");
});

it.each([0, 1, "P3b", "all"] as const)("replays each rail once with %s landed pins and refuses landed drift", landed => {
  const root = mkdtempSync(join(tmpdir(), "openlup-batch-landing-"));
  const put = (path: string, value: Buffer | string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), value); };
  try {
    for (const directory of ["db/platform/migrations", "supabase/migrations"]) {
      const railPins = pins.filter(pin => rail(pin) === directory);
      const originalPrefix = reviewedBatchPaths(process.cwd(), directory, railPins).filter(path => !railPins.some(pin => pin.path === path));
      for (const path of originalPrefix) put(path, readFileSync(path));
      for (const pin of railPins.slice(0, landed === "all" ? undefined : landed === "P3b" ? directory.startsWith("db/") ? 1 : 2 : landed)) put(pin.path, bytes(pin));
      // A later unpinned file must not enter the pre-pin replay either.
      put(`${directory}/99999999999999_unrelated.sql`, "SELECT 1;");
      const interleaved = Array.from({ length: 60 }, (_, second) => `${directory}/202610241805${String(second).padStart(2, "0")}_unpinned.sql`)
        .find(path => !existsSync(join(root, path)));
      if (!interleaved) throw new Error("Reviewed batch test has no free interleaved probe filename");
      writeFileSync(join(root, interleaved), "SELECT 1;", { flag: "wx" });
      const paths = reviewedBatchPaths(root, directory, railPins);
      expect(paths).toEqual([...originalPrefix, ...railPins.map(pin => pin.path), interleaved].sort());
      const preceding: Buffer[] = [];
      for (const path of paths) {
        const pin = railPins.find(pin => pin.path === path);
        const source = pin ? reviewedBatchBytes(root, process.cwd(), pin) : readFileSync(join(root, path));
        if (pin) assertBatchedForward(pin, source, preceding);
        preceding.push(source);
      }
      expect(preceding).toHaveLength(originalPrefix.length + railPins.length + 1);
      const pin = railPins[0]!;
      put(pin.path, Buffer.concat([bytes(pin), Buffer.from(" ")]));
      expect(() => reviewedBatchBytes(root, process.cwd(), pin)).toThrow("landed bytes drifted");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Historical M09 correction pair and its managed prefix, with only the pair's pins changed.
const correctionPaths = registry.managedInvoicingForwards!.slice(0, 2).map(({ path }) => path);
function correctionFixture() {
  const root = mkdtempSync(join(tmpdir(), "openlup-co-located-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" }).trim();
  const put = (path: string, value: Buffer | string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), value); };
  const commit = () => { git("add", "."); git("commit", "-qm", "SQL approval fixture"); return git("rev-parse", "HEAD"); };
  git("init", "-q", "-b", "main");
  for (const directory of ["db/platform/migrations", "supabase/migrations"]) for (const file of readdirSync(directory)) {
    const path = `${directory}/${file}`;
    if (directory !== "supabase/migrations" || path < correctionPaths[0]!) put(path, readFileSync(path));
  }
  put("config/platform-migration-manifest.json", readFileSync("config/platform-migration-manifest.json"));
  const previous = structuredClone(registry);
  for (const entry of previous.managedInvoicingForwards!.slice(0, 2)) entry.sha256 = "0".repeat(64);
  put("config/reviewed-platform-forwards.json", JSON.stringify(previous));
  const base = commit();
  const install = (next = registry) => {
    put("config/reviewed-platform-forwards.json", JSON.stringify(next));
    for (const path of correctionPaths) put(path, readFileSync(path));
  };
  return { root, git, put, commit, base, previous, install, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("co-located SQL and pins under an existing policy", () => {
  it("releases co-located forwards introduced by successive mainline merge commits", () => {
    const f = correctionFixture();
    try {
      for (const [index, path] of correctionPaths.entries()) {
        f.git("checkout", "-b", `feature-${index}`);
        const next = structuredClone(registry);
        if (index === 0) next.managedInvoicingForwards![1]!.sha256 = "0".repeat(64);
        f.put("config/reviewed-platform-forwards.json", JSON.stringify(next));
        f.put(path, readFileSync(path)); f.commit();
        f.git("checkout", "main"); f.git("merge", "--no-ff", "--no-commit", `feature-${index}`); f.commit();
      }
      const head = f.git("rev-parse", "HEAD");
      for (const path of correctionPaths) expect(() => assertReviewedPlatformForward(f.root, f.base, head, path, readFileSync(path), true)).not.toThrow();
    } finally { f.cleanup(); }
  });

  it("accepts the historical M09 correction pair in admission, migration and release checks", () => {
    const f = correctionFixture();
    try {
      f.install(); const head = f.commit();
      expect(() => assertCoLocatedForwardApproval(f.root, f.base, head)).not.toThrow();
      expect(() => assertAppendOnlyMigrationHistory(f.root, f.base, head)).not.toThrow();
      for (const path of correctionPaths) expect(() => assertReviewedPlatformForward(f.root, f.base, head, path, readFileSync(path), true)).not.toThrow();
    } finally { f.cleanup(); }
  });

  it("preserves co-located bindings through later unrelated release approvals", () => {
    const f = correctionFixture();
    try {
      f.install(); f.commit();
      const later = structuredClone(registry); later.managedInvoicingForwards![2]!.sha256 = "f".repeat(64);
      f.put("config/reviewed-platform-forwards.json", JSON.stringify(later)); const release = f.commit();
      for (const path of correctionPaths) expect(() => assertReviewedPlatformForward(f.root, f.base, release, path, readFileSync(path), true)).not.toThrow();
    } finally { f.cleanup(); }
  });

  it("retains the actual M09 legacy two-PR control and feature history", () => {
    const f = correctionFixture();
    try {
      f.put("config/reviewed-platform-forwards.json", registryBytes); const control = f.commit();
      f.install(); const feature = f.commit();
      expect(() => assertAppendOnlyMigrationHistory(f.root, control, feature)).not.toThrow();
      for (const path of correctionPaths) expect(() => assertReviewedPlatformForward(f.root, f.base, feature, path, readFileSync(path), true)).not.toThrow();
    } finally { f.cleanup(); }
  });

  it.each(["future entry", "installed entry", "shared field", "position", "unknown class"])("refuses a co-located %s delta", probe => {
    const f = correctionFixture();
    try {
      const changed = structuredClone(registry);
      if (probe === "future entry") changed.managedInvoicingForwards![2]!.sha256 = "f".repeat(64);
      if (probe === "installed entry") changed.replacementForwards[0]!.sha256 = "f".repeat(64);
      if (probe === "shared field") changed.baselineSha256 = "f".repeat(64);
      if (probe === "position") changed.replacementForwards.reverse();
      if (probe === "unknown class") changed.managedInvoicingForwards![0]!.path += ".other";
      f.install(changed); const head = f.commit();
      expect(() => assertCoLocatedForwardApproval(f.root, f.base, head)).toThrow(/reviewed/u);
      expect(() => assertForwardApproval(f.root, f.base, head)).toThrow(/reviewed/u);
    } finally { f.cleanup(); }
  });

  it.each(["scripts/reviewed-platform-forward.ts", "scripts/platform-migration-manifest.ts", "scripts/documentation-git.ts", "scripts/documentation-routing.ts", "scripts/oss-source-release-contract.ts", "scripts/oss-published-tree-check.ts", "scripts/source-preview-release.ts", "scripts/source-release-preparation.ts", "scripts/oss-publication-policy.ts", "scripts/packages/release-gate.ts", "scripts/agent-review-queue.mjs", "package.json", "package-lock.json", ".github/workflows/published-tree-ci.yml"])("trusted invocation refuses co-changing %s", path => {
    const f = correctionFixture();
    try {
      f.install(); f.put(path, "candidate-controlled machinery"); const head = f.commit();
      expect(() => assertCoLocatedForwardApproval(f.root, f.base, head)).toThrow(/machinery must be approved separately/u);
    } finally { f.cleanup(); }
  });

  it("allows test-only coverage changes alongside the co-located SQL/pins", () => {
    const f = correctionFixture();
    try {
      f.install(); f.put("scripts/source-preview-release.test.ts", "// Additional SQL regression coverage\n");
      const head = f.commit();
      expect(() => assertCoLocatedForwardApproval(f.root, f.base, head)).not.toThrow();
    } finally { f.cleanup(); }
  });

  it("refuses a policy move since the reviewed base and preserves the control-only route", () => {
    const f = correctionFixture();
    try {
      f.put("config/reviewed-platform-forwards.json", registryBytes); const control = f.commit();
      expect(() => assertCoLocatedForwardApproval(f.root, f.base, control)).not.toThrow();
      f.git("reset", "--hard", f.base); f.install(); const head = f.commit();
      f.git("checkout", "--detach", f.base); f.put("scripts/reviewed-platform-forward.ts", "new main policy"); const main = f.commit();
      expect(() => assertCoLocatedForwardApproval(f.root, f.base, head, main)).toThrow(/machinery must be approved separately/u);
    } finally { f.cleanup(); }
  });

  it.each(["bytes", "repinned grant", "late pin", "applied edit"])("refuses %s through the affected production gates", probe => {
    const f = correctionFixture(); const path = correctionPaths[0]!;
    try {
      const changed = structuredClone(registry);
      f.install(probe === "late pin" ? f.previous : changed);
      if (probe === "bytes") f.put(path, readFileSync(path, "utf8") + "\n");
      if (probe === "repinned grant") {
        const sql = readFileSync(path, "utf8").replace(/ TO service_role;/gu, " TO authenticated;");
        expect(sql).not.toBe(readFileSync(path, "utf8"));
        const entry = changed.managedInvoicingForwards![0]!;
        entry.sha256 = sqlSha256(sql);
        const definitions = reviewedFunctionDefinitions(Buffer.from(sql));
        for (const fn of entry.functions) fn.afterSha256 = definitions.get(fn.signature)!;
        f.put("config/reviewed-platform-forwards.json", JSON.stringify(changed)); f.put(path, sql);
      }
      const introduction = f.commit();
      if (probe === "applied edit") {
        f.put(path, readFileSync(path, "utf8") + "\n"); const head = f.commit();
        expect(() => assertAppendOnlyMigrationHistory(f.root, introduction, head)).toThrow(/edit, deletion/u);
      } else if (probe === "late pin") {
        f.put("config/reviewed-platform-forwards.json", registryBytes); const head = f.commit();
        expect(() => assertReviewedPlatformForward(f.root, f.base, head, path, readFileSync(path), true)).toThrow(/approved separately/u);
      } else {
        expect(() => assertCoLocatedForwardApproval(f.root, f.base, introduction)).toThrow(/reviewed/u);
        expect(() => assertAppendOnlyMigrationHistory(f.root, f.base, introduction)).toThrow(/reviewed|non-expand/u);
        expect(() => assertReviewedPlatformForward(f.root, f.base, introduction, path, readFileSync(join(f.root, path)), true)).toThrow(/reviewed/u);
      }
    } finally { f.cleanup(); }
  });

  it.each(["pull_request", "merge_group"])("runs actual migration and native admission entry points for %s", async eventName => {
    const f = correctionFixture();
    try {
      f.install(); const head = f.commit();
      f.git("update-ref", "refs/remotes/origin/main", f.base);
      const candidate = await captureCommittedReviewCandidate(f.root, f.base, head);
      let session = prepareCandidate(null, { ...candidate, intent: { risk: "behavior", criteria: "Exact co-located SQL/pins" }, authorSessionId: "fixture-author" }, 1000);
      for (const reviewer of ["fixture-a", "fixture-b"]) session = recordReport(session, { reviewer, cold: true, tree: candidate.tree, verdict: "PASS", findings: [], closes: [] }, 1000);
      const receipt = receiptSummary(session, 12, 1000);
      const merged = f.git("commit-tree", candidate.tree, "-p", f.base, "-p", head, "-m", "Event merge");
      f.git("checkout", "--detach", merged);
      const ref = `refs/heads/gh-readonly-queue/main/pr-12-${f.base}`;
      const event = { number: 12, repository: { full_name: "openlup/openlup", private: false }, action: "checks_requested", pull_request: { base: { sha: f.base }, head: { sha: head } }, merge_group: { base_ref: "refs/heads/main", head_ref: ref, base_sha: f.base, head_sha: merged, head_commit: { id: merged, tree_id: candidate.tree } } };
      const eventPath = join(f.root, "event.json"); writeFileSync(eventPath, JSON.stringify(event));
      const env = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "openlup/openlup", GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: eventPath, GITHUB_SHA: merged, GITHUB_REF: ref };
      const comparison = resolveDocumentationBase(f.root, { env });
      expect(comparison.provenance).toBe(eventName === "pull_request" ? "pull-request" : "merge-group");
      expect(() => assertAppendOnlyMigrationHistory(f.root, comparison.base, comparison.head)).not.toThrow();
      const api = { get: async (path: string) => path.includes("/pulls/") ? { number: 12, state: "open", draft: false, base: { ref: "main" }, head: { sha: head } } : path.includes("/issues/") ? [{ id: 1, user: { login: "fixture-owner", type: "User" }, body: `${RECEIPT_MARKER}\n\`\`\`json\n${JSON.stringify(receipt)}\n\`\`\`` }] : path.includes("/collaborators/") ? { permission: "write" } : { object: { sha: f.base } } };
      const runGit = (cwd: string, ...args: string[]) => args.includes("fetch") ? Promise.resolve("") : reviewGit(cwd, ...args);
      await expect(waitNativeAdmission({ cwd: f.root, event, env, api, runGit, now: () => 1000, deadlineMs: 1 })).resolves.toEqual(receipt);
    } finally { f.cleanup(); }
  });

  it("keeps unchanged bindings and their positions while recognizing the pending M09 repins", () => {
    const previous = structuredClone(registry);
    previous.managedInvoicingForwards![0]!.sha256 = "0".repeat(64);
    expect(changedForwardApprovals(Buffer.from(JSON.stringify(previous)), registryBytes)).toEqual([correctionPaths[0]]);
    expect(changedForwardApprovals(registryBytes, registryBytes)).toEqual([]);
  });
});

// Each CTL-2 plant identifies the exact predicate; repinning bypasses earlier byte/count guards where required.
describe.each(pins.filter(pin => /20261024184[56]00/u.test(pin.path)))("CTL-2 predicates: $path", pin => {
  it("refuses byte drift at the whole-file digest", () => {
    expect(() => assertBatchedForward(pin, Buffer.concat([bytes(pin), Buffer.from(" ")]), prefix(pin)))
      .toThrow("reviewed batch path or bytes drifted");
  });
  it("refuses a wrong before-hash at actual preceding definitions and registry continuity", () => {
    const changed = { ...structuredClone(pin), functions: pin.functions.map(fn => ({ ...fn, beforeSha256: "0".repeat(64) })) };
    expect(() => assertBatchedForward(changed, bytes(pin), prefix(pin))).toThrow("reviewed batch definition drifted");
    const changedRegistry = structuredClone(registry);
    changedRegistry.batchedForwards![pins.indexOf(pin)] = changed;
    expect(() => readReviewedForwardRegistry(Buffer.from(JSON.stringify(changedRegistry))))
      .toThrow("reviewed batch replacement chain is reordered or discontinuous");
  });
  it.each(["service_role", "service_role, authenticated"])("refuses a fully repinned extra/wider function grant to %s at the privilege predicate", grantee => {
    const sql = bytes(pin).toString() + `\nGRANT EXECUTE ON FUNCTION ${pin.functions[0]!.signature} TO ${grantee};`;
    expect(() => assertBatchedForward(repin(pin, sql), Buffer.from(sql), prefix(pin)))
      .toThrow("reviewed batch function privilege target or grantee drifted");
  });
  it("refuses an extra statement at ordered statement count after file repinning", () => {
    const sql = bytes(pin).toString() + "\nCREATE SCHEMA unpinned;";
    expect(() => assertBatchedForward({ ...pin, sha256: sqlSha256(sql) }, Buffer.from(sql), prefix(pin)))
      .toThrow("reviewed batch missing or extra statements");
  });
  it.each(["path", "version"])("refuses a %s move at the fixed registry inventory", move => {
    const changed = structuredClone(registry);
    changed.batchedForwards![pins.indexOf(pin)]!.path = move === "path" ? pin.path.replace("_subscription", "_moved_subscription") : pin.path.replace("20261024", "20261023").replace("20261022", "20261023");
    expect(() => readReviewedForwardRegistry(Buffer.from(JSON.stringify(changed))))
      .toThrow("reviewed batch has an invalid path, order or signature inventory");
  });
});


it.each(pins.filter(pin => pin.path.includes("20261024")))("refuses the old pending identity: $path", pin => {
  const old = { ...pin, path: pin.path.replace("20261024", "20261022") };
  expect(() => assertBatchedForward(old, bytes(pin), prefix(pin))).toThrow("reviewed batch path or bytes drifted");
  const changed = structuredClone(registry);
  changed.batchedForwards![pins.indexOf(pin)] = old;
  expect(() => readReviewedForwardRegistry(Buffer.from(JSON.stringify(changed)))).toThrow("invalid path, order or signature inventory");
});

it("refuses the deleted Z identity and the pre-fold N2 bytes even after file/statement repinning", () => {
  const pin = pins[1]!;
  const old = bytes(pin).toString().replace("(r.command->'payload')-'acceptedQuoteHash'", "r.command->'payload'-'acceptedQuoteHash'");
  expect(old).not.toBe(bytes(pin).toString());
  expect(() => assertBatchedForward(pin, Buffer.from(old), prefix(pin))).toThrow("path or bytes drifted");
  expect(() => assertBatchedForward(repin(pin, old), Buffer.from(old), prefix(pin))).toThrow("definition drifted");
  for (const date of ["20261022", "20261024"]) {
    const z = { ...pin, path: `db/platform/migrations/${date}184700_subscription_command_preview_replay.sql` };
    expect(() => assertBatchedForward(z, bytes(pin), prefix(pin))).toThrow("path or bytes drifted");
    const changed = structuredClone(registry); changed.batchedForwards!.push(z);
    expect(() => readReviewedForwardRegistry(Buffer.from(JSON.stringify(changed)))).toThrow("exactly the approved forwards");
  }
});

it.each([
  ["db/platform/migrations", "20261022195000"],
  ["db/platform/migrations", "20261022194999"],
  ["supabase/migrations", "20261022195100"],
  ["supabase/migrations", "20261022195099"],
])("refuses a new version at or below the current rail tail: %s %s", (directory, version) => {
  const f = correctionFixture();
  try {
    // Preserve the actual complete landed rails; harmless expand-only SQL reaches
    // the version gate independently of the fixed M10 registry-path refusal.
    for (const rail of ["db/platform/migrations", "supabase/migrations"]) for (const file of readdirSync(rail)) f.put(`${rail}/${file}`, readFileSync(`${rail}/${file}`));
    const base = f.commit();
    f.put(`${directory}/${version}_tail_refusal_probe.sql`, "CREATE TABLE public.tail_refusal_probe(id uuid);\n");
    const head = f.commit();
    expect(() => assertAppendOnlyMigrationHistory(f.root, base, head)).toThrow("non-increasing version");
  } finally { f.cleanup(); }
});

describe("admitted M11 commerce live registry", () => {
  const beforeAdmission = structuredClone(registry);
  delete beforeAdmission.managedCommerceForwards;
  const beforeAdmissionBytes = Buffer.from(JSON.stringify(beforeAdmission));
  const commerce = registry.managedCommerceForwards!;
  const commerceBytes = (pin: ManagedCommerceForwardBinding) => {
    const fixture = readFileSync(`scripts/fixtures/reviewed-m11/${pin.path}`);
    if (existsSync(pin.path)) expect(readFileSync(pin.path), pin.path).toEqual(fixture);
    return fixture;
  };
  const managedM10 = pins.filter(pin => pin.path.startsWith("supabase/"));
  const allPins = [...managedM10, ...commerce];
  // Include every earlier same-rail pin once; append only absent M11 fixtures.
  const committed = readdirSync("supabase/migrations").filter(name => name.endsWith(".sql")).sort()
    .map(name => ({ path: `supabase/migrations/${name}`, bytes: readFileSync(`supabase/migrations/${name}`) }))
    .filter(source => source.path < commerce[0]!.path);
  const sources = reviewedBatchPaths(process.cwd(), "supabase/migrations", allPins).map(path => {
    const pin = commerce.find(pin => pin.path === path);
    const m10 = managedM10.find(pin => pin.path === path);
    return { path, bytes: pin ? commerceBytes(pin) : m10 ? reviewedBatchBytes(process.cwd(), process.cwd(), m10) : readFileSync(path) };
  });
  const preceding = (pin: ManagedCommerceForwardBinding) => sources.filter(source => source.path < pin.path);
  const repinned = (pin: ManagedCommerceForwardBinding, sql: string) => {
    const changed = { ...structuredClone(pin), ...repin(pin, sql) };
    const definitions = batchedFunctionDefinitions(Buffer.from(sql));
    for (const fn of changed.functions) fn.afterSha256 = definitions.get(fn.signature) ?? fn.afterSha256;
    const candidate = structuredClone(registry);
    candidate.managedCommerceForwards![commerce.indexOf(pin)] = changed;
    return candidate;
  };
  const assert = (pin: ManagedCommerceForwardBinding, sql = commerceBytes(pin), candidate = registry, prior = preceding(pin)) =>
    assertManagedCommerceForward(candidate, pin.path, sql, prior);
  const coherentlyRepinned = (pin: ManagedCommerceForwardBinding, statements: string[], functions: ManagedCommerceForwardBinding["functions"]) => {
    const sql = Buffer.from(statements.join("\n"));
    const candidate = repinned(pin, sql.toString());
    const changed = candidate.managedCommerceForwards![commerce.indexOf(pin)]!;
    changed.functions = structuredClone(functions);
    const definitions = batchedFunctionDefinitions(sql);
    const names = new Set(functions.map(fn => fn.signature.split("(")[0]!));
    const prior = new Map<string, string>();
    for (const source of preceding(pin)) for (const statement of sqlStatements(source.bytes.toString(), true)) {
      for (const [signature, digest] of batchedFunctionDefinitions(Buffer.from(statement), names)) prior.set(signature, digest);
    }
    expect(changed.sha256).toBe(sqlSha256(sql));
    expect(changed.statements).toEqual(statements.map(statement => ({
      sha256: sqlSha256(statement), ...(!/^CREATE(?: OR REPLACE)? FUNCTION /u.test(statement) ? { sql: statement } : {}),
    })));
    expect([...definitions]).toEqual(functions.map(fn => [fn.signature, fn.afterSha256]));
    for (const fn of functions) expect(fn.beforeSha256, fn.signature).toBe(prior.get(fn.signature) ?? null);
    const acl = functions.flatMap(fn => [
      `REVOKE ALL ON FUNCTION ${fn.signature} FROM PUBLIC,anon,authenticated${fn.signature.startsWith("private.") ? ",service_role" : fn.signature === "public.inventory_new_purchase_stock_read(jsonb,timestamptz)" ? ",openlup_mcp_reader" : ""};`,
      ...fn.signature.startsWith("private.") ? [] : [`GRANT EXECUTE ON FUNCTION ${fn.signature} TO service_role;`],
    ]);
    expect(changed.statements.flatMap(statement => statement.sql && /^(?:REVOKE|GRANT) /u.test(statement.sql)
      ? [statement.sql.replace(/\s+/gu, " ").replace(/, /gu, ",")] : [])).toEqual(acl);
    return { sql, candidate };
  };

  it("retains all 18 M10 pins and uses the real prefix plus the absent fixture suffix exactly once", () => {
    expect(commerce).toHaveLength(9);
    expect(pins).toHaveLength(18);
    expect(managedM10).toHaveLength(11);
    for (const pin of pins) {
      const actual = reviewedBatchBytes(process.cwd(), process.cwd(), pin);
      expect(actual, pin.path).toEqual(bytes(pin));
      expect(sqlSha256(actual), pin.path).toBe(pin.sha256);
      expect(() => assertBatchedForward(pin, actual, prefix(pin)), pin.path).not.toThrow();
    }
    expect(preceding(commerce[0]!).filter(source => existsSync(source.path))).toEqual(committed);
    expect(preceding(commerce[0]!)).toHaveLength(committed.length + managedM10.filter(pin => !existsSync(pin.path)).length);
    expect(new Set(sources.map(source => source.path)).size).toBe(sources.length);
    expect(committed.at(-1)!.path < commerce[0]!.path).toBe(true);
    for (const pin of managedM10) expect(preceding(commerce[0]!).find(source => source.path === pin.path)?.bytes).toEqual(bytes(pin));
  }, 60_000);

  it.each(commerce)("accepts only the live class, after the real prefix: $path", pin => {
    expect(() => assert(pin)).not.toThrow();
    expect(() => assert(pin, commerceBytes(pin), beforeAdmission)).toThrow("reviewed M11 commerce has no registry approval");
    expect(() => assertBatchedForward(pin, commerceBytes(pin), preceding(pin).map(source => source.bytes))).toThrow("reviewed batch path or bytes drifted");
  });

  it.each(commerce)("refuses byte drift with its original pins: $path", pin => {
    expect(() => assert(pin, Buffer.concat([commerceBytes(pin), Buffer.from(" ")]))).toThrow("reviewed M11 commerce path or bytes drifted");
  });

  it.each([7, 8])("preserves %i-pin approval history without admitting it as a current candidate", count => {
    const seven = structuredClone(registry);
    seven.managedCommerceForwards!.splice(count);
    expect(() => readReviewedForwardRegistry(Buffer.from(JSON.stringify(seven)))).toThrow("reviewed M11 commerce requires exactly nine forwards");
    const f = correctionFixture();
    try {
      for (const source of preceding(commerce[0]!)) f.put(source.path, source.bytes);
      f.put("config/reviewed-platform-forwards.json", JSON.stringify(seven));
      const approval7 = f.commit();
      f.put(commerce[0]!.path, commerceBytes(commerce[0]!));
      const feature7 = f.commit();
      f.put("config/reviewed-platform-forwards.json", registryBytes);
      const approval8 = f.commit();
      for (const path of [pins[0]!.path, commerce[0]!.path]) {
        expect(() => assertUnchangedForwardApproval(f.root, approval7, feature7, path)).not.toThrow();
        expect(() => assertUnchangedForwardApproval(f.root, feature7, approval8, path)).not.toThrow();
      }
      expect(() => assertReviewedPlatformForward(f.root, approval7, approval8, commerce[0]!.path, commerceBytes(commerce[0]!), true)).not.toThrow();
      expect(() => assertUnchangedForwardApproval(f.root, approval7, approval8, commerce.at(-1)!.path)).toThrow("approved separately");
      for (const attack of ["missing", "order", "signature", "digest"]) {
        const changed = structuredClone(seven);
        const forwards = changed.managedCommerceForwards!;
        if (attack === "missing") forwards.splice(0, 1);
        if (attack === "order") [forwards[0], forwards[1]] = [forwards[1]!, forwards[0]!];
        if (attack === "signature") forwards[0]!.functions[0]!.signature += "extra";
        if (attack === "digest") forwards[0]!.sha256 = "0".repeat(64);
        f.put("config/reviewed-platform-forwards.json", JSON.stringify(changed));
        const invalid = f.commit();
        expect(() => assertUnchangedForwardApproval(f.root, invalid, approval8, commerce[0]!.path), attack).toThrow("approved separately");
      }
    } finally { f.cleanup(); }
  });

  it("uses the live approval through the production CI and release entrypoint", () => {
    const f = correctionFixture();
    try {
      // A disposable repository carries the actual complete managed prefix;
      // the contributor's live registry and index are never written.
      for (const source of preceding(commerce[0]!)) f.put(source.path, source.bytes);
      f.put("config/reviewed-platform-forwards.json", beforeAdmissionBytes);
      const live = f.commit();
      f.put("config/reviewed-platform-forwards.json", registryBytes);
      const approval = f.commit();
      // Control-only admission precedes all nine SQL files, as for M10.
      expect(() => assertAppendOnlyMigrationHistory(f.root, live, approval)).not.toThrow();
      for (const pin of commerce) {
        expect(existsSync(join(f.root, pin.path))).toBe(false);
        f.put(pin.path, commerceBytes(pin));
      }
      const head = f.commit();
      expect(changedForwardApprovals(beforeAdmissionBytes, registryBytes)).toEqual(commerce.map(pin => pin.path));
      for (const pin of commerce) {
        for (const release of [false, true]) {
          expect(() => assertReviewedPlatformForward(f.root, approval, head, pin.path, commerceBytes(pin), release), pin.path).not.toThrow();
        }
      }
      // Existing co-located SQL/data approval remains available only after
      // its machinery control; adding M11 must preserve that trust boundary.
      expect(() => assertForwardApproval(f.root, live, head)).not.toThrow();
      f.put("scripts/reviewed-platform-forward.ts", "co-changing admission machinery");
      const cochanged = f.commit();
      expect(() => assertCoLocatedForwardApproval(f.root, live, cochanged)).toThrow("reviewed replacement admission machinery must be approved separately before co-located SQL/pins");
    } finally { f.cleanup(); }
  }, 120_000);

  it("refuses unregistered M11 paths and byte drift through production admission", () => {
    const f = correctionFixture();
    try {
      for (const source of preceding(commerce[0]!)) f.put(source.path, source.bytes);
      f.put("config/reviewed-platform-forwards.json", registryBytes);
      const approval = f.commit();
      for (const pin of commerce) f.put(pin.path, commerceBytes(pin));
      const head = f.commit();
      for (const pin of commerce) {
        for (const release of [false, true]) {
          expect(() => assertReviewedPlatformForward(f.root, approval, head, pin.path.replace("20261025", "20261026"), commerceBytes(pin), release))
            .toThrow("non-expand-only forward differs from reviewed replacement path or bytes");
          expect(() => assertReviewedPlatformForward(f.root, approval, head, pin.path, Buffer.concat([commerceBytes(pin), Buffer.from(" ")]), release))
            .toThrow("non-expand-only forward differs from reviewed replacement path or bytes");
        }
      }
      for (const missing of [...managedM10.filter(pin => /20261025090[01]00/u.test(pin.path)), managedM10[0]!, commerce[0]!]) {
        f.git("rm", "--", missing.path);
        const hole = f.commit();
        expect(() => assertReviewedPlatformForward(f.root, approval, hole, commerce.at(-1)!.path, commerceBytes(commerce.at(-1)!)))
          .toThrow("reviewed M11 commerce requires every earlier same-rail M10/M11 pin landed first");
        f.put(missing.path, sources.find(source => source.path === missing.path)!.bytes);
        f.commit();
      }
    } finally { f.cleanup(); }
  }, 60_000);

  it.each(commerce.flatMap((pin, index) => ["CREATE OR REPLACE", ...pin.functions[0]!.beforeSha256 === null ? ["CREATE"] : []]
    .map(ddl => ({ pin, slot: index + 1, ddl }))))("refuses a coherent extra $ddl function in slot $slot", ({ pin, ddl }) => {
    expect(() => readReviewedForwardRegistry(registryBytes)).not.toThrow();
    expect(() => assert(pin)).not.toThrow();
    const signature = ddl === "CREATE" ? "public.reviewed_inventory_probe()" : "public.commerce_offer_policy_v2_readiness()";
    const names = new Set([signature.split("(")[0]!]);
    const before = preceding(pin).flatMap(source => sqlStatements(source.bytes.toString(), true))
      .filter(statement => batchedFunctionDefinitions(Buffer.from(statement), names).has(signature)).at(-1);
    const routine = ddl === "CREATE"
      ? "CREATE FUNCTION public.reviewed_inventory_probe() RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$ SELECT 1; $$;"
      : before!.replace(/^CREATE(?: OR REPLACE)? FUNCTION /u, "CREATE OR REPLACE FUNCTION ");
    expect(pin.functions.some(fn => fn.signature === signature)).toBe(false);
    expect(ddl === "CREATE" ? before === undefined : before !== undefined).toBe(true);
    const statements = [...sqlStatements(commerceBytes(pin).toString()), routine,
      `REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC, anon, authenticated;`,
      `GRANT EXECUTE ON FUNCTION ${signature} TO service_role;`];
    const functions = [...pin.functions, { signature, beforeSha256: before ? sqlSha256(before) : null, afterSha256: sqlSha256(routine) }];
    expect(functions).toHaveLength(pin.functions.length + 1);
    const { sql, candidate } = coherentlyRepinned(pin, statements, functions);
    const refusal = "reviewed M11 commerce path, order or function inventory drifted";
    expect(() => readReviewedForwardRegistry(Buffer.from(JSON.stringify(candidate)))).toThrow(new Error(refusal));
    expect(() => assert(pin, sql, candidate)).toThrow(new Error(refusal));
    const restored = coherentlyRepinned(pin, statements.slice(0, -3), functions.slice(0, -1));
    expect(() => readReviewedForwardRegistry(Buffer.from(JSON.stringify(restored.candidate)))).not.toThrow();
    expect(() => assert(pin, restored.sql, restored.candidate)).not.toThrow();
  });

  it("refuses the coherently swapped two-function inventory in slot 9", () => {
    const pin = commerce[8]!;
    expect(pin.functions).toHaveLength(2);
    const statements = sqlStatements(commerceBytes(pin).toString());
    const swapped = coherentlyRepinned(pin, [...statements.slice(3), ...statements.slice(0, 3)], [...pin.functions].reverse());
    const refusal = "reviewed M11 commerce signature or creation/replacement class drifted";
    expect(() => readReviewedForwardRegistry(Buffer.from(JSON.stringify(swapped.candidate)))).toThrow(new Error(refusal));
    expect(() => assert(pin, swapped.sql, swapped.candidate)).toThrow(new Error(refusal));
    const restored = coherentlyRepinned(pin, statements, pin.functions);
    expect(() => readReviewedForwardRegistry(Buffer.from(JSON.stringify(restored.candidate)))).not.toThrow();
    expect(() => assert(pin, restored.sql, restored.candidate)).not.toThrow();
  });

  describe.each(commerce)("independently repinned refusal: $path", pin => {
    it.each(["extra function", "missing function", "extra statement", "missing statement", "reordered statements", "GRANT/REVOKE", "security", "search_path"])("refuses %s", attack => {
      const statements = sqlStatements(commerceBytes(pin).toString());
      const routine = statements.findIndex(statement => /^CREATE(?: OR REPLACE)? FUNCTION /u.test(statement));
      if (attack === "extra function") statements.push("CREATE FUNCTION public.unpinned() RETURNS text LANGUAGE sql AS $$ SELECT ''; $$;");
      if (attack === "missing function") statements.splice(routine, 1);
      if (attack === "extra statement") statements.push("SELECT 1;");
      if (attack === "missing statement") statements.pop();
      if (attack === "reordered statements") [statements[routine], statements[routine + 1]] = [statements[routine + 1]!, statements[routine]!];
      if (attack === "GRANT/REVOKE") statements[routine + 1] = statements[routine + 1]!.replace("authenticated", "service_role");
      if (attack === "security") statements[routine] = statements[routine]!.includes("SECURITY DEFINER")
        ? statements[routine]!.replace("SECURITY DEFINER", "") : statements[routine]!.replace("LANGUAGE plpgsql", "LANGUAGE plpgsql SECURITY DEFINER");
      if (attack === "search_path") statements[routine] = statements[routine]!.replace(/SET search_path (?:= [a-z_, ]+|TO [^\n]+)/u, "SET search_path = public ");
      const sql = statements.join("\n");
      expect(sql, attack).not.toBe(sqlStatements(commerceBytes(pin).toString()).join("\n"));
      expect(() => assert(pin, Buffer.from(sql), repinned(pin, sql)), attack).toThrow(/reviewed M11 commerce|reviewed replacement runtime/u);
    });

    it.each(["comment", "newline", "quoted schema"])("refuses unsupported preceding replacement spelling: %s", attack => {
      const schema = pin.functions[0]!.signature.split(".")[0]!;
      const opening = attack === "comment" ? `CREATE /* probe */ OR REPLACE FUNCTION ${schema}.`
        : attack === "newline" ? `CREATE OR REPLACE\nFUNCTION ${schema}.` : `CREATE OR REPLACE FUNCTION "${schema}".`;
      const routine = sqlStatements(commerceBytes(pin).toString()).find(statement => /^CREATE(?: OR REPLACE)? FUNCTION /u.test(statement))!;
      const plant = routine.replace(/^CREATE(?: OR REPLACE)? FUNCTION (?:public|private)\./u, () => opening);
      const prior = [...preceding(pin), { path: "supabase/migrations/20261024235959_function_probe.sql", bytes: Buffer.from(plant) }]
        .sort((a,b) => a.path.localeCompare(b.path));
      expect(() => assert(pin, commerceBytes(pin), registry, prior)).toThrow("reviewed M11 commerce refuses unsupported preceding function DDL");
    });

    it("refuses reordered bytes against unchanged ordered statement pins", () => {
      const statements = sqlStatements(commerceBytes(pin).toString());
      statements.reverse();
      const sql = Buffer.from(statements.join("\n"));
      const candidate = structuredClone(registry);
      candidate.managedCommerceForwards![commerce.indexOf(pin)]!.sha256 = sqlSha256(sql);
      expect(() => assert(pin, sql, candidate)).toThrow();
    });

    it("refuses a changed target preimage introduced by an earlier same-rail file", () => {
      const signature = pin.functions[0]!.signature;
      const names = new Set([signature.split("(")[0]!]);
      const existing = preceding(pin).flatMap(source => sqlStatements(source.bytes.toString(), true))
        .filter(statement => batchedFunctionDefinitions(Buffer.from(statement), names).has(signature)).at(-1);
      const routine = existing ?? sqlStatements(commerceBytes(pin).toString()).find(statement => /^CREATE FUNCTION /u.test(statement))!;
      const plant = routine.replace(/\bAS (\$[a-z_0-9]*\$)/iu, match => `${match}\n-- Earlier function drift`);
      expect(plant).not.toBe(routine);
      const prior = [...preceding(pin), { path: "supabase/migrations/20261024235959_preimage_probe.sql", bytes: Buffer.from(plant) }].sort((a,b) => a.path.localeCompare(b.path));
      expect(() => assert(pin, commerceBytes(pin), registry, prior)).toThrow("reviewed M11 commerce function preimage or definition drifted");
    });
  });

  const stockReader = commerce[7]!;
  const oldStockRegistry = () => {
    const prior = structuredClone(registry);
    const pin = prior.managedCommerceForwards![7]!;
    pin.sha256 = "d865ca086c379e24b37a0d541112925176f332600b4d61c47777a26930630bb5";
    pin.functions[0]!.afterSha256 = "ef52b366a3a0641910020244aa9c49b06308fb5f0aca2867d49be092064efa61";
    pin.statements[0]!.sha256 = pin.functions[0]!.afterSha256;
    return prior;
  };

  describe.each([false, true])("mixed stock-reader pins (historical=%s)", historical => {
    it.each([
      ["file", true, false, false],
      ["CREATE", false, false, true],
      ["after", false, true, false],
      ["file and CREATE", true, false, true],
      ["file and after", true, true, false],
      ["after and CREATE", false, true, true],
      ["other statement", false, false, false],
      ["cross-field identifier", false, false, false],
    ] as const)("refuses legacy %s with hardened pins", (part, file, after, statement) => {
      const mixed = structuredClone(registry);
      const pin = mixed.managedCommerceForwards![7]!, old = oldStockRegistry().managedCommerceForwards![7]!;
      if (file) pin.sha256 = old.sha256;
      if (after) pin.functions[0]!.afterSha256 = old.functions[0]!.afterSha256;
      if (statement) pin.statements[0]!.sha256 = old.statements[0]!.sha256;
      if (part === "other statement") pin.statements[1] = { sha256: old.statements[0]!.sha256 };
      if (part === "cross-field identifier") pin.functions[0]!.afterSha256 = old.sha256;
      const bytes = Buffer.from(JSON.stringify(mixed));
      if (!historical) expect(() => readReviewedForwardRegistry(bytes)).toThrow("requires exact approval history");
      else {
        const f = correctionFixture();
        try {
          f.put("config/reviewed-platform-forwards.json", bytes);
          const approval = f.commit();
          f.put("history-marker.txt", "approval history");
          const same = f.commit();
          expect(() => assertUnchangedForwardApproval(f.root, approval, same, stockReader.path)).toThrow("approved separately");
        } finally { f.cleanup(); }
      }
    });
  });

  it("accepts the owner-privilege stock header and refuses the invoker approval as a candidate", () => {
    expect(() => readReviewedForwardRegistry(registryBytes)).not.toThrow();
    expect(() => assert(stockReader)).not.toThrow();
    expect(() => readReviewedForwardRegistry(Buffer.from(JSON.stringify(oldStockRegistry())))).toThrow("requires exact approval history");
    const oldSql = commerceBytes(stockReader).toString().replace(" SECURITY DEFINER", "").replace("pg_catalog, pg_temp AS", "pg_catalog AS");
    expect(() => assert(stockReader, Buffer.from(oldSql), repinned(stockReader, oldSql))).toThrow("requires exact approval history");
  });

  it.each([8, 9])("reads the exact %i-entry invoker registry only in approval history", count => {
    const f = correctionFixture();
    try {
      const prior = oldStockRegistry();
      prior.managedCommerceForwards!.splice(count);
      f.put("config/reviewed-platform-forwards.json", JSON.stringify(prior));
      const old = f.commit();
      f.put("history-marker.txt", "approval history");
      const same = f.commit();
      expect(() => assertUnchangedForwardApproval(f.root, old, same, stockReader.path)).not.toThrow();
      f.put("config/reviewed-platform-forwards.json", registryBytes);
      const amended = f.commit();
      expect(() => assertUnchangedForwardApproval(f.root, same, amended, commerce[0]!.path)).not.toThrow();
      expect(() => assertUnchangedForwardApproval(f.root, same, amended, stockReader.path)).toThrow("approved separately");
      const drift = structuredClone(prior);
      drift.managedCommerceForwards![7]!.sha256 = "0".repeat(64);
      f.put("config/reviewed-platform-forwards.json", JSON.stringify(drift));
      const invalid = f.commit();
      expect(() => assertUnchangedForwardApproval(f.root, invalid, same, commerce[0]!.path)).toThrow("approved separately");
    } finally { f.cleanup(); }
  });

  it.each(["SECURITY INVOKER", "search_path", "public overload path", "implicit pg_temp"])("refuses a fully repinned stock-reader %s header drift", attack => {
    const sql = commerceBytes(stockReader).toString();
    const drift = attack === "SECURITY INVOKER" ? sql.replace("SECURITY DEFINER", "SECURITY INVOKER")
      : sql.replace("search_path = pg_catalog, pg_temp", `search_path = ${attack === "public overload path" ? "pg_catalog, public" : attack === "implicit pg_temp" ? "pg_catalog" : "public"}`);
    expect(drift).not.toBe(sql);
    expect(() => assert(stockReader, Buffer.from(drift), repinned(stockReader, drift))).toThrow("function header or order drifted");
  });

  it("refuses a fully repinned omission of the stock reader revocation", () => {
    const pin = commerce.find(pin => pin.functions[0]!.signature === "public.inventory_new_purchase_stock_read(jsonb,timestamptz)")!;
    const sql = commerceBytes(pin).toString().replace(", openlup_mcp_reader", "");
    expect(() => assert(pin, Buffer.from(sql), repinned(pin, sql))).toThrow("reviewed M11 commerce function ACL drifted");
  });

  it.each(["path", "version", "order", "signature", "creation", "missing", "extra", "constraint", "M10 missing"])("refuses registry %s drift", attack => {
    const changed = structuredClone(registry);
    const forwards = changed.managedCommerceForwards!;
    if (attack === "path") forwards[0]!.path = forwards[0]!.path.replace("supabase/", "db/platform/");
    if (attack === "version") forwards[0]!.path = forwards[0]!.path.replace("20261025100000", "20261025100001");
    if (attack === "order") [forwards[0], forwards[1]] = [forwards[1]!, forwards[0]!];
    if (attack === "signature") forwards[0]!.functions[0]!.signature += "extra";
    if (attack === "creation") forwards[0]!.functions[0]!.beforeSha256 = null;
    if (attack === "missing") forwards.pop();
    if (attack === "extra") forwards.push(forwards[0]!);
    if (attack === "constraint") forwards[2]!.constraints![0]!.beforeSha256 = "0".repeat(64);
    if (attack === "M10 missing") delete changed.batchedForwards;
    expect(() => readReviewedForwardRegistry(Buffer.from(JSON.stringify(changed)))).toThrow(/reviewed M11 commerce/u);
  });

  it.each(managedM10)("refuses a missing M10 predecessor: $path", missing => {
    const pin = commerce[0]!;
    expect(() => assert(pin, commerceBytes(pin), registry, preceding(pin).filter(source => source.path !== missing.path))).toThrow("reviewed M11 commerce requires every earlier same-rail M10/M11 pin landed first");
  });

  it.each(allPins.slice(0, -1))("refuses byte drift in a required predecessor: $path", earlier => {
    const pin = commerce.at(-1)!;
    const prior = preceding(pin).map(source => source.path === earlier.path
      ? { ...source, bytes: Buffer.concat([source.bytes, Buffer.from(" ")]) } : source);
    expect(() => assert(pin, commerceBytes(pin), registry, prior)).toThrow("reviewed M11 commerce requires every earlier same-rail M10/M11 pin landed first");
  });

  it("refuses a hole, reversed prefix, duplicate prefix and a file in the wrong rail position", () => {
    const pin = commerce[1]!;
    const prior = preceding(pin);
    for (const changed of [prior.filter(source => source.path !== commerce[0]!.path), [...prior].reverse(), [...prior, prior.at(-1)!], sources]) {
      expect(() => assert(pin, commerceBytes(pin), registry, changed)).toThrow(/reviewed M11 commerce requires/u);
    }
    expect(() => assertManagedCommerceForward(registry, pin.path.replace("20261025103000", "20261024183001"), commerceBytes(pin), prior)).toThrow("reviewed M11 commerce path or bytes drifted");
  });

  it.each(["changed vocabulary", "dropped CHECK", "repinned replacement", "repinned lock timeout"])("refuses audit CHECK %s", attack => {
    const pin = commerce[2]!;
    if (attack.startsWith("repinned")) {
      const sql = commerceBytes(pin).toString().replace(attack === "repinned replacement" ? "'checkout_payment_link_mint'" : "'2s'", attack === "repinned replacement" ? "'extra_action'" : "'3s'");
      expect(() => assert(pin, Buffer.from(sql), repinned(pin, sql))).toThrow("reviewed M11 commerce audit CHECK replacement drifted");
    } else {
      const sql = `ALTER TABLE public.admin_audit_events DROP CONSTRAINT admin_audit_events_action_check;${attack === "changed vocabulary" ? "\nALTER TABLE public.admin_audit_events ADD CONSTRAINT admin_audit_events_action_check CHECK (action IN ('changed'));" : ""}`;
      const prior = [...preceding(pin), { path: "supabase/migrations/20261025103500_audit_probe.sql", bytes: Buffer.from(sql) }];
      expect(() => assert(pin, commerceBytes(pin), registry, prior)).toThrow("reviewed M11 commerce audit CHECK preimage changed in the preceding rail");
    }
  });

  it.each([
    'ALTER /* preceding comment */ TABLE public.admin_audit_events DROP CONSTRAINT admin_audit_events_action_check;',
    'alter table "public"."admin_audit_events" drop constraint admin_audit_events_action_check;',
    'DROP /* preceding comment */ TABLE public.admin_audit_events;',
  ])("refuses comment-separated or quoted audit-table mutations: %s", sql => {
    const pin = commerce[2]!;
    const prior = [...preceding(pin), { path: "supabase/migrations/20261025103500_audit_probe.sql", bytes: Buffer.from(sql) }];
    expect(() => assert(pin, commerceBytes(pin), registry, prior)).toThrow("reviewed M11 commerce audit CHECK preimage changed in the preceding rail");
  });

  it.each(commerce.filter(pin => !pin.functions[0]!.signature.startsWith("private.")))("refuses a fully repinned wider GRANT: $path", pin => {
    const sql = commerceBytes(pin).toString().replace(/TO service_role;/u, "TO authenticated;");
    expect(sql).not.toBe(commerceBytes(pin).toString());
    expect(() => assert(pin, Buffer.from(sql), repinned(pin, sql))).toThrow("reviewed M11 commerce function ACL drifted");
  });

  it("compares the actual CHECK preimage even when a changed baseline is separately repinned", () => {
    const pin = commerce[2]!;
    const prior = structuredClone(preceding(pin)).map(source => ({ ...source, bytes: Buffer.from(source.bytes) }));
    prior[0]!.bytes = Buffer.from(prior[0]!.bytes.toString().replace("'revoke'::text])))", "'changed'::text])))"));
    expect(prior[0]!.bytes).not.toEqual(preceding(pin)[0]!.bytes);
    const candidate = structuredClone(registry);
    candidate.baselineSha256 = sqlSha256(prior[0]!.bytes);
    expect(() => assert(pin, commerceBytes(pin), candidate, prior)).toThrow("reviewed M11 commerce audit CHECK preimage drifted");
  });

  const ninth = commerce.at(-1)!;
  it("binds exactly two independent replacements in the ninth entry", () => {
    expect(ninth.functions).toHaveLength(2);
    expect(ninth.functions.every(fn => fn.beforeSha256 !== null)).toBe(true);
    expect(ninth.statements).toHaveLength(6);
  });

  describe.each(ninth.functions.map((fn, index) => ({ ...fn, index })))("ninth replacement: $signature", fn => {
    it("refuses drift in either independently bound preimage", () => {
      const names = new Set([fn.signature.split("(")[0]!]);
      const old = preceding(ninth).flatMap(source => sqlStatements(source.bytes.toString(), true))
        .findLast(statement => batchedFunctionDefinitions(Buffer.from(statement), names).has(fn.signature))!;
      const plant = old.replace("BEGIN", "BEGIN\n  NULL;");
      const prior = [...preceding(ninth), { path: "supabase/migrations/20261024235959_ninth_preimage_probe.sql", bytes: Buffer.from(plant) }].sort((a,b) => a.path.localeCompare(b.path));
      expect(() => assert(ninth, commerceBytes(ninth), registry, prior)).toThrow("reviewed M11 commerce function preimage or definition drifted");
    });

    it.each(["extra body edit", "cadence 30"])("refuses %s against live function pins after file repinning", attack => {
      const statements = sqlStatements(commerceBytes(ninth).toString());
      const position = fn.index * 3;
      const old = statements[position]!;
      statements[position] = attack === "cadence 30" ? old.replaceAll("NOT IN (14, 21, 28)", "NOT IN (14, 21, 28, 30)") : old.replace("BEGIN", "BEGIN\n  NULL;");
      expect(statements[position]).not.toBe(old);
      const sql = Buffer.from(statements.join("\n"));
      const candidate = structuredClone(registry);
      candidate.managedCommerceForwards!.at(-1)!.sha256 = sqlSha256(sql);
      expect(() => assert(ninth, sql, candidate)).toThrow("reviewed M11 commerce function preimage or definition drifted");
    });

    it.each(["omit", "swap", "preimage"])("refuses registry %s of either function", attack => {
      const candidate = structuredClone(registry);
      const changed = candidate.managedCommerceForwards!.at(-1)!;
      if (attack === "omit") changed.functions.splice(fn.index, 1);
      if (attack === "swap") changed.functions.reverse();
      if (attack === "preimage") changed.functions[fn.index]!.beforeSha256 = "0".repeat(64);
      expect(() => assert(ninth, commerceBytes(ninth), candidate)).toThrow(/reviewed M11 commerce/u);
    });

    it.each(["omit", "swap", "reorder ACL", "ACL widening", "header"])("refuses independently repinned %s of either routine", attack => {
      const statements = sqlStatements(commerceBytes(ninth).toString());
      const position = fn.index * 3;
      if (attack === "omit") statements.splice(position, 3);
      if (attack === "swap") [statements[0], statements[3]] = [statements[3]!, statements[0]!];
      if (attack === "reorder ACL") [statements[position + 1], statements[position + 2]] = [statements[position + 2]!, statements[position + 1]!];
      if (attack === "ACL widening") statements[position + 2] = statements[position + 2]!.replace("TO service_role", "TO authenticated");
      if (attack === "header") statements[position] = statements[position]!.replace("SECURITY DEFINER", "SECURITY INVOKER");
      const sql = statements.join("\n");
      expect(() => assert(ninth, Buffer.from(sql), repinned(ninth, sql))).toThrow(/reviewed M11 commerce/u);
    });
  });

  it("tracks M11 data approvals without changing existing M09/M10 bindings", () => {
    expect(changedForwardApprovals(beforeAdmissionBytes, registryBytes)).toEqual(commerce.map(pin => pin.path));
    expect(beforeAdmission.batchedForwards).toEqual(registry.batchedForwards);
    expect(beforeAdmission.managedInvoicingForwards).toEqual(registry.managedInvoicingForwards);
  });
});

const replayPin = pins.find(pin => pin.path.includes("20261025090000"))!;
it.each([
  ["nullable column", "failed_payment_attempt_id uuid,", "failed_payment_attempt_id uuid NOT NULL,"],
  ["validated FK", " NOT VALID;", ";"],
  ["FK target", "REFERENCES public.commerce_payment_attempts(id)", "REFERENCES public.commerce_orders(id)"],
  ["backfill attribution", "HAVING count(DISTINCT attempt.id) = 1", "HAVING count(DISTINCT attempt.id) >= 1"],
  ["backfill scope", "WHERE d.status = 'open'", "WHERE d.status <> 'open'"],
  ["private grant", "FROM PUBLIC, anon, authenticated, service_role;", "FROM PUBLIC, anon, authenticated;\nGRANT EXECUTE ON FUNCTION public.subscription_open_dunning_before_sub_lock(text,uuid,text,text,timestamptz,text,uuid) TO service_role;"],
])("refuses fully repinned M10-9 %s drift", (_name, old, replacement) => {
  const sql = bytes(replayPin).toString().replace(old, replacement);
  expect(sql).not.toBe(bytes(replayPin).toString());
  expect(() => assertBatchedForward(repin(replayPin, sql), Buffer.from(sql), prefix(replayPin))).toThrow(/reviewed batch/u);
});
it.each([
  "UPDATE public.subscriptions SET next_cycle_at=now();",
  "ALTER TABLE public.subscription_dunning_cases ADD COLUMN unadmitted uuid;",
  "ALTER TABLE public.subscription_dunning_cases VALIDATE CONSTRAINT subscription_dunning_cases_failed_attempt_fkey;",
  "REVOKE ALL ON FUNCTION public.subscription_open_dunning_before_sub_lock(text,uuid,text,text,timestamptz,text) FROM service_role;",
])("refuses a repinned unadmitted M10-9 statement: %s", statement => {
  const sql = bytes(replayPin).toString() + "\n" + statement;
  expect(() => assertBatchedForward(repin(replayPin, sql), Buffer.from(sql), prefix(replayPin))).toThrow(/reviewed batch/u);
});

it("preserves exact 16-pin release history before the separate 18-pin control", () => {
  const folder = mkdtempSync(join(tmpdir(), "openlup-m10-9-history-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", folder, ...args], { encoding: "utf8" }).trim();
  const put = (path: string, value: Buffer | string) => { mkdirSync(dirname(join(folder, path)), { recursive: true }); writeFileSync(join(folder, path), value); };
  const commit = () => { git("add", "."); git("-c", "user.name=Control Test", "-c", "user.email=control@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "Synthetic control"); return git("rev-parse", "HEAD"); };
  try {
    git("init", "--quiet");
    const old = { ...registry, batchedForwards: pins.slice(0, 16) };
    expect(() => readReviewedForwardRegistry(Buffer.from(JSON.stringify(old)))).toThrow(/exactly the approved forwards/u);
    put("config/reviewed-platform-forwards.json", JSON.stringify(old));
    const approval16 = commit();
    put("config/reviewed-platform-forwards.json", registryBytes);
    const approval18 = commit();
    for (const pin of old.batchedForwards) expect(() => assertUnchangedForwardApproval(folder, approval16, approval18, pin.path)).not.toThrow();
    // Removing/reordering old approvals or injecting an 18-pin prefix cannot
    // reinterpret historical approval as a current or recognized old shape.
    for (const attack of ["reorder", "truncate", "changed pin"] as const) {
      git("reset", "--hard", approval16);
      const mutated = structuredClone(old);
      if (attack === "reorder") mutated.batchedForwards.reverse();
      if (attack === "truncate") mutated.batchedForwards.pop();
      if (attack === "changed pin") mutated.batchedForwards[0]!.sha256 = "0".repeat(64);
      put("config/reviewed-platform-forwards.json", JSON.stringify(mutated));
      const invalid = commit();
      expect(() => assertUnchangedForwardApproval(folder, invalid, approval18, pins[0]!.path)).toThrow(/approved separately/u);
    }
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

it("refuses co-location of the new M10-9 class with its admitting checker", () => {
  const folder = mkdtempSync(join(tmpdir(), "openlup-m10-9-colocation-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", folder, ...args], { encoding: "utf8" }).trim();
  const put = (path: string, value: Buffer | string) => { mkdirSync(dirname(join(folder, path)), { recursive: true }); writeFileSync(join(folder, path), value); };
  const commit = () => { git("add", "."); git("-c", "user.name=Control Test", "-c", "user.email=control@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "Synthetic control"); return git("rev-parse", "HEAD"); };
  try {
    git("init", "--quiet");
    put("config/reviewed-platform-forwards.json", JSON.stringify({ ...registry, batchedForwards: pins.slice(0,16) }));
    put("scripts/reviewed-platform-forward.ts", "Prior trusted checker");
    const base = commit();
    put("config/reviewed-platform-forwards.json", registryBytes);
    put("scripts/reviewed-platform-forward.ts", readFileSync("scripts/reviewed-platform-forward.ts"));
    const control = commit();
    expect(() => assertCoLocatedForwardApproval(folder,base,control)).not.toThrow();
    for (const pin of pins.slice(16)) put(pin.path,bytes(pin));
    const coLocated = commit();
    expect(() => assertCoLocatedForwardApproval(folder,base,coLocated)).toThrow("reviewed replacement admission machinery must be approved separately before co-located SQL/pins");
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

it.each(["missing", "duplicate", "reordered"])("refuses a repinned %s M10-9 prerequisite inventory", attack => {
  const statements = sqlStatements(bytes(replayPin).toString());
  if (attack === "missing") statements.splice(2,1);
  if (attack === "duplicate") statements.splice(2,0,statements[2]!);
  if (attack === "reordered") [statements[2],statements[3]] = [statements[3]!,statements[2]!];
  const sql = statements.join("\n");
  expect(() => assertBatchedForward(repin(replayPin,sql),Buffer.from(sql),prefix(replayPin))).toThrow(/ordered prerequisite\/ACL inventory drifted/u);
});
