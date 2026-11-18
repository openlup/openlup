import type { CheckoutRecoveryReminderSchedule } from "./contracts/checkoutRecoveryReminders.js";

/** @experimental Discovery metadata for the installed schedule and the legacy absent-row behavior. */
const fallback = {
  revision: "default",
  abandonedCart: [{ stage: "first", afterHours: 1 }, { stage: "gentle", afterHours: 24 }, { stage: "last", afterHours: 72 }],
  checkoutRecovery: [{ stage: "first", afterHours: 1 }, { stage: "last", afterHours: 20 }],
} as const satisfies CheckoutRecoveryReminderSchedule;

export const checkoutRecoveryReminderSetting = {
  key: "checkout_recovery_reminders",
  domain: "commerce",
  kind: "installed",
  goal: "Find when checkout recovery and abandoned cart reminders are sent.",
  schemaVersion: 1,
  rules: [],
  examples: [],
  fallback,
  absentMeans: {
    description: "Checkout recovery wave offsets come from host call parameters. Abandoned cart waves use 1, 24 and 72 hours.",
    source: "host call parameters",
    value: { abandonedCart: fallback.abandonedCart, checkoutRecovery: null },
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
