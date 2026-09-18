import { createHash } from "node:crypto";
import { GOVERNED_FLAG_NAMES } from "../server/_lib/config/flagNames.ts";
import { carriesPrivateOperationalCoordinate } from "./oss-neutralization-projection.ts";

export type PublicConfigProjection = { path: string; contents: string; digest: string };
const digest = (contents: string) => `sha256-${createHash("sha256").update(contents).digest("hex")}`;
const object = (source: string, path: string): Record<string, unknown> => {
  let parsed: unknown;
  try { parsed = JSON.parse(source); } catch { throw new Error(`${path}: unreadable JSON`); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${path}: expected an object`);
  return parsed as Record<string, unknown>;
};
const json = (path: string, value: unknown): PublicConfigProjection => {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  if (carriesPrivateOperationalCoordinate(contents)) throw new Error(`${path}: public projection carries a private coordinate`);
  return { path, contents, digest: digest(contents) };
};

export function projectPublicLegacyMoneyExceptions(source: string): PublicConfigProjection {
  const path = "config/canonical-order-money-legacy-exceptions.json";
  const value = object(source, path);
  if (value.schemaVersion !== 1 || !Array.isArray(value.exceptions)) throw new Error(`${path}: expected schemaVersion 1 exceptions`);
  return json(path, { schemaVersion: 1, exceptions: [] });
}

export function projectPublicFeatureFlags(source: string): PublicConfigProjection {
  const path = "config/feature-flags.json";
  const value = object(source, path);
  if (value.schemaVersion !== 1 || !Array.isArray(value.flags)) throw new Error(`${path}: expected schemaVersion 1 flags`);
  const names = value.flags.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof (entry as { name?: unknown }).name !== "string") throw new Error(`${path}: flags[${index}] has no name`);
    return (entry as { name: string }).name;
  });
  if (new Set(names).size !== names.length) throw new Error(`${path}: source flag names must be unique`);
  const governed = [...GOVERNED_FLAG_NAMES].sort();
  const sourceNames = new Set(names);
  const missing = governed.filter((name) => !sourceNames.has(name));
  if (missing.length > 0) throw new Error(`${path}: governed flag(s) missing from source: ${missing.join(", ")}`);
  return json(path, { schemaVersion: 1, description: "Adopters own rollout metadata and defaults; these names remain the framework's typed flag contract.", flags: governed.map((name) => ({ name })) });
}

export function projectPublicPlatformRuntime(source: string): PublicConfigProjection {
  const path = "config/platform-runtime.json";
  const value = object(source, path);
  if (value.schemaVersion !== 1 || typeof value.functions !== "object" || !Array.isArray(value.crons) || typeof value.reserved !== "object") throw new Error(`${path}: expected functions, crons, and reserved namespaces`);
  return json(path, { schemaVersion: 1, description: "The bounded preview has no managed platform functions or cron registrations; adopters compose runtime adapters explicitly.", functions: {}, crons: [], reserved: { node: {}, scheduler: {}, blob: {} } });
}

export function projectPublicGitleaks(source: string): PublicConfigProjection {
  const path = "config/gitleaks.toml";
  if (!source.includes("useDefault = true") || !source.includes("idempotency[_-]?key")) throw new Error(`${path}: expected default rules and the generic idempotency-token adjudication`);
  const contents = `# Public secret-scanning policy.\n[extend]\nuseDefault = true\n\n[[allowlists]]\ndescription = "idempotency keys are caller-supplied de-duplication tokens, never credentials"\nregexTarget = "match"\nregexes = [\n  '''(?i)^(?:p_)?idempotency[_-]?key\\s*[:=]''',\n]\n`;
  return { path, contents, digest: digest(contents) };
}
