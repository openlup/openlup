import type { PackageEditActor, PackageEditPreview, PackageEditReadPort } from "./packageEditContracts.js";
import { subscriptionRecord, type SubscriptionQueryExecutor } from "./postgresRenewalStore.js";

export async function readOwnedEditVersion(db: SubscriptionQueryExecutor, actor: PackageEditActor, id: string, lock: boolean): Promise<number> {
  const { rows } = await db.query(`SELECT id,template_version FROM public.subscriptions WHERE id=$1::uuid AND client_id=$2::uuid${lock ? " FOR UPDATE" : ""}`, [id, actor.clientId]);
  if (rows.length !== 1 || rows[0].id !== id.toLowerCase()) throw new Error("subscription_command_forbidden");
  return editVersion(rows[0].template_version);
}

export async function readEditEligibility(db: SubscriptionQueryExecutor, actor: PackageEditActor, id: string) {
  // Run after a separate acquired subscription lock so a waiter reads fresh facts.
  const { rows } = await db.query(`SELECT s.*,
    EXISTS(SELECT 1 FROM public.subscription_dunning_cases WHERE subscription_id=s.id AND status='open') AS payment_blocked,
    EXISTS(SELECT 1 FROM public.subscription_cycles c LEFT JOIN public.commerce_orders o ON o.subscription_cycle_id=c.id
      WHERE c.subscription_id=s.id AND c.scheduled_at=s.next_cycle_at
      AND (c.status IN ('payment_pending','paid') OR o.status IN ('paid','fulfillment_pending','fulfilled'))) AS cycle_locked,
    (CASE WHEN public.subscription_method_uses_recorded_refs(s.id) THEN public.subscription_method_chargeable_unattended(s.id,now())
      ELSE EXISTS(SELECT 1 FROM public.subscription_method_states ms WHERE ms.subscription_id=s.id AND ms.health_state='healthy') END) AS method_healthy
    FROM public.subscriptions s WHERE s.id=$1::uuid AND s.client_id=$2::uuid`, [id, actor.clientId]);
  if (rows.length !== 1 || rows[0].id !== id.toLowerCase()) throw new Error("subscription_command_forbidden");
  return rows[0];
}

function editVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error("subscription_edit_stale_template");
  return value;
}

export function assertEditVersion(expected: number | undefined, current: number): void {
  if (expected !== undefined && expected !== current) throw new Error("subscription_edit_stale_template");
}

function editWindow(row: Record<string, unknown>) {
  const next = row.next_cycle_at instanceof Date ? row.next_cycle_at.getTime() : typeof row.next_cycle_at === "string" ? Date.parse(row.next_cycle_at) : NaN;
  const cutoff = next - Number(row.edit_window_hours) * 3_600_000;
  return { next, cutoff };
}

export function editPreviewEligibility<Action extends string>(row: Record<string, unknown>, id: string, action: Action, now: string): PackageEditPreview<Action> {
  const { next, cutoff } = editWindow(row);
  const nextCycleAt = Number.isFinite(next) ? typeof row.next_cycle_at === "string" ? row.next_cycle_at : new Date(next).toISOString() : null;
  const editCutoffAt = Number.isFinite(cutoff) ? new Date(cutoff).toISOString() : null;
  const reason = row.payment_blocked === true ? "payment_blocked" : row.status !== "active" ? "not_active"
    : row.cycle_locked === true ? "cycle_locked" : row.method_healthy !== true ? "missing_payment_method"
      : !(Date.parse(now) < cutoff) ? "edit_window_closed" : null;
  const templateVersion = editVersion(row.template_version);
  return {
    preview: { subscriptionId: id, action, canApply: reason === null, blockedReason: reason, nextCycleAt, editCutoffAt, templateVersion },
    lockedCycle: { locked: reason === "cycle_locked" || reason === "payment_blocked",
      status: reason === "cycle_locked" ? "blocked_preflight" : reason === "payment_blocked" ? "dunning" : null },
    futureTemplate: { templateVersion, effectiveCycleAt: nextCycleAt, priceAgreementPolicy: "lock_until_edit" },
  };
}

export function assertFreshEditEligible(row: Record<string, unknown>, now: string): void {
  const { cutoff } = editWindow(row);
  if (row.status !== "active" || !(Date.parse(now) <= cutoff)) throw new Error("subscription_edit_window_closed");
  if (row.payment_blocked === true || row.method_healthy !== true) throw new Error("subscription_command_payment_blocked");
  if (row.cycle_locked === true) throw new Error("subscription_lifecycle_payment_blocked");
}

/** The same settings key, column and strict integer domain are used by the definer apply. */
export function createPostgresPackageEditReadPort(db: SubscriptionQueryExecutor): PackageEditReadPort {
  return {
    async readSubscription(id) {
      const row = (await db.query("SELECT cadence_days,composition_constraint,template_version FROM public.subscriptions WHERE id=$1::uuid", [id])).rows[0];
      if (!row) throw new Error("subscription_reprice_subscription_not_found");
      const version = Number(row.template_version);
      if (!Number.isInteger(version) || version < 1) throw new Error("subscription_reprice_invalid_template_version");
      return { cadenceDays: Number(row.cadence_days), templateVersion: version,
        compositionConstraint: row.composition_constraint == null ? null : subscriptionRecord(row.composition_constraint) };
    },
    async readLines(id) {
      const rows = (await db.query(`SELECT l.*,t.quantity*t.unit_amount_minor AS frozen_gross,t.quantity AS frozen_quantity,
        s.currency_code AS frozen_currency FROM public.subscription_lines l JOIN public.catalog_skus sku ON sku.id=l.variant_id
        LEFT JOIN LATERAL (SELECT t.* FROM public.subscription_renewal_term_lines t WHERE t.subscription_id=l.subscription_id AND t.sku=sku.sku
          AND t.quantity=l.quantity AND t.unit_amount_minor=l.unit_price_minor ORDER BY t.line_ordinal LIMIT 1) t ON true
        LEFT JOIN public.subscription_renewal_terms s ON s.subscription_id=l.subscription_id
        WHERE l.subscription_id=$1::uuid ORDER BY l.sort_order,l.variant_id`, [id])).rows;
      return rows.map(row => ({ lineId: String(row.id), variantId: String(row.variant_id), quantity: Number(row.quantity),
        sortOrder: Number(row.sort_order), isAddon: row.is_addon === true,
        ...(row.frozen_gross != null && Number.isSafeInteger(Number(row.frozen_gross)) && typeof row.frozen_currency === "string"
          ? { frozenLineSubtotalGross: { amountMinor: Number(row.frozen_gross), currency: row.frozen_currency } } : {}) }));
    },
    async readMinimumBaseUnits() {
      const raw = (await db.query("SELECT value_text FROM public.commerce_settings WHERE key='subscription_minimum_base_units'")).rows[0]?.value_text;
      if (typeof raw !== "string" || !/^[1-9][0-9]*$/u.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > 2_147_483_647) {
        throw new Error("subscription_reprice_minimum_base_units_unavailable");
      }
      return Number(raw);
    },
  };
}
