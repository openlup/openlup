import { z } from "zod";
import { installedPolicy } from "./installedPolicy.js";
import type { CheckoutRecoveryWavePolicy } from "./checkoutRecoveryWaves.js";
import type { CheckoutRecoveryReminderSchedule } from "../contracts/index.js";

const key = "checkout_recovery_reminders";
const blockedSchedule = "checkout_recovery_schedule_change_blocked_open_episodes";

/** Open orders with unpinned waves block the schedule change. */
export class CheckoutRecoveryScheduleChangeBlockedError extends Error {
  constructor(readonly blockingOrders: string, cause: unknown) {
    super(blockedSchedule, { cause });
    this.name = "CheckoutRecoveryScheduleChangeBlockedError";
  }
}

const fallback = {
  revision: "default",
  abandonedCart: [{ stage: "first", afterHours: 1 }, { stage: "gentle", afterHours: 24 }, { stage: "last", afterHours: 72 }],
  checkoutRecovery: [{ stage: "first", afterHours: 1 }, { stage: "last", afterHours: 20 }],
} as const satisfies CheckoutRecoveryReminderSchedule;

// Match the JSON accepted by commerce_checkout_recovery_policy, including its defaults.
const seconds = z.int().min(1).max(2147483647);
const wavePolicy = z.strictObject({
  firstOffsetSeconds: seconds.default(3600),
  finalOffsetSeconds: seconds.default(72000),
  checkoutSeconds: seconds.default(86400),
  recoverySeconds: seconds.default(2592000),
  activitySeconds: seconds.default(900),
  profile: z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/u).default("capture"),
}).refine(policy => policy.firstOffsetSeconds < policy.finalOffsetSeconds && policy.finalOffsetSeconds < policy.checkoutSeconds);

function effectiveWavePolicy(policy: Partial<CheckoutRecoveryWavePolicy>) {
  try {
    // The native adapter sends JSON, so omitted properties stay omitted and explicit nulls refuse.
    const parsed = wavePolicy.safeParse(JSON.parse(JSON.stringify(policy)));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function checkoutRecoveryReminderAbsence(policy?: z.output<typeof wavePolicy>) {
  return {
    abandonedCart: fallback.abandonedCart.map(wave => ({ ...wave })),
    checkoutRecovery: policy ? [
      { stage: "first", afterHours: policy.firstOffsetSeconds / 3600 },
      { stage: "last", afterHours: policy.finalOffsetSeconds / 3600 },
    ] : null,
  };
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
  const values = [key, JSON.stringify(validateCheckoutRecoveryReminderSchedule(schedule))];
  try { await db.query("SELECT public.commerce_install_checkout_recovery_reminder_schedule($1::text, $2::jsonb)", values); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "55000"
      && "detail" in error && typeof error.detail === "string") {
      const match = /^openlup:reminder_schedule:blocking_orders=([1-9][0-9]{0,18})$/u.exec(error.detail);
      const count = match?.[1];
      if (match?.[0] === error.detail && count && BigInt(count) <= 9223372036854775807n) {
        throw new CheckoutRecoveryScheduleChangeBlockedError(count, error);
      }
    }
    throw error;
  }
}
/** Read the installed schedule or its nominal default. Requires settings SELECT. */
export async function readCheckoutRecoveryReminderSchedule(db: Executor): Promise<CheckoutRecoveryReminderSchedule> {
  return store(db).read();
}

/** @experimental Observe an installed override or the effective waves for an absent row. */
export async function readCheckoutRecoveryReminderObservation(
  db: Executor,
  policy?: Partial<CheckoutRecoveryWavePolicy>,
) {
  const effective = policy === undefined ? undefined : effectiveWavePolicy(policy);
  if (policy !== undefined && !effective) return { refusal: "checkout_recovery_policy_invalid" } as const;
  const schedule = await store(db).readOverride();
  if (schedule) return {
    present: true as const,
    revision: schedule.revision,
    value: { ...schedule, abandonedCart: [...schedule.abandonedCart], checkoutRecovery: [...schedule.checkoutRecovery] },
  };
  return { present: false as const, effective: checkoutRecoveryReminderAbsence(effective) };
}
