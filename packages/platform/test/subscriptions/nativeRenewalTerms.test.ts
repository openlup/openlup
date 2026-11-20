import { describe, expect, it, vi } from "vitest";
import { NativeRenewalCadenceError } from "../../src/subscriptions/nativeRenewalCadence.js";
import { createPostgresRenewalStore } from "../../src/subscriptions/postgresRenewalStore.js";
import { withNativeDeliveryAlignmentRenewalAdmission } from "../../src/subscriptions/postgresDeliveryAlignmentStore.js";
import { createNativeRetryDriver } from "../../src/subscriptions/nativeRetryDriver.js";
import { createNativeRenewalCodec } from "../../src/subscriptions/nativeRenewalCodec.js";
import { graduateNativeRenewal, nativeRenewalPrice, nativeRenewalTermsSchema } from "../../src/subscriptions/nativeRenewalTerms.js";
import { resolveThresholdShipping, summarizeThresholdShipping } from "../../src/shipping/thresholdPolicy.js";
import { mapInvoiceClaimToProviderSnapshot } from "../../src/invoicing/snapshot.js";
import type { RenewalRetainedTerms } from "../../src/subscriptions/contracts/renewal.js";

const at = "2026-01-01T00:00:00.123456Z";
const sub = "abcdef01-2345-4678-9abc-def012345678", client = "abcdef02-2345-4678-9abc-def012345678";
const shipping = { version: "shipping-threshold.v1", currency: "XXX", flatMinor: 640, freeThresholdMinor: 7300 } as const;
const line = (unitAmountMinor: number) => ({ lineOrdinal: 1, sku: "SYNTHETIC-REFILL", quantity: 1, unitAmountMinor });
function terms(discount = 1800): RenewalRetainedTerms {
  return { version: "native.renewal-terms.v1", shippingTerms: shipping, minimumPayableMinor: 55, normalCadenceDays: [10, 20, 30],
    starterPack: { schemaVersion: "1", basisTemplateVersion: 1, starterIntervalDays: 7,
      delivery2: { discountBps: 2500, discountMinor: discount, basisSubtotalMinor: 9000 },
      graduation: { cadenceDays: 20, lines: [{ sku: "SYNTHETIC-REFILL", qty: 2, sortOrder: 0, isAddon: false,
        quoteLine: { unitPriceGross: { amountMinor: 6000 }, lineSubtotalGross: { amountMinor: 12000 } } }] } } };
}
function row(retained?: RenewalRetainedTerms, subtotal = 9000) {
  return { subscription_id: sub, client_id: client, cadence_days: 7, template_version: 1, scheduled_at: at,
    currency_code: "XXX", stock_source_key: "synthetic-stock", settlement_channel_key: "sandbox", authorization_ref: "synthetic-authorization",
    payer_account_ref: null, unattended_charge_authorized_at: at, next_cycle_number: 1, paid_cycle_count: 1,
    activation_cycle_id: "abcdef03-2345-4678-9abc-def012345678", activation_cycle_paid: true, delivery_admission: "allowed",
    purchase_facts: { templateId: "synthetic-template", shippingAmountMinor: 0, acquisitionRef: null,
      ...(retained ? { renewalTerms: retained } : {}) }, lines: [line(subtotal)] };
}

