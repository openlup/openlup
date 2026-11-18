/** Installed native reminder stages are independent of elapsed hours. */
export interface CheckoutRecoveryReminderSchedule {
  revision: string;
  abandonedCart: readonly { stage: "first" | "gentle" | "last"; afterHours: number }[];
  checkoutRecovery: readonly { stage: "first" | "last"; afterHours: number }[];
}
