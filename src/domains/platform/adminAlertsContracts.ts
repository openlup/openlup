import { z } from "../../lib/validation/zod.js";

/**
 * Admin-facing projection of the platform alert ledger.
 *
 * Only what an operator needs to read; the ledger itself stays service-role only
 * (platform_alerts REVOKEs ALL from `authenticated`), so this shape is served by
 * /api/bff/admin/platform/alerts rather than by PostgREST.
 */

export const adminAlertSeveritySchema = z.enum(["p0", "p1", "p2", "p3"]);

/**
 * Audience split, derived from `platform_alerts.owner`:
 *   commerce -> a business operator can act on it
 *   platform -> engineering owns it; shown for context so the health pill is explainable
 */
export const adminAlertLaneSchema = z.enum(["commerce", "platform"]);

export const adminAlertHealthSchema = z.enum(["ok", "degraded", "down", "unknown"]);

const isoDateTimeSchema = z.string().datetime({ offset: true });

export const adminAlertSchema = z
  .object({
    id: z.string().min(1).max(128),
    dedupeKey: z.string().min(1).max(256),
    lane: adminAlertLaneSchema,
    // Free text on purpose: platform_alerts.owner has no CHECK constraint, so an
    // enum here would throw the whole admin shell on the first new owner string.
    // The open-endedness is absorbed by `lane`.
    owner: z.string().trim().min(1).max(128),
    severity: adminAlertSeveritySchema,
    status: z.enum(["open", "acknowledged"]),
    // Server-decided so every consumer agrees; the client never re-derives it.
    pageable: z.boolean(),
    title: z.string().trim().min(1).max(512),
    message: z.string().trim().max(4096),
    supportCode: z.string().trim().max(128).nullable(),
    runbookUrl: z.string().trim().max(1024).nullable(),
    firstSeenAt: isoDateTimeSchema,
    lastSeenAt: isoDateTimeSchema,
    snoozedUntil: isoDateTimeSchema.nullable(),
  })
  .strict();

export const adminAlertsHeartbeatSchema = z
  .object({
    lastSuccessAt: isoDateTimeSchema.nullable(),
    staleAfterSeconds: z.number().int().positive(),
    stale: z.boolean(),
  })
  .strict();

export const adminAlertsSummarySchema = z
  .object({
    /** Drives the bell badge. */
    commercePageableCount: z.number().int().min(0),
    commerceTotalCount: z.number().int().min(0),
    platformPageableCount: z.number().int().min(0),
    /** Visible controlled exceptions; excluded from paging and health degradation. */
    snoozedCount: z.number().int().min(0),
    maxOpenSeverity: adminAlertSeveritySchema.nullable(),
  })
  .strict();

export const adminAlertsOverviewResponseSchema = z
  .object({
    health: adminAlertHealthSchema,
    summary: adminAlertsSummarySchema,
    heartbeat: adminAlertsHeartbeatSchema,
    alerts: z.array(adminAlertSchema).max(50),
    // Snoozed rows are returned separately from the active-list cap so a
    // controlled exception never disappears behind routine diagnostics.
    snoozedAlerts: z.array(adminAlertSchema).max(200),
    generatedAt: isoDateTimeSchema,
  })
  .strict();

export type AdminAlertSeverity = z.infer<typeof adminAlertSeveritySchema>;
export type AdminAlertLane = z.infer<typeof adminAlertLaneSchema>;
export type AdminAlertHealth = z.infer<typeof adminAlertHealthSchema>;
export type AdminAlert = z.infer<typeof adminAlertSchema>;
export type AdminAlertsHeartbeat = z.infer<typeof adminAlertsHeartbeatSchema>;
export type AdminAlertsSummary = z.infer<typeof adminAlertsSummarySchema>;
export type AdminAlertsOverviewResponse = z.infer<typeof adminAlertsOverviewResponseSchema>;