describe("retained renewal pricing characterization", () => {
  it("retains historical integer cadences, quantities and template versions", () => {
    const marker = nativeRenewalTermsSchema.shape.starterPack.unwrap();
    for (const schema of [nativeRenewalTermsSchema.shape.normalCadenceDays.unwrap().element,
      marker.shape.starterIntervalDays, marker.shape.graduation.shape.cadenceDays]) {
      for (const days of [1, 3660, 3661, 2_147_483_647]) expect(schema.parse(days)).toBe(days);
      for (const days of [0, 1.5, 2_147_483_648]) expect(schema.safeParse(days).success).toBe(false);
    }
    const retained = terms(); retained.starterPack!.basisTemplateVersion = 10_000;
    retained.linePricing = [{ sku: "BULK", quantity: 10_000, unitAmountMinor: 1, isAddon: false, quoteLine: {} }];
    expect(nativeRenewalTermsSchema.parse(retained)).toMatchObject({ linePricing: [{ quantity: 10_000 }], starterPack: { basisTemplateVersion: 10_000 } });
  });

  it("reads historical due/frozen cadences but refuses fresh execution with an actionable typed reason", () => {
    const codec = createNativeRenewalCodec(), schedule = { subscriptionId: sub, scheduledAt: at, scheduledInstant: Date.parse(at) };
    for (const days of [1, 3660, 3661, 2_147_483_647]) {
      const current = { ...row(), cadence_days: days };
      expect(codec.due(current).cadenceDays).toBe(days);
      const snapshot = codec.freeze(row(), schedule); snapshot.templateSnapshot.cadenceDays = days;
      snapshot.frozenFingerprint = codec.fingerprint(snapshot);
      expect(codec.decode(codec.encode(snapshot))).toEqual(snapshot);
      if (days <= 3660) expect(codec.freeze(current, schedule).templateSnapshot.cadenceDays).toBe(days);
      else {
        expect(() => codec.freeze(current, schedule)).toThrow(NativeRenewalCadenceError);
        expect(() => codec.freeze(current, schedule)).toThrow('choose a cadence from 1..3660');
      }
    }
    expect(() => codec.due({ ...row(), cadence_days: 0 })).toThrow();
  });
  it("reads a stored historical renewal operation before fresh snapshot admission", async () => {
    const codec = createNativeRenewalCodec(), schedule = { subscriptionId: sub, scheduledAt: at, scheduledInstant: Date.parse(at) };
    const snapshot = codec.freeze(row(), schedule); snapshot.templateSnapshot.cadenceDays = 3661;
    snapshot.frozenFingerprint = codec.fingerprint(snapshot);
    const wire = codec.encode(snapshot), queries: string[] = [];
    const store = createPostgresRenewalStore({query:async sql=>{queries.push(sql);return {rows:[{cycle_snapshot:wire}]};}},codec);
    expect(await store.buildCycleSnapshots(schedule)).toEqual(snapshot);
    expect(queries).toHaveLength(1); expect(queries[0]).toContain("SELECT cycle_snapshot");
  });
  it("admits an old frozen claim only when a durable operation exists, preserving SQL conflicts", async () => {
    const codec = createNativeRenewalCodec(), schedule = { subscriptionId: sub, scheduledAt: at, scheduledInstant: Date.parse(at) };
    const snapshot = codec.freeze(row(), schedule); snapshot.templateSnapshot.cadenceDays = 3661;
    snapshot.frozenFingerprint = codec.fingerprint(snapshot);
    const stored = {cycleSnapshot:codec.encode(snapshot)}, queries: string[] = [];
    let exists = false, conflict = false;
    const store = createPostgresRenewalStore({query:async sql=>{
      queries.push(sql);
      if(sql.includes('subscription_read_renewal'))return {rows:[{response:exists?stored:null}]};
      if(conflict)throw new Error('subscription_renewal_fingerprint_conflict');
      return {rows:[{response:stored}]};
    }},codec);
    const input = {snapshot,workerId:'synthetic-worker',now:at};
    await expect(store.claimDue(input)).rejects.toBeInstanceOf(NativeRenewalCadenceError);
    expect(queries).toHaveLength(1); exists=true;
    expect((await store.claimDue(input)).cycleSnapshot).toEqual(snapshot);
    expect(queries.at(-1)).toContain('subscription_claim_due_renewal');
    conflict=true;
    await expect(store.claimDue(input)).rejects.toThrow('subscription_renewal_fingerprint_conflict');
  });
  it("refuses fresh graduation above the execution limit before any writes", async () => {
    const retained = terms(); retained.normalCadenceDays = [3661]; retained.starterPack!.graduation.cadenceDays = 3661;
    const query = async () => { throw new Error("unexpected database work"); };
    await expect(graduateNativeRenewal({query}, { ...row(retained), paid_cycle_count: 2, next_cycle_number: 2 }))
      .rejects.toMatchObject({name:'NativeRenewalCadenceError',reason:'cadence_limit_exceeded',cadenceDays:3661,maximumCadenceDays:3660});
  });
  it.each([7299, 7300, 7301])("agrees with threshold shipping after discounts leave %i", product => {
    const current = row(terms(9000 - product));
    const price = nativeRenewalPrice(current, current.lines, 2);
    const fee = resolveThresholdShipping(shipping, product).grossMinor;
    expect(price).toMatchObject({ productSubtotalAmountMinor: 9000, discountAmountMinor: 9000 - product,
      shippingAmountMinor: fee, totalAmountMinor: product + fee, shippingTerms: shipping });
    const display = { productPayableMinor: product, totalMinor: price.totalAmountMinor, shippingGrossMinor: fee,
      shippingDiscountMinor: 0, terms: shipping };
    expect(summarizeThresholdShipping(display)).toMatchObject({ shippingIsFree: product >= 7300,
      remainingMinor: product < 7300 ? 7300 - product : 0 });
    expect(summarizeThresholdShipping({ ...display, stale: true }).remainingMinor).toBe(0);
    const invoice = mapInvoiceClaimToProviderSnapshot({ orderRef: "synthetic-renewal", issueDate: "2026-01-01", sellDate: "2026-01-01",
      currency: "XXX", seller: {}, buyerSnapshot: { name: "Synthetic buyer" }, documentKind: "receipt", governmentClearanceRequired: false,
      payment: {}, linesSnapshot: [{ name: "Refill", quantity: 1, unitGrossMinor: 9000, totalGrossMinor: 9000, vatRate: "0" }],
      totalGrossMinor: product + fee, totalNetMinor: product + fee,
      orderMoney: { subtotalCents: 9000, discountCents: 9000 - product, totalCents: product + fee } },
    { defaultBuyerLabel: "Buyer", defaultLineLabel: "Product", deliveryLabel: "Delivery", defaultTaxRate: "0" });
    expect(invoice.lines.reduce((sum, item) => sum + item.totalGrossMinor, 0)).toBe(price.totalAmountMinor);
    expect(invoice.chargedTotalGrossMinor).toBe(price.totalAmountMinor);
  });

  it("keeps frozen delivery-two money after a template bump or list-price change", () => {
    const retained = terms();
    retained.linePricing = [{ sku: "SYNTHETIC-REFILL", quantity: 1, unitAmountMinor: 9000, isAddon: false,
      quoteLine: { pricingComponents: [{ componentType: "base_unit", amountMinor: 12000 }] } }];
    const current = { ...row(retained), template_version: 3 };
    expect(nativeRenewalPrice(current, current.lines, 2)).toMatchObject({ discountAmountMinor: 1800, totalAmountMinor: 7840 });
  });

  it("uses the saved list target for changed lines and the saved fallback only without complete evidence", () => {
    const retained = terms();
    retained.linePricing = [{ sku: "SYNTHETIC-REFILL", quantity: 1, unitAmountMinor: 10000, isAddon: false,
      quoteLine: { pricingComponents: [{ componentType: "base_unit", amountMinor: 12001 }] } }];
    const current = row(retained, 10000);
    expect(nativeRenewalPrice(current, current.lines, 2).discountAmountMinor).toBe(999);
    retained.linePricing = [];
    expect(nativeRenewalPrice(current, current.lines, 2).discountAmountMinor).toBe(2500);
    const tiny = row(retained, 50);
    expect(nativeRenewalPrice(tiny, tiny.lines, 2).discountAmountMinor).toBe(0);
    expect(nativeRenewalPrice(current, current.lines, 3).discountAmountMinor).toBe(0);
  });

  it("computes delivery-two discounts in exact integers beyond float precision", () => {
    const large = (unitAmountMinor: number, discountBps: number, list?: number) => {
      const retained = terms();
      retained.starterPack!.delivery2 = { discountBps, discountMinor: 1, basisSubtotalMinor: 10_000 };
      retained.linePricing = list === undefined ? [] : [{ sku: "SYNTHETIC-REFILL", quantity: 1, unitAmountMinor, isAddon: false,
        quoteLine: { pricingComponents: [{ componentType: "base_unit", amountMinor: list }] } }];
      const current = row(retained, unitAmountMinor);
      return nativeRenewalPrice(current, current.lines, 2).discountAmountMinor;
    };
    // Reference integer results: subtotal - ceil(list × (10 000 - bps) / 10 000), and round(subtotal × bps / 10 000).
    expect(large(1_275_605_109_999, 1, 1_275_605_109_999)).toBe(127_560_510);
    expect(large(16_361_442_052_567, 7388)).toBe(12_087_833_388_436);
  });

  it("retains old wire bytes and accepts uppercase schedule UUIDs by value", () => {
    const codec = createNativeRenewalCodec(), current = row();
    const schedule = { subscriptionId: sub.toUpperCase(), scheduledAt: at, scheduledInstant: Date.parse(at) };
    const old = codec.freeze(current, schedule), wire = codec.encode(old);
    expect(old.frozenRevision).toBe("native.purchase-renewal.v1");
    expect(codec.encode(codec.decode(wire))).toEqual(wire);
    const next = codec.freeze(row(terms()), schedule);
    expect(next).toMatchObject({ subscriptionId: sub, frozenRevision: "native.purchase-renewal.v2",
      pricingSnapshot: { totalAmountMinor: 7840 }, orderSnapshot: { shippingQuoteRef: { kind: "retained_shipping" } } });
    expect(codec.decode(codec.encode(next))).toEqual(next);
    const damaged = { ...next, pricingSnapshot: { ...next.pricingSnapshot, totalAmountMinor: 1 } };
    damaged.frozenFingerprint = codec.fingerprint(damaged);
    expect(() => codec.encode(damaged)).toThrow("snapshot_inconsistent");
  });

  it("refuses damaged terms instead of treating them as an ordinary or free renewal", () => {
    expect(() => nativeRenewalTermsSchema.parse({ ...terms(), shippingTerms: null })).toThrow();
    expect(() => nativeRenewalTermsSchema.parse({ ...terms(), normalCadenceDays: [10] })).toThrow();
    expect(() => nativeRenewalTermsSchema.parse({ ...terms(), minimumPayableMinor: 8000 })).toThrow();
    expect(() => nativeRenewalPrice(row({ ...terms(), shippingTerms: { ...shipping, currency: "YYY" } }), [line(9000)], 2)).toThrow("currency_mismatch");
  });

  it("keeps the zero-shipping marker when only acquisition terms were added", () => {
    const retained = terms(); delete retained.shippingTerms;
    const codec = createNativeRenewalCodec(), schedule = { subscriptionId: sub, scheduledAt: at, scheduledInstant: Date.parse(at) };
    const snapshot = codec.freeze(row(retained), schedule);
    expect(snapshot.pricingSnapshot).toMatchObject({ discountAmountMinor: 1800, totalAmountMinor: 7200, shippingAmountMinor: 0 });
    expect(snapshot.orderSnapshot.shippingQuoteRef).toBeNull();
    const bound = codec.withDestination!(snapshot, "abcdef04-2345-4678-9abc-def012345678");
    expect(bound.orderSnapshot.shippingQuoteRef).toEqual({ kind: "zero_shipping", shippingAmountMinor: 0 });
    expect(codec.decode(codec.encode(bound))).toEqual(bound);
  });

  it("uses lightweight SQL for mandate/delivery admission, single snapshot load in buildCycleSnapshots, and 1-query combined delivery admission", async () => {
    const codec = createNativeRenewalCodec(), schedule = { subscriptionId: sub, scheduledAt: at, scheduledInstant: Date.parse(at) };
    const queries: string[] = [];
    const executor = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes("FROM public.subscription_renewal_operations")) return { rows: [] };
        if (sql.includes("FOR UPDATE")) return { rows: [{ id: sub }] };
        if (sql.includes("subscription_renewal_purchase_terms")) return { rows: [row(terms())] };
        if (sql.includes("t.authorization_ref") && !sql.includes("subscription_renewal_purchase_terms")) {
          return { rows: [{ authorization_ref: "auth-1", unattended_charge_authorized_at: at, method_authorized: true }] };
        }
        if (sql.includes("t.delivery_admission") && sql.includes("existing_cycle")) {
          return { rows: [{ delivery_admission: "allowed", delivery_block_reason: null, existing_cycle: false, mode: "off", captured_case: false }] };
        }
        if (sql.includes("t.delivery_admission")) {
          return { rows: [{ delivery_admission: "blocked", delivery_block_reason: "manual_hold" }] };
        }
        throw new Error(`unexpected SQL: ${sql}`);
      }),
    };
    const withTransaction = vi.fn(async <T>(work: (db: typeof executor) => Promise<T>) => work(executor));
    const store = createPostgresRenewalStore(executor, codec, withTransaction);

    // buildCycleSnapshots with withTransaction enters tx directly and reads SNAPSHOT_SQL once (not twice)
    const frozen = await store.buildCycleSnapshots(schedule);
    expect(frozen.frozenRevision).toBe("native.purchase-renewal.v2");
    expect(queries.filter(q => q.includes("subscription_renewal_purchase_terms"))).toHaveLength(1);

    // readMandateEvidence uses lightweight query without SNAPSHOT_SQL
    queries.length = 0;
    expect(await store.readMandateEvidence(schedule)).toEqual({ authorized: true, authorizationRef: "auth-1", authorizedAt: at });
    expect(queries).toHaveLength(1);
    expect(queries[0]).not.toContain("subscription_renewal_purchase_terms");

    // admitDeliveryAlignment on raw store uses lightweight 2-column SQL
    queries.length = 0;
    expect(await store.admitDeliveryAlignment(schedule)).toEqual({ allowed: false, state: "static", reason: "manual_hold", deferred: false });
    expect(queries).toHaveLength(1);
    expect(queries[0]).not.toContain("subscription_renewal_purchase_terms");

    // withNativeDeliveryAlignmentRenewalAdmission collapses static + context into 1 query when sharing executor
    queries.length = 0;
    const aligned = withNativeDeliveryAlignmentRenewalAdmission({ ...store }, executor, () => at);
    expect(await aligned.admitDeliveryAlignment(schedule)).toEqual({ allowed: true, state: "static", reason: "allowed" });
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("existing_cycle");
  });

  it("preserves canonical fingerprint and wire parity even when string fields contain key-like markers", () => {
    const codec = createNativeRenewalCodec(), schedule = { subscriptionId: sub, scheduledAt: at, scheduledInstant: Date.parse(at) };
    const tricky = { ...row(terms()), authorization_ref: 'auth,"frozenRevision":"spoof"' };
    const snapshot = codec.freeze(tricky, schedule);
    const wire = codec.encode(snapshot);
    expect(wire.authorizationRef).toBe('auth,"frozenRevision":"spoof"');
    expect(wire.frozenRevision).toBe("native.purchase-renewal.v2");
    expect(codec.decode(wire)).toEqual(snapshot);
    const bound = codec.withDestination!(snapshot, "abcdef04-2345-4678-9abc-def012345678");
    expect(codec.decode(codec.encode(bound))).toEqual(bound);
  });

  it("skips propagateFailure transaction in retry driver when failure_propagation_pending is false and runs it when true", async () => {
    const codec = createNativeRenewalCodec(), schedule = { subscriptionId: sub, scheduledAt: at, scheduledInstant: Date.parse(at) };
    const snapshot = codec.freeze(row(), schedule);
    const wire = codec.encode(snapshot);
    const makeDriver = (pending: boolean) => {
      const withTransaction = vi.fn(async <T>(work: (db: { query: (sql: string) => Promise<{ rows: Record<string, unknown>[] }> }) => Promise<T>) => work({
        query: async sql => {
          if (sql.includes("subscription_retry_read")) return { rows: [{ response: null }] };
          if (sql.includes("subscription_retry_apply_failure")) return { rows: [{ response: { state: "recovered", cycle_snapshot: wire } }] };
          if (sql.includes("case_advanced")) return { rows: [{ replayed: true, case_advanced: true }] };
          return { rows: [] };
        },
      }));
      const driver = createNativeRetryDriver({
        executor: {
          query: vi.fn(async (sql: string) => {
            if (sql.includes("FROM public.subscription_retry_obligations")) {
              return { rows: [{
                renewal_operation_id: "op-1",
                cycle_snapshot: wire,
                failure_key: "f-1",
                failure_input: { attemptSequence: 1, logicalCycleNumber: 2, occurredAt: at, failureClass: "temporary", reason: "declined", externalRef: "ext-1", evidenceKey: "ev-1", firstRecordedAt: at },
                failure_propagation_pending: pending,
              }] };
            }
            if (sql.includes("subscription_retry_read")) return { rows: [{ response: null }] };
            throw new Error(`unexpected SQL: ${sql}`);
          }),
        },
        withTransaction,
        decode: codec.decode,
        readFrozenMandate: async () => ({ authorized: true, authorizationRef: "synthetic-authorization", paymentMethodRef: "pm-1" }),
        retryInput: () => { throw new Error("not expected"); },
        validateInput: () => {},
        payments: { execute: async () => { throw new Error("not expected"); }, readOutcome: async () => { throw new Error("not expected"); } },
        failureTemplate: "dunning",
        recoveredTemplate: "recovered",
        recoveryPath: null,
        classifyFailure: () => "temporary",
      });
      return { driver, withTransaction };
    };
    const skipped = makeDriver(false);
    expect(await skipped.driver.run(at, 10)).toEqual([]);
    expect(skipped.withTransaction).not.toHaveBeenCalled();

    const propagated = makeDriver(true);
    expect(await propagated.driver.run(at, 10)).toEqual([]);
    expect(propagated.withTransaction).toHaveBeenCalledOnce();
  });
});
