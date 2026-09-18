import { emailNotificationControlKeys } from "./emailNotificationControlKeys.js";

/**
 * Single source for per-slug email delivery gating.
 *
 * Holds the one fail-open `comms_notification_controls` lookup loop that was
 * previously duplicated byte-for-byte across the infra email control port and
 * the subscription notification-control port. Fail-open: a missing row OR a read
 * error OR a thrown query → allow (we never silently drop an email because the
 * control lookup hiccuped); disabling is an explicit operator action
 * (enabled=false). Behaviour is identical to the loops it replaces.
 *
 * Lives in server/shared (not server/infra) so the subscription domain can
 * delegate to it without crossing the domain→infra boundary guardrail.
 *
 * `customerId`, `now` and `signal` are accepted but currently inert — they exist
 * so callers (incl. the legacy `isEnabled(slug, signal)` shape) can pass through
 * without shape churn and so future per-recipient/quiet-hours shaping has a seam.
 */

export interface DeliveryShapingSupabaseClient {
  from(table: string): DeliveryShapingQueryBuilder;
}

interface DeliveryShapingQueryBuilder {
  select(columns: string): DeliveryShapingQueryBuilder;
  eq(column: string, value: unknown): DeliveryShapingQueryBuilder;
  maybeSingle(): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
}

export interface DeliveryShapingRequest {
  slug: string;
  customerId?: string;
  now?: Date;
  signal?: AbortSignal;
}

export interface DeliveryShapingDecision {
  allow: boolean;
}

export interface DeliveryShapingPolicy {
  shouldDeliver(request: DeliveryShapingRequest): Promise<DeliveryShapingDecision>;
}

export function createSupabaseDeliveryShapingPolicy(
  client: DeliveryShapingSupabaseClient,
): DeliveryShapingPolicy {
  return {
    async shouldDeliver({ slug }: DeliveryShapingRequest): Promise<DeliveryShapingDecision> {
      for (const key of emailNotificationControlKeys(slug)) {
        try {
          const result = await client.from("comms_notification_controls").select("enabled").eq("slug", key).maybeSingle();
          if (result.error) return { allow: true };
          const row = result.data as { enabled?: boolean | null } | null;
          if (row?.enabled === false) return { allow: false };
        } catch {
          return { allow: true };
        }
      }
      return { allow: true };
    },
  };
}
