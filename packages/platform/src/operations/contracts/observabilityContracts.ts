export type AlertSeverity = "p0" | "p1" | "p2" | "p3";
/** Opaque host-owned transport key; this module declares no vendor capability. */
export type AlertChannel = string;
export type WatchdogSnapshot = { checkedAt: string };

export type AlertDecision<Channel extends string = AlertChannel> = {
  dedupeKey: string;
  severity: AlertSeverity;
  owner: string;
  runbookUrl: string;
  title: string;
  message: string; humanContext?: import("./alertHumanContext.js").AlertHumanContext;
  channels: Channel[];
  payload: Record<string, unknown>; paging?: "default" | "never";
};

export type OpenAlert = {
  id: string;
  dedupeKey: string;
  status: "open" | "acknowledged";
  severity: AlertSeverity;
  lastNotifiedAt: string | null;
  /** Most recent watchdog delivery decision, including skipped/failed attempts. */
  lastNotificationAttemptAt?: string | null;
  lastNotificationStatus?: AlertNotificationOutcome["status"] | null;
  /** Earliest time the watchdog may create another delivery-attempt ledger row. */
  nextNotificationAttemptAt?: string | null;
  /** Consecutive failed notification attempts; reset by sent/skipped outcomes. */
  notificationFailureCount?: number;
  /** Operator silence window; when set and in the future, paging is suppressed. */
  snoozedUntil?: string | null;
};

export type AlertNotificationOutcome<Channel extends string = AlertChannel> = {
  channel: Channel;
  status: "sent" | "failed" | "skipped";
  provider?: string | null;
  providerResponse?: Record<string, unknown> | null;
  error?: string | null;
};
