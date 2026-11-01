import { createHash } from "node:crypto";
import { z } from "zod";
import type { RenewalCycleCorrelation, RenewalFrozenSnapshot, RenewalLine, RenewalReadback, RenewalSchedule } from "./contracts/renewal.js";
import { subscriptionRecord, type NativeRenewalCodec } from "./postgresRenewalStore.js";

const REVISION = "native.purchase-renewal.v1";
const CONTRACT = "platform.subscription.renewal.v1";
const ref = z.string().min(1);
const whole = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const line = z.object({ lineOrdinal: whole.positive(), sku: ref, quantity: whole.positive(), unitAmountMinor: whole }).strict();
const basket = z.array(line).min(1).max(100);
const snapshotSchema = z.object({
  contractVersion: z.literal(CONTRACT), frozenRevision: z.literal(REVISION), frozenFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  subscriptionId: z.uuid(), clientId: z.uuid(), scheduledAt: z.iso.datetime(), scheduledInstant: whole,
  cycle: z.object({ status: z.literal("correlated"), logicalCycleNumber: whole.positive(), nativeRenewalCounter: whole.positive(),
    activationCycleId: z.uuid(), evidenceRef: ref }).strict(), retryAttempt: z.literal(0), externalAttemptSequence: z.literal(0),
  templateSnapshot: z.object({ templateId: ref, version: whole.positive(), cadenceDays: whole.positive(), lines: basket }).strict(),
  pricingSnapshot: z.object({ currency: z.string().regex(/^[A-Z]{3}$/), totalAmountMinor: whole.positive(), shippingAmountMinor: z.literal(0),
    agreementPolicy: z.literal("lock_until_edit"), proration: z.literal("none") }).strict(),
  orderSnapshot: z.object({ shippingAddressRef: ref.nullable(), shippingQuoteRef: ref.nullable(), acquisitionRef: ref.nullable(), lines: basket }).strict(),
  stockSourceKey: ref, settlementChannelKey: z.literal("sandbox"), authorizationRef: ref, payerAccountRef: ref.nullable(),
  unattendedChargeAuthorizedAt: z.iso.datetime(),
}).strict();
function validate(snapshot: RenewalFrozenSnapshot) {
  snapshotSchema.parse(snapshot);
  const items = nativeRenewalCanonicalJson(snapshot.orderSnapshot.lines);
  if (items !== nativeRenewalCanonicalJson(snapshot.templateSnapshot.lines)
    || snapshot.orderSnapshot.lines.reduce((sum, item) => sum + item.quantity * item.unitAmountMinor, 0) !== snapshot.pricingSnapshot.totalAmountMinor
    || snapshot.scheduledInstant !== Date.parse(snapshot.scheduledAt)) throw new Error("subscription_renewal_snapshot_inconsistent");
}
/** Sorted object keys, array order preserved, JSON primitives; UTF-8 SHA-256.
 * This dialect is versioned because the SQL replay compares the entire wire. */
function nativeRenewalCanonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(nativeRenewalCanonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => {
    if (key.startsWith("_host")) throw new Error("subscription_renewal_host_metadata_refused");
    return `${JSON.stringify(key)}:${nativeRenewalCanonicalJson((value as Record<string, unknown>)[key])}`;
  }).join(",")}}`;
  throw new Error("subscription_renewal_snapshot_value_invalid");
}
function text(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || !value) throw new Error(`subscription_renewal_snapshot_${key}_invalid`);
  return value;
}
function integer(value: unknown, min = 0): number {
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < min) throw new Error("subscription_renewal_snapshot_integer_invalid");
  return number;
}
function instant(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error("subscription_renewal_snapshot_time_invalid");
  return date.toISOString();
}
function nullable(value: unknown): string | null { return value == null ? null : String(value); }
function lines(value: unknown): RenewalLine[] {
  if (!Array.isArray(value) || !value.length) throw new Error("subscription_renewal_snapshot_lines_invalid");
  return value.map(item => {
    const row = subscriptionRecord(item);
    return { lineOrdinal: integer(row.lineOrdinal, 1), sku: text(row, "sku"), quantity: integer(row.quantity, 1), unitAmountMinor: integer(row.unitAmountMinor) };
  });
}
function correlation(row: Record<string, unknown>): RenewalCycleCorrelation {
  const counter = integer(row.next_cycle_number ?? row.cycle_number, 1);
  const activation = nullable(row.activation_cycle_id);
  const paid = integer(row.paid_cycle_count);
  // Only the fully witnessed purchase lineage is correlated. Imported/partial
  // histories remain ambiguous; native counters alone do not prove numbering.
  if (!activation || row.activation_cycle_paid !== true || paid !== counter) return {
    status: "ambiguous", logicalCycleNumber: null, nativeRenewalCounter: counter,
    activationCycleId: activation, reason: "native_purchase_cycle_history_incomplete",
  };
  return { status: "correlated", logicalCycleNumber: paid + 1, nativeRenewalCounter: counter,
    activationCycleId: activation, evidenceRef: `native-activation:${activation}:paid:${paid}` };
}
function body(s: RenewalFrozenSnapshot): Record<string, unknown> {
  return { contractVersion: CONTRACT, frozenRevision: s.frozenRevision,
    subscriptionId: s.subscriptionId, clientId: s.clientId, scheduledAt: s.scheduledAt,
    cycleNumber: s.cycle.nativeRenewalCounter, cycle: s.cycle, retryAttempt: s.retryAttempt,
    externalAttemptSequence: s.externalAttemptSequence, templateSnapshot: s.templateSnapshot,
    pricingSnapshot: s.pricingSnapshot, orderSnapshot: s.orderSnapshot,
    lines: s.orderSnapshot.lines, currency: s.pricingSnapshot.currency, totalAmountMinor: s.pricingSnapshot.totalAmountMinor,
    stockSourceKey: s.stockSourceKey, settlementChannelKey: s.settlementChannelKey,
    authorizationRef: s.authorizationRef, payerAccountRef: s.payerAccountRef,
    unattendedChargeAuthorizedAt: s.unattendedChargeAuthorizedAt };
}
function fingerprint(s: RenewalFrozenSnapshot): string {
  return createHash("sha256").update(nativeRenewalCanonicalJson(body(s)), "utf8").digest("hex");
}
/** Production native dialect: no closure state and no host metadata on readback. */
export function createNativeRenewalCodec(): NativeRenewalCodec {
  const codec: NativeRenewalCodec = {
    due(row) {
      const scheduledAt = instant(row.scheduled_at);
      return { subscriptionId: text(row, "subscription_id"), clientId: text(row, "client_id"),
        scheduledAt, scheduledInstant: Date.parse(scheduledAt), cadenceDays: integer(row.cadence_days, 1), cycle: correlation(row),
        currency: text(row, "currency_code"), stockSourceKey: text(row, "stock_source_key"),
        settlementChannelKey: text(row, "settlement_channel_key"), authorizationRef: text(row, "authorization_ref"),
        payerAccountRef: nullable(row.payer_account_ref), unattendedChargeAuthorizedAt: instant(row.unattended_charge_authorized_at),
        deliveryAdmission: row.delivery_admission === "allowed" ? "allowed" : "blocked", deliveryBlockReason: nullable(row.delivery_block_reason) };
    },
    freeze(row, schedule) {
      const due = codec.due({ ...row, scheduled_at: schedule.scheduledAt });
      if (due.subscriptionId !== schedule.subscriptionId || due.scheduledInstant !== schedule.scheduledInstant) throw new Error("subscription_renewal_schedule_mismatch");
      const facts = subscriptionRecord(row.purchase_facts);
      if (due.cycle.status !== "correlated") throw new Error("subscription_renewal_cycle_correlation_required");
      const frozenLines = lines(row.lines);
      const total = frozenLines.reduce((sum, line) => sum + line.quantity * line.unitAmountMinor, 0);
      integer(total, 1);
      const snapshot: RenewalFrozenSnapshot = { subscriptionId: due.subscriptionId, scheduledAt: due.scheduledAt,
        scheduledInstant: due.scheduledInstant, contractVersion: CONTRACT,
        clientId: due.clientId, frozenRevision: REVISION, frozenFingerprint: "", cycle: due.cycle,
        retryAttempt: 0, externalAttemptSequence: 0,
        templateSnapshot: { templateId: text(facts, "templateId"), version: integer(row.template_version, 1), cadenceDays: due.cadenceDays, lines: frozenLines },
        pricingSnapshot: { currency: due.currency, totalAmountMinor: total, shippingAmountMinor: integer(facts.shippingAmountMinor), agreementPolicy: "lock_until_edit", proration: "none" },
        orderSnapshot: { shippingAddressRef: null, shippingQuoteRef: null, acquisitionRef: nullable(facts.acquisitionRef), lines: frozenLines },
        stockSourceKey: due.stockSourceKey, settlementChannelKey: due.settlementChannelKey,
        authorizationRef: due.authorizationRef, payerAccountRef: due.payerAccountRef,
        unattendedChargeAuthorizedAt: due.unattendedChargeAuthorizedAt };
      snapshot.frozenFingerprint = fingerprint(snapshot);
      validate(snapshot);
      return snapshot;
    },
    encode(snapshot) {
      validate(snapshot);
      if (snapshot.frozenRevision !== REVISION || snapshot.frozenFingerprint !== fingerprint(snapshot)) throw new Error("subscription_renewal_snapshot_fingerprint_mismatch");
      // Round-trip through canonical bytes prevents undefined or extra host values.
      return JSON.parse(nativeRenewalCanonicalJson({ ...body(snapshot), frozenFingerprint: snapshot.frozenFingerprint })) as Record<string, unknown>;
    },
    decode(wire) {
      const scheduledAt = text(wire, "scheduledAt");
      const snapshot: RenewalFrozenSnapshot = {
        contractVersion: CONTRACT, subscriptionId: text(wire, "subscriptionId"), clientId: text(wire, "clientId"),
        scheduledAt, scheduledInstant: Date.parse(scheduledAt), frozenRevision: text(wire, "frozenRevision"), frozenFingerprint: text(wire, "frozenFingerprint"),
        cycle: subscriptionRecord(wire.cycle) as unknown as RenewalCycleCorrelation,
        retryAttempt: integer(wire.retryAttempt), externalAttemptSequence: integer(wire.externalAttemptSequence),
        templateSnapshot: subscriptionRecord(wire.templateSnapshot) as unknown as RenewalFrozenSnapshot["templateSnapshot"],
        pricingSnapshot: subscriptionRecord(wire.pricingSnapshot) as unknown as RenewalFrozenSnapshot["pricingSnapshot"],
        orderSnapshot: subscriptionRecord(wire.orderSnapshot) as unknown as RenewalFrozenSnapshot["orderSnapshot"],
        stockSourceKey: text(wire, "stockSourceKey"), settlementChannelKey: text(wire, "settlementChannelKey"),
        authorizationRef: text(wire, "authorizationRef"), payerAccountRef: nullable(wire.payerAccountRef),
        unattendedChargeAuthorizedAt: text(wire, "unattendedChargeAuthorizedAt"),
      };
      if (!Number.isFinite(snapshot.scheduledInstant) || nativeRenewalCanonicalJson(codec.encode(snapshot)) !== nativeRenewalCanonicalJson(wire)) throw new Error("subscription_renewal_snapshot_wire_mismatch");
      return snapshot;
    },
    readback(row) {
      const snapshot = codec.decode(subscriptionRecord(row.cycleSnapshot));
      return { ...row, cycleSnapshot: snapshot, cycle: snapshot.cycle, scheduledAt: snapshot.scheduledAt,
        scheduledInstant: snapshot.scheduledInstant } as unknown as RenewalReadback;
    },
    identity(snapshot: RenewalSchedule) { return `subscription:${snapshot.subscriptionId}:cycle:${instant(snapshot.scheduledAt)}`; },
    fingerprint,
  };
  return codec;
}
