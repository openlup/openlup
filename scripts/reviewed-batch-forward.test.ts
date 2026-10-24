import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { reviewedBatchBytes, reviewedBatchPaths } from "./reviewed-batch-rail.ts";
import { describe, expect, it } from "vitest";
import { assertBatchedForward, assertCoLocatedForwardApproval, assertForwardApproval, assertReviewedPlatformForward, assertUnchangedForwardApproval, batchedFunctionDefinitions, changedForwardApprovals, readReviewedForwardRegistry, reviewedFunctionDefinitions, sqlSha256, sqlStatements, type BatchedForwardBinding } from "./reviewed-platform-forward.ts";
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
    if (attack === "another path") changed.path = changed.path.replace("20261024", "20261023").replace("20261022", "20261023");
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
  if (attack === "order") [batch[6], batch[9]] = [batch[9]!, batch[6]!];
  if (attack === "chain") batch.find(pin => pin.path === "supabase/migrations/20261024181000_subscription_stock_wait_due.sql")!.functions[0]!.beforeSha256 = "0".repeat(64);
  if (attack === "path") batch[0]!.path += ".sql";
  if (attack === "private signature") batch[10]!.functions[0]!.signature = "private.unpinned()";
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
  historical.batchedForwards = pins.filter(pin => !/20261024184[56]00/u.test(pin.path))
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

    for (const attack of ["digest drift", "signature drift", "chain drift", "reordered", "extra", "unknown size", "current prefix"]) {
      git("reset", "--hard", approval14);
      const changed = structuredClone(historical), batch = changed.batchedForwards!;
      if (attack === "digest drift") batch[0]!.sha256 = "0".repeat(64);
      if (attack === "signature drift") batch[0]!.functions[0]!.signature = "public.unpinned()";
      if (attack === "chain drift") batch.find(pin => pin.path.includes("181000"))!.functions[0]!.beforeSha256 = "0".repeat(64);
      if (attack === "reordered") [batch[0], batch[1]] = [batch[1]!, batch[0]!];
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

it.each([0, 1, "all"] as const)("replays each rail once with %s landed pins and refuses landed drift", landed => {
  const root = mkdtempSync(join(tmpdir(), "openlup-batch-landing-"));
  const put = (path: string, value: Buffer | string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), value); };
  try {
    for (const directory of ["db/platform/migrations", "supabase/migrations"]) {
      const railPins = pins.filter(pin => rail(pin) === directory);
      const originalPrefix = reviewedBatchPaths(process.cwd(), directory, railPins).filter(path => !railPins.some(pin => pin.path === path));
      for (const path of originalPrefix) put(path, readFileSync(path));
      for (const pin of railPins.slice(0, landed === "all" ? undefined : landed)) put(pin.path, bytes(pin));
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
      await expect(waitNativeAdmission({ cwd: f.root, event, env, api, runGit, now: () => 1000, deadlineMs: 1 })).resolves.toBeUndefined();
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
