import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** The managed forward that seeds the alignment singleton. */
export const MANAGED_ALIGNMENT_FORWARD = "supabase/migrations/20260927131453_seed_subscription_delivery_alignment_control.sql";

const PLATFORM_COMPANION = /^\s*--\s*migration:platform-companion:\s*(.*?)\s*$/;

/**
 * The SQL of a managed platform forward, named by its OpenLup repository path.
 * An adopter's hosted chain may carry that forward under its own migration name,
 * as a platform companion whose leading comment block holds
 * `-- migration:platform-companion: openlup:<path>`. When the file itself is
 * absent, exactly one such companion supplies the SQL, less its marker lines.
 */
export function readManagedForward(root, path) {
  const exact = join(root, path);
  if (existsSync(exact)) return readFileSync(exact, "utf8");
  const directory = join(root, "supabase", "migrations");
  const reference = `openlup:${path}`;
  const companions = (existsSync(directory) ? readdirSync(directory).sort() : [])
    .filter((name) => name.endsWith(".sql"))
    .map((name) => ({ name, lines: readFileSync(join(directory, name), "utf8").split("\n") }))
    .filter(({ lines }) => {
      const body = lines.findIndex((line) => line.trim() !== "" && !line.trimStart().startsWith("--"));
      return lines.slice(0, body < 0 ? lines.length : body).some((line) => PLATFORM_COMPANION.exec(line)?.[1] === reference);
    });
  if (companions.length === 1) return companions[0].lines.filter((line) => !PLATFORM_COMPANION.test(line)).join("\n");
  throw new Error(companions.length === 0
    ? `Managed forward ${path} is absent, and no supabase/migrations/*.sql header carries "-- migration:platform-companion: ${reference}"`
    : `Managed forward ${path} is absent, and more than one supabase/migrations file names it as its platform companion: ${companions.map(({ name }) => name).join(", ")}`);
}

// Compatibility seed for the owned disposable subscription reference.
// Matches the managed forward; after it runs, this is a no-op that preserves operator choices.
export const subscriptionAlignmentSeedSql = `
INSERT INTO public.subscription_delivery_alignment_control (singleton, mode)
VALUES (true, 'auto_align')
ON CONFLICT (singleton) DO NOTHING;
`;

export function assertSubscriptionAlignmentControl(rows) {
  if (!Array.isArray(rows)) throw new Error("Subscription alignment control readback is invalid");
  if (rows.length === 0) {
    throw new Error("Subscription alignment singleton row is missing; rerun the owned reference setup");
  }
  if (rows.length !== 1 || rows[0]?.singleton !== true) {
    throw new Error("Subscription alignment singleton readback is invalid");
  }
  if (rows[0].mode !== "auto_align") {
    throw new Error("Subscription reference requires alignment mode auto_align; setup preserves existing mode choices");
  }
}

export async function verifySubscriptionAlignmentControl({ origin, serviceRoleKey }, fetchImpl = fetch) {
  const url = new URL(origin);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || !url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Subscription alignment readback requires a bare loopback HTTP origin");
  }
  if (typeof serviceRoleKey !== "string" || !serviceRoleKey.trim()) {
    throw new Error("Owned subscription alignment readback credential is unavailable");
  }
  let rows;
  try {
    const response = await fetchImpl(`${url.origin}/rest/v1/subscription_delivery_alignment_control?singleton=eq.true&select=singleton,mode`, {
      method: "GET", headers: { apikey: serviceRoleKey, authorization: `Bearer ${serviceRoleKey}` },
      redirect: "error", signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error("Readback refused");
    rows = await response.json();
  } catch {
    throw new Error("Subscription alignment control readback is unavailable");
  }
  assertSubscriptionAlignmentControl(rows);
}
