// Scheduler job registry.
//
// SINGLE SOURCE: the cron job list is DERIVED from the deployment's platform-runtime
// configuration `crons` (the single source from which an adopter may generate a provider
// manifest), never a hand-copied list. Both scheduler adapters (hosted cron and node-cron) read
// this same registry so the set of jobs, their schedules, and their endpoint paths can never drift
// between providers.
//
// Pure: reads the configuration file the caller names, or an already-parsed object. No infra
// imports, no I/O against the network.

import { readFileSync } from "node:fs";

/** A single scheduled job derived from the platform-runtime single source. */
export interface ScheduledJob {
  /** Stable job id used for advisory locking + job-run accounting (derived from the cron path). */
  jobId: string;
  /** Crontab expression (UTC), exactly as authored in the platform-runtime configuration. */
  schedule: string;
  /** The app endpoint a self-hosted scheduler invokes (Vercel cron hits this directly). */
  path: string;
}

export interface PlatformRuntimeConfig {
  crons?: Array<{ path: string; schedule: string }>;
}

/** Derive the canonical jobId from a cron path: `/api/cron/nightly-report` -> `nightly-report`. */
export function jobIdFromPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const last = trimmed.split("/").filter(Boolean).pop();
  if (!last) {
    throw new Error(`scheduler: cannot derive jobId from cron path "${path}"`);
  }
  return last;
}

/** Build the job registry from the deployment's platform-runtime configuration file. */
export function loadJobRegistry(configPath: string): ScheduledJob[] {
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
