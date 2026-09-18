import type { Customer360ContactHealth } from "./customer360Contracts.js";

/**
 * Delivery outcomes that actually settle the question "did this address accept
 * the message?". Everything else is either still in flight (`queued`, `sent`,
 * `processing`, `delivery_delayed`) or means no message was ever owed
 * (`skipped`, `blocked`) — neither is evidence about the address, so neither
 * belongs here.
 */
export const CONTACT_HEALTH_TERMINAL_STATUSES = [
  "delivered", "bounced", "complained", "failed",
] as const;

export type ContactHealthTerminalStatus = typeof CONTACT_HEALTH_TERMINAL_STATUSES[number];

export interface ContactHealthDelivery {
  /** Raw delivery status; anything not terminal is ignored. */
  readonly status: string;
  /** When the outcome settled. Rows without a time cannot be ordered and are ignored. */
  readonly occurredAt: string | null;
  /**
   * Whether a bounce was a permanent rejection. `false` marks a temporary
   * failure that must not extinguish reachability; `null` means the evidence
   * does not say, which is treated as permanent because the recorded status is
   * already a terminal failure and an operator is better served by a badge they
   * can dismiss than by silence. Ignored for non-bounce statuses.
   */
  readonly permanentBounce: boolean | null;
}

function isTerminal(status: string): status is ContactHealthTerminalStatus {
  return (CONTACT_HEALTH_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * Reduce a subject's delivery evidence to the single newest terminal outcome.
 *
 * With no terminal evidence at all the subject is reported reachable: never
 * having failed is not the same as having failed, and an unproven address must
 * not raise an alarm.
 */
export function deriveContactHealth(
  deliveries: readonly ContactHealthDelivery[],
): Customer360ContactHealth {
  const newest = deliveries
    .filter((delivery): delivery is ContactHealthDelivery & { occurredAt: string } => (
      isTerminal(delivery.status) && typeof delivery.occurredAt === "string"
    ))
    .reduce<(ContactHealthDelivery & { occurredAt: string }) | null>(
      (best, delivery) => (best === null || delivery.occurredAt > best.occurredAt ? delivery : best),
      null,
    );

  if (!newest) return { lastTerminalStatus: null, lastTerminalAt: null, reachable: true };

  const status = newest.status as ContactHealthTerminalStatus;
  const reachable = status === "delivered"
    || (status === "bounced" && newest.permanentBounce === false);

  return { lastTerminalStatus: status, lastTerminalAt: newest.occurredAt, reachable };
}
