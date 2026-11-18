import { installedPolicy } from "./installedPolicy.js";
import type { CheckoutRecoveryWavePolicy } from "./checkoutRecoveryWaves.js";
import type { CheckoutRecoveryReminderSchedule } from "../contracts/index.js";

const key = "checkout_recovery_reminders";
const fallback = {
  revision: "default",
  abandonedCart: [{ stage: "first", afterHours: 1 }, { stage: "gentle", afterHours: 24 }, { stage: "last", afterHours: 72 }],
  checkoutRecovery: [{ stage: "first", afterHours: 1 }, { stage: "last", afterHours: 20 }],
} as const satisfies CheckoutRecoveryReminderSchedule;

// Match commerce_checkout_recovery_policy when a supplied policy omits an offset.
const firstOffsetSeconds = 3600;
const finalOffsetSeconds = 72000;

/** @experimental Describe the effective waves when no installed schedule exists. */
export function checkoutRecoveryReminderAbsence(policy?: Pick<CheckoutRecoveryWavePolicy, "firstOffsetSeconds" | "finalOffsetSeconds">) {
  return {
    abandonedCart: fallback.abandonedCart.map(wave => ({ ...wave })),
    checkoutRecovery: policy ? [
      { stage: "first", afterHours: (policy.firstOffsetSeconds ?? firstOffsetSeconds) / 3600 },
      { stage: "last", afterHours: (policy.finalOffsetSeconds ?? finalOffsetSeconds) / 3600 },
    ] : null,
  };
}

/** @experimental Discovery metadata for the installed schedule and absent-row behavior. */
export function describeCheckoutRecoveryReminderSetting() {
  return {
    key,
    domain: "commerce",
    kind: "installed",
    goal: "Find when checkout recovery and abandoned cart reminders are sent.",
    schemaVersion: 1,
    rules: [],
    examples: [],
    fallback: structuredClone(fallback),
    absentMeans: {
      description: "Checkout recovery waves use host call parameters, with SQL defaults for omitted offsets. Abandoned cart waves use 1, 24 and 72 hours.",
      source: "host call parameters, with SQL defaults for omitted offsets",
      value: checkoutRecoveryReminderAbsence(),
    },
    defaultBasis: { kind: "reference-code" },
    whyThisDefault: "The last checkout wave fits inside the 24-hour checkout window and the cart waves retain the established delivery timing.",
    effect: {
      appliesTo: "Scheduling new reminder waves.",
      frozenOn: ["Enqueued messages and send receipts retain their recorded identity."],
      impact: "customer-promise",
    },
    runtime: { level: "read-only", reason: "Runtime editing needs episode lineage and delivery replay evidence." },
    change: { operation: "installCheckoutRecoveryReminderSchedule" },
  } as const;
}

const code = "checkout_recovery_reminder_schedule_invalid";
function validateCheckoutRecoveryReminderSchedule(value: unknown): CheckoutRecoveryReminderSchedule {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  const schedule = value as Record<string, unknown>;
  if (Object.keys(schedule).sort().join(",") !== "abandonedCart,checkoutRecovery,revision"
    || typeof schedule.revision !== "string" || !schedule.revision.trim()) throw new Error(code);
  for (const key of ["abandonedCart", "checkoutRecovery"] as const) {
    const waves = schedule[key];
    if (!Array.isArray(waves) || !waves.length) throw new Error(code);
    let previous = 0;
    const seen = new Set<string>();
    for (const entry of waves) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)
        || Object.keys(entry).sort().join(",") !== "afterHours,stage"
        || !["first", "last", ...(key === "abandonedCart" ? ["gentle"] : [])].includes(entry.stage)
        || seen.has(entry.stage) || typeof entry.afterHours !== "number" || !Number.isInteger(entry.afterHours)
        || entry.afterHours <= previous || entry.afterHours > 2147483647) throw new Error(code);
      seen.add(entry.stage); previous = entry.afterHours;
    }
    if (waves.at(-1).stage !== "last") throw new Error(code);
  }
  return structuredClone(schedule) as unknown as CheckoutRecoveryReminderSchedule;
}
interface Executor {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
const store = (db: Executor) => installedPolicy(db, key, validateCheckoutRecoveryReminderSchedule, structuredClone(fallback), code);
/** Explicit installation on a host-owned write-capable connection. Reads never install. */
export async function installCheckoutRecoveryReminderSchedule(db: Executor, schedule: CheckoutRecoveryReminderSchedule): Promise<void> {
  await store(db).install(schedule);
}
/** Read the installed schedule or its nominal default. Requires settings SELECT. */
export async function readCheckoutRecoveryReminderSchedule(db: Executor): Promise<CheckoutRecoveryReminderSchedule> {
  return store(db).read();
}

/** @experimental Read the installed schedule when a policy row exists. */
export async function readCheckoutRecoveryReminderOverride(db: Executor): Promise<CheckoutRecoveryReminderSchedule | undefined> {
  return store(db).readOverride();
}
