import { readFileSync } from "node:fs";

export const STAGING_SUPABASE_REF = "abcdefghijklmnopqrst";
export const PRODUCTION_SUPABASE_REF = "tsrqponmlkjihgfedcba";
export const SYNTHETIC_STOCK_CONFIRM = "synthetic-omnipack-stock";
export const RESTORE_STOCK_CONFIRM = "restore-omnipack-stock";
export const SYNTHETIC_STOCK_SEED_EMERGENCY_ENV = "OMNIPACK_SYNTHETIC_STOCK_SEED_EMERGENCY";
export const SYNTHETIC_STOCK_TTL_HOURS = 48;
// OmniPack is the sole stock oracle and only fulfilment provider, so offered stock
// for provider SKUs must equal `oracle for_sale − our active reservations` with NO
// extra local buffer. A non-zero safety_stock here is subtracted from sellable
// (the `commerce/offerAvailability` adapter + the reserve gate) and silently hides any SKU
// whose oracle stock is at or below the buffer (e.g. PORK for_sale=1). "Low stock"
// display is a SEPARATE, threshold-driven concern (`lowStockThreshold`/low_stock
// badge), not a stock-reducing buffer. Keep this 0 so the synthetic staging overlay
// mirrors real provider truth; a test pins it at 0 to prevent regression.
export const SYNTHETIC_STOCK_SAFETY_STOCK = 0;

export type EnvLike = Record<string, string | undefined>;
export type SyntheticStockBand = "abundant" | "high" | "medium" | "low" | "critical-low" | "zero";

export interface SyntheticStockMatrixEntry {
  sku: string;
  targetQuantity: number;
  band: SyntheticStockBand;
}

export type SyntheticStockMatrix = readonly SyntheticStockMatrixEntry[];

export interface SyntheticStockArgs {
  execute: boolean;
  mode: "seed" | "restore";
  confirm: string | null;
  allowLocal: boolean;
  envFile: string | null;
  runId: string | null;
}

export interface SyntheticStockConfig {
  supabaseUrl: string;
  serviceRoleKey: string;
  marker: string | null;
  allowLocal: boolean;
}

export interface SyntheticStockPlanEntry extends SyntheticStockMatrixEntry {
  idempotencyKey: string;
  providerTotalQuantity: number;
  providerForSaleQuantity: number;
  providerReservedUnavailableQuantity: number;
  lastSyncedAt: string;
  staleAfter: string;
  syncRunId: string;
  evidence: Record<string, unknown>;
}

export const SYNTHETIC_OMNIPACK_STOCK_MATRIX: SyntheticStockMatrix = [
  { sku: "CORE-STOCK-ALPHA", targetQuantity: 5000, band: "abundant" },
  { sku: "CORE-STOCK-BETA", targetQuantity: 2500, band: "high" },
  { sku: "CORE-STOCK-GAMMA", targetQuantity: 750, band: "medium" },
  { sku: "CORE-STOCK-DELTA", targetQuantity: 180, band: "low" },
  { sku: "CORE-STOCK-EPSILON", targetQuantity: 40, band: "critical-low" },
  { sku: "CORE-STOCK-ZERO", targetQuantity: 0, band: "zero" },
];

export function parseSyntheticStockArgs(argv: readonly string[]): SyntheticStockArgs {
  const args: SyntheticStockArgs = {
    execute: false,
    mode: "seed",
    confirm: null,
    allowLocal: false,
    envFile: null,
    runId: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--execute") {
      args.execute = true;
    } else if (token === "--restore-real-provider-stock") {
      args.mode = "restore";
    } else if (token === "--allow-local") {
      args.allowLocal = true;
    } else if (token === "--confirm") {
      args.confirm = argv[index + 1] ?? null;
      index += 1;
    } else if (token === "--env-file") {
      args.envFile = argv[index + 1] ?? null;
      index += 1;
    } else if (token === "--run-id") {
      args.runId = argv[index + 1] ?? null;
      index += 1;
    } else if (token === "--dry-run") {
      args.execute = false;
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }

  return args;
}

