import type { OutboxDispatchConfig } from "./contracts.js";
const CONFIG_BOUNDS = {
  batchSize: { env: "COMMERCE_OUTBOX_DISPATCH_BATCH_SIZE", def: 25, min: 1, max: 100 },
  maxAttempts: { env: "COMMERCE_OUTBOX_DISPATCH_MAX_ATTEMPTS", def: 8, min: 1, max: 20 },
  visibilitySeconds: {
    env: "COMMERCE_OUTBOX_DISPATCH_VISIBILITY_SECONDS",
    def: 300,
    min: 300,
    max: 3600,
  },
  backoffBaseSeconds: { env: "COMMERCE_OUTBOX_DISPATCH_BACKOFF_BASE_SECONDS", def: 60, min: 5, max: 3600 },
  backoffCapSeconds: { env: "COMMERCE_OUTBOX_DISPATCH_BACKOFF_CAP_SECONDS", def: 3600, min: 5, max: 86_400 },
  snoozeSeconds: { env: "COMMERCE_OUTBOX_DISPATCH_SNOOZE_SECONDS", def: 300, min: 60, max: 3600 },
  maxSnoozes: { env: "COMMERCE_OUTBOX_DISPATCH_MAX_SNOOZES", def: 48, min: 1, max: 1000 },
  // Max keeps a >= 15s tail under the cron's hard kill: drain stop + in-flight
  // handler + marks + queue stats + finishJobRun must all fit after the budget.
  softBudgetMs: {
    env: "COMMERCE_OUTBOX_DISPATCH_SOFT_BUDGET_MS",
    def: 40_000,
    min: 5000,
    max: 60 * 1000 - 15_000,
  },
} as const;

function readBoundedInt(
  env: Record<string, string | undefined>,
  bound: { env: string; def: number; min: number; max: number },
): number {
  const raw = env[bound.env];
  if (raw === undefined || raw.trim() === "") return bound.def;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    console.warn(`[outbox-dispatch] invalid ${bound.env}=${raw}; using default ${bound.def}`);
    return bound.def;
  }
  const clamped = Math.min(Math.max(parsed, bound.min), bound.max);
  if (clamped !== parsed) {
    console.warn(`[outbox-dispatch] ${bound.env}=${parsed} clamped to ${clamped}`);
  }
  return clamped;
}

export function readOutboxDispatchConfig(
  env: Record<string, string | undefined>,
  prefix = "COMMERCE_OUTBOX_DISPATCH_",
): OutboxDispatchConfig {
  const bounds = Object.fromEntries(Object.entries(CONFIG_BOUNDS).map(([key, bound]) => [key, { ...bound, env: prefix + bound.env.slice("COMMERCE_OUTBOX_DISPATCH_".length) }])) as typeof CONFIG_BOUNDS;
  const config: OutboxDispatchConfig = {
    batchSize: readBoundedInt(env, bounds.batchSize),
    maxAttempts: readBoundedInt(env, bounds.maxAttempts),
    visibilitySeconds: readBoundedInt(env, bounds.visibilitySeconds),
    backoffBaseSeconds: readBoundedInt(env, bounds.backoffBaseSeconds),
    backoffCapSeconds: readBoundedInt(env, bounds.backoffCapSeconds),
    snoozeSeconds: readBoundedInt(env, bounds.snoozeSeconds),
    maxSnoozes: readBoundedInt(env, bounds.maxSnoozes),
    softBudgetMs: readBoundedInt(env, bounds.softBudgetMs),
  };
  if (config.backoffCapSeconds < config.backoffBaseSeconds) {
    console.warn(
      `[outbox-dispatch] backoff cap ${config.backoffCapSeconds}s below base ${config.backoffBaseSeconds}s; raising cap to base`,
    );
    config.backoffCapSeconds = config.backoffBaseSeconds;
  }
  return config;
}

/** @beta Scheduled configuration is stricter than the bare immediate worker. */
export function validateScheduledConfig(config: OutboxDispatchConfig, hostLimitSeconds: number, timeouts: readonly number[]): void {
  const fail = (key: string, fix: string): never => { throw new Error(`@openlup/outbox: ${key}: ${fix}`); };
  if (!Number.isFinite(hostLimitSeconds) || hostLimitSeconds < 20 || hostLimitSeconds > 720) fail("hostLimitSeconds", "use 20–720 seconds");
  for (const [key, bound] of Object.entries(CONFIG_BOUNDS)) {
    const value = config[key as keyof OutboxDispatchConfig];
    const min = key === "visibilitySeconds" ? Math.min(5 * hostLimitSeconds, 3600) : bound.min;
    const max = key === "softBudgetMs" ? hostLimitSeconds * 1000 - 15000 : bound.max;
    if (!Number.isInteger(value) || value < min || value > max) fail(key, `use an integer in ${min}–${max}`);
  }
  if (config.backoffCapSeconds < config.backoffBaseSeconds) fail("backoffCapSeconds", "keep cap at least the base delay");
  for (const timeout of timeouts) if (!Number.isFinite(timeout) || timeout <= 0 || timeout + 2000 > config.softBudgetMs) fail("handler.timeoutMs", "fit the effective timeout plus 2000 ms mark margin in the budget");
}
