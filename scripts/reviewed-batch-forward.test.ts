import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { reviewedBatchBytes, reviewedBatchPrefix } from "./reviewed-batch-rail.ts";
import { describe, expect, it } from "vitest";
import { assertBatchedForward, assertReviewedPlatformForward, batchedFunctionDefinitions, readReviewedForwardRegistry, sqlSha256, sqlStatements, type BatchedForwardBinding } from "./reviewed-platform-forward.ts";

const registryBytes = readFileSync("config/reviewed-platform-forwards.json");
const registry = readReviewedForwardRegistry(registryBytes);
const pins = registry.batchedForwards!;
const bytes = (pin: BatchedForwardBinding) => readFileSync(`scripts/fixtures/reviewed-m10/${pin.path}`);
const rail = (pin: BatchedForwardBinding) => pin.path.startsWith("db/") ? "db/platform/migrations" : "supabase/migrations";
function prefix(pin: BatchedForwardBinding): Buffer[] {
  const folder = rail(pin);
  const railPins = pins.filter(prior => rail(prior) === folder);
  return [...reviewedBatchPrefix(process.cwd(), folder, railPins).map(path => readFileSync(path)),
    ...railPins.filter(prior => prior.path < pin.path).map(prior => reviewedBatchBytes(process.cwd(), process.cwd(), prior))];
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
  it.each(["changed byte", "another path", "missing signature", "duplicate signature", "extra signature", "before drift", "extra grant", "wider grantee", "private object", "unexpected statement"])("refuses %s", attack => {
    const changed = structuredClone(pin);
    let sql = bytes(pin).toString("utf8");
    if (attack === "changed byte") sql += " ";
    if (attack === "another path") changed.path = changed.path.replace("20261022", "20261023");
    if (attack === "missing signature") changed.functions.pop();
    if (attack === "duplicate signature") changed.functions.push(changed.functions[0]!);
    if (attack === "extra signature") changed.functions.push({ ...changed.functions[0]!, signature: "public.unpinned()" });
    if (attack === "before drift") changed.functions[0]!.beforeSha256 = "0".repeat(64);
    if (attack === "extra grant") sql += "\nGRANT SELECT ON public.subscriptions TO service_role;";
    if (attack === "wider grantee") sql += "\nGRANT EXECUTE ON FUNCTION public.unpinned() TO PUBLIC;";
    // The unpinned private-object plant is refused structurally by statement/signature counts.
    if (attack === "private object") sql += "\nCREATE FUNCTION private.unpinned() RETURNS text LANGUAGE sql AS $$ SELECT 'attack'; $$;";
    if (attack === "unexpected statement") sql += "\nCREATE SCHEMA unpinned;";
    // Statement plants repin the file, but leave the independent ordered pins.
    if (["extra grant", "wider grantee", "private object", "unexpected statement"].includes(attack)) changed.sha256 = sqlSha256(sql);
    expect(() => assertBatchedForward(changed, Buffer.from(sql), prefix(pin))).toThrow(/reviewed batch|reviewed portable creation/u);
  });
});

it.each(["order", "chain", "path", "private signature", "missing", "duplicate", "extra"])("refuses malformed registry %s", attack => {
  const changed = structuredClone(registry);
  const batch = changed.batchedForwards!;
  if (attack === "order") [batch[6], batch[9]] = [batch[9]!, batch[6]!];
  if (attack === "chain") batch[9]!.functions[0]!.beforeSha256 = "0".repeat(64);
  if (attack === "path") batch[0]!.path += ".sql";
  if (attack === "private signature") batch[10]!.functions[0]!.signature = "private.unpinned()";
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
  const pin = pins[6]!;
  const sql = bytes(pin).toString() + "\n" + statement;
  expect(() => assertBatchedForward(repin(pin, sql), Buffer.from(sql), prefix(pin))).toThrow(/reviewed batch|reviewed portable creation/u);
});

it("uses separate prior approval in CI and release, and refuses self-approval", () => {
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
    for (const pin of pins) put(pin.path, bytes(pin));
    const head = commit("Pinned feature bytes");
    for (const pin of pins) for (const release of [false, true]) expect(() => assertReviewedPlatformForward(folder, approval, head, pin.path, bytes(pin), release)).not.toThrow();
    const changed = structuredClone(registry); changed.batchedForwards![0]!.sha256 = "0".repeat(64);
    put("config/reviewed-platform-forwards.json", JSON.stringify(changed));
    const self = commit("Feature attempts to change its own approval");
    expect(() => assertReviewedPlatformForward(folder, approval, self, pins[0]!.path, bytes(pins[0]!))).toThrow(/approved separately/u);
  } finally { rmSync(folder, { recursive: true, force: true }); }
}, 120_000);

// Repin the changed statement so refusal reaches the grantee predicate.
it.each(["authenticated", "service_role, authenticated"])("refuses a repinned managed creation grantee: %s", grantee => {
  const pin = pins.find(item => item.path.endsWith("20261022185000_provider_refund_evidence.sql"))!;
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
      const originalPrefix = reviewedBatchPrefix(process.cwd(), directory, railPins);
      for (const path of originalPrefix) put(path, readFileSync(path));
      for (const pin of railPins.slice(0, landed === "all" ? undefined : landed)) put(pin.path, bytes(pin));
      // A later unpinned file must not enter the pre-pin replay either.
      put(`${directory}/99999999999999_unrelated.sql`, "SELECT 1;");
      const paths = reviewedBatchPrefix(root, directory, railPins);
      expect(paths).toEqual(originalPrefix);
      const preceding = paths.map(path => readFileSync(join(root, path)));
      for (const pin of railPins) {
        const source = reviewedBatchBytes(root, process.cwd(), pin);
        expect(source).toEqual(bytes(pin));
        assertBatchedForward(pin, source, preceding);
        preceding.push(source);
      }
      expect(preceding).toHaveLength(originalPrefix.length + railPins.length);
      const pin = railPins[0]!;
      put(pin.path, Buffer.concat([bytes(pin), Buffer.from(" ")]));
      expect(() => reviewedBatchBytes(root, process.cwd(), pin)).toThrow("landed bytes drifted");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