export function readSyntheticStockConfig(env: EnvLike, args: SyntheticStockArgs): SyntheticStockConfig {
  const fileEnv = args.envFile ? parseEnvFile(args.envFile) : {};
  const effectiveEnv = { ...fileEnv, ...env };
  const supabaseUrl = (effectiveEnv.SUPABASE_URL ?? effectiveEnv.HIDDEN_PREVIEW_SUPABASE_URL ?? "").trim();
  const serviceRoleKey = (effectiveEnv.SUPABASE_SERVICE_ROLE_KEY ?? effectiveEnv.HIDDEN_PREVIEW_SERVICE_ROLE_KEY ?? "").trim();
  const marker = (effectiveEnv.HIDDEN_SANDBOX_SUPABASE_PROJECT_REF ?? effectiveEnv.STAGING_SUPABASE_PROJECT_REF ?? "").trim() || null;

  if (!supabaseUrl) throw new Error("SUPABASE_URL or HIDDEN_PREVIEW_SUPABASE_URL is required");
  if (!serviceRoleKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY or HIDDEN_PREVIEW_SERVICE_ROLE_KEY is required");

  const config = { supabaseUrl, serviceRoleKey, marker, allowLocal: args.allowLocal };
  assertSyntheticStockTarget(config);
  return config;
}

export function assertSyntheticStockTarget(config: Pick<SyntheticStockConfig, "supabaseUrl" | "marker" | "allowLocal">): void {
  const values = [config.supabaseUrl, config.marker].filter(Boolean).map(String);
  if (values.some((value) => value.includes(PRODUCTION_SUPABASE_REF))) {
    throw new Error("Refusing synthetic OmniPack stock against production Supabase");
  }
  if (config.allowLocal && isLocalSupabaseUrl(config.supabaseUrl)) return;
  if (!config.supabaseUrl.includes(STAGING_SUPABASE_REF)) {
    throw new Error(`SUPABASE_URL must point at staging project ${STAGING_SUPABASE_REF}`);
  }
  if (config.marker && config.marker !== STAGING_SUPABASE_REF) {
    throw new Error(`HIDDEN_SANDBOX_SUPABASE_PROJECT_REF/STAGING_SUPABASE_PROJECT_REF must be ${STAGING_SUPABASE_REF}`);
  }
}

export function buildSyntheticStockPlan(
  now: Date,
  runId = defaultSyntheticStockRunId(now),
  matrix: SyntheticStockMatrix = SYNTHETIC_OMNIPACK_STOCK_MATRIX,
): SyntheticStockPlanEntry[] {
  assertSyntheticStockMatrix(matrix);
  const lastSyncedAt = now.toISOString();
  const staleAfter = new Date(now.getTime() + SYNTHETIC_STOCK_TTL_HOURS * 60 * 60 * 1000).toISOString();
  const syncRunId = `synthetic-omnipack-stage-stock:${runId}`;
  return matrix.map((entry) => ({
    ...entry,
    idempotencyKey: `${syncRunId}:${entry.sku}`,
    providerTotalQuantity: entry.targetQuantity,
    providerForSaleQuantity: entry.targetQuantity,
    providerReservedUnavailableQuantity: 0,
    lastSyncedAt,
    staleAfter,
    syncRunId,
    evidence: {
      source: "synthetic_staging_seed",
      reason: "omnipack_stage_returns_zero_stock",
      quantityPolicy: "fixed_target_not_incremental",
      band: entry.band,
      runId,
      expiresAt: staleAfter,
      safetyStock: SYNTHETIC_STOCK_SAFETY_STOCK,
      warning: "Synthetic staging overlay only; not stock-sync readiness evidence.",
    },
  }));
}

export function assertSyntheticStockMatrix(matrix: SyntheticStockMatrix): void {
  if (matrix.length === 0) throw new Error("Synthetic stock matrix must contain at least one SKU");
  const seen = new Set<string>();
  for (const entry of matrix) {
    if (!entry.sku.trim()) throw new Error("Synthetic stock matrix entries require sku");
    if (!Number.isInteger(entry.targetQuantity) || entry.targetQuantity < 0) {
      throw new Error(`Synthetic stock target quantity must be a non-negative integer for ${entry.sku}`);
    }
    if (seen.has(entry.sku)) throw new Error(`Synthetic stock matrix contains duplicate SKU ${entry.sku}`);
    seen.add(entry.sku);
  }
}

export function publicSyntheticStockPlanEntry(entry: SyntheticStockPlanEntry): Record<string, unknown> {
  return {
    sku: entry.sku,
    targetQuantity: entry.targetQuantity,
    band: entry.band,
    providerForSaleQuantity: entry.providerForSaleQuantity,
    safetyStock: SYNTHETIC_STOCK_SAFETY_STOCK,
    staleAfter: entry.staleAfter,
    syncRunId: entry.syncRunId,
    evidence: entry.evidence,
  };
}

export function defaultSyntheticStockRunId(now: Date): string {
  return now.toISOString().replace(/[-:.]/g, "").slice(0, 15);
}

export function getSyntheticStockHelp(): string {
  return `Usage:
  node --experimental-strip-types scripts/omnipack-synthetic-stock-seed.ts [--dry-run]
  ${SYNTHETIC_STOCK_SEED_EMERGENCY_ENV}=true node --experimental-strip-types scripts/omnipack-synthetic-stock-seed.ts --execute --confirm ${SYNTHETIC_STOCK_CONFIRM}
  node --experimental-strip-types scripts/omnipack-synthetic-stock-seed.ts --restore-real-provider-stock --execute --confirm ${RESTORE_STOCK_CONFIRM}

Options:
  --env-file <path>   Load env values before process env overrides.
  --allow-local       Allow local Supabase URL for local dry/debug work.
  --run-id <id>       Override generated run id for deterministic tests.

Seed execute is deprecated and emergency-only. Prefer the real omnipack-stock-sync
cron; restore remains available to expire historical synthetic rows.
`;
}

function parseEnvFile(path: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const idx = trimmed.indexOf("=");
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

function isLocalSupabaseUrl(raw: string): boolean {
  try {
    const hostname = new URL(raw).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}
