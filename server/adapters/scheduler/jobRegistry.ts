// Scheduler job registry (Platform Portability, W4).
//
// SINGLE SOURCE: the cron job list is DERIVED from config/platform-runtime.json `crons`
// (the single source from which an adopter may generate a provider manifest) — never a hand-copied list.
// Both scheduler adapters (Vercel cron + node-cron) read this same registry so the set of jobs,
// their schedules, and their endpoint paths can never drift between providers.
//
// Pure: reads the committed JSON file via readFileSync at build time (mirrors
// a provider-manifest generator). No infra imports, no I/O against the network.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** A single scheduled job derived from the platform-runtime single source. */
export interface ScheduledJob {
  /** Stable job id used for advisory locking + job-run accounting (derived from the cron path). */
  jobId: string;
  /** Crontab expression (UTC), exactly as authored in config/platform-runtime.json. */
  schedule: string;
  /** The app endpoint a self-hosted scheduler invokes (Vercel cron hits this directly). */
  path: string;
}

interface PlatformRuntimeConfig {
  crons?: Array<{ path: string; schedule: string }>;
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
// server/adapters/scheduler/ -> repo root is three levels up.
const DEFAULT_CONFIG_PATH = join(MODULE_DIR, "..", "..", "..", "config", "platform-runtime.json");

/** Derive the canonical jobId from a cron path: `/api/cron/dhl-tracking` -> `dhl-tracking`. */
export function jobIdFromPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const last = trimmed.split("/").filter(Boolean).pop();
  if (!last) {
    throw new Error(`scheduler: cannot derive jobId from cron path "${path}"`);
  }
  return last;
}

/**
 * Build the job registry from the platform-runtime single source.
 * Accepts an explicit config path (tests) or defaults to the committed file.
 */
export function loadJobRegistry(configPath: string = DEFAULT_CONFIG_PATH): ScheduledJob[] {
  const raw = readFileSync(configPath, "utf8");
  const config = JSON.parse(raw) as PlatformRuntimeConfig;
  const crons = config.crons ?? [];
  return crons.map((cron) => ({
    jobId: jobIdFromPath(cron.path),
    schedule: cron.schedule,
    path: cron.path,
  }));
}

/** Same registry but built from an already-parsed config object (pure; no filesystem). */
export function jobRegistryFromConfig(config: PlatformRuntimeConfig): ScheduledJob[] {
  return (config.crons ?? []).map((cron) => ({
    jobId: jobIdFromPath(cron.path),
    schedule: cron.schedule,
    path: cron.path,
  }));
}
