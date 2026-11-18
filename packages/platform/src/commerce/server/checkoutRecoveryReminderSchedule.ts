import { installedPolicy } from "./installedPolicy.js";
import type { CheckoutRecoveryReminderSchedule } from "../contracts/checkoutRecoveryReminders.js";

const code = "checkout_recovery_reminder_schedule_invalid";
function validate(value: unknown): CheckoutRecoveryReminderSchedule {
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
const fallback: CheckoutRecoveryReminderSchedule = { revision: "default",
  abandonedCart: [{ stage: "first", afterHours: 1 }, { stage: "gentle", afterHours: 24 }, { stage: "last", afterHours: 72 }],
  checkoutRecovery: [{ stage: "first", afterHours: 1 }, { stage: "last", afterHours: 20 }] };
interface Executor {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
const store = (db: Executor) => installedPolicy(db, "checkout_recovery_reminders", validate, structuredClone(fallback), code);
/** Explicit installation on a host-owned write-capable connection. Reads never install. */
export async function installCheckoutRecoveryReminderSchedule(db: Executor, schedule: CheckoutRecoveryReminderSchedule): Promise<void> {
  await store(db).install(schedule);
}
/** Absence retains historical waves; malformed installed data refuses. Requires settings SELECT. */
export async function readCheckoutRecoveryReminderSchedule(db: Executor): Promise<CheckoutRecoveryReminderSchedule> {
  return store(db).read();
}
