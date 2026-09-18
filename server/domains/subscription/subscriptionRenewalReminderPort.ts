// Ports for the renewal-upcoming reminder scan (a scheduled cron that emails
// customers a few days before their subscription renews). Pure types only.

export interface DueSoonSubscription {
  subscriptionId: string;
  clientId: string;
  // ISO next_cycle_at (the scheduled renewal); used for the date label + dedupe.
  nextCycleAt: string;
}

export interface RenewalReminderScanPort {
  // Active subscriptions whose next_cycle_at falls within [now+minDays, now+maxDays].
  scanDueSoon(
    minDays: number,
    maxDays: number,
    limit: number,
    signal: AbortSignal,
  ): Promise<DueSoonSubscription[]>;
}
