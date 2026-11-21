import { cataloguePositionNetFromGross } from "./catalogueMoney.js";

/** @beta @experimental */
export type CatalogueMoneyV2Basis = "inclusive" | "exclusive";
/** @beta @experimental */
export type CatalogueMoneyV2ComponentRef =
  | Readonly<{ kind: "merchandise"; lineKey: string; sourceOrdinal: number }>
  | Readonly<{ kind: "delivery"; bucketKey: string; sourceOrdinal?: number }>;
/** @beta @experimental */
export type CatalogueMoneyV2Input = Readonly<{
  amountBasis: CatalogueMoneyV2Basis;
  sources: readonly Readonly<{ lineKey: string; sourceOrdinal: number; quantity: number; unitBasisMinor: number }>[];
  delivery: readonly Readonly<{ bucketKey: string; deliveryKind: "shipping" | "handling"; amountMinor: number }>[];
  adjustments: readonly Readonly<{
    adjustmentRef: string; sequence: number; amountMinor: number;
    target: Readonly<{ lineKeys: readonly string[] }> | Readonly<{ bucketKey: string }>;
  }>[];
  fees: readonly Readonly<{ feeKey: string; amountMinor: number }>[];
}>;

/** @beta @experimental */
export type CatalogueMoneyV2Allocation = Readonly<{
  adjustmentRef: string; sequence: number; basisReductionMinor: number; beforeMinor: number; afterMinor: number;
}>;
/** @beta @experimental */
export type CatalogueMoneyV2Plan = Readonly<{
  amountBasis: CatalogueMoneyV2Basis;
  components: readonly Readonly<{
    ref: CatalogueMoneyV2ComponentRef; preDiscountMinor: number; effectiveMinor: number;
    allocations: readonly CatalogueMoneyV2Allocation[];
  }>[];
  fees: CatalogueMoneyV2Input["fees"];
}>;
/** @beta @experimental */
export type CatalogueMoneyV2Position = Readonly<{
  positionRef: string; jurisdictionRef: string; rateDecimal?: string; taxableMinor: number; taxMinor: number;
}>;
/**
 * Tax inputs for a catalogue money calculation.
 *
 * @remarks
 * In local mode, compute each position's exact tax quota as the component state
 * amount times the position's rate divided by 100. Sum the quotas and round the
 * combined tax half up once to a minor unit. Floor each position's exact quota,
 * then assign the remaining minor units by descending fractional remainder,
 * breaking ties by ascending `positionRef` in UTF-16 code-unit order.
 *
 * In provider mode, use one row per component ref from {@link planCatalogueMoneyV2}.
 * Start each row with `afterSequence: 0` and `amountMinor` equal to the component's
 * `preDiscountMinor`. Then add one state per nonzero allocation in plan order,
 * using its `sequence` as `afterSequence` and its `afterMinor` as `amountMinor`.
 * Sequence gaps are normal. The provider's `payableMinor` includes fees.
 *
 * @example
 * A component starts at 100 and has one allocation at sequence 3 that leaves 80.
 * Its states use `afterSequence` and `amountMinor` pairs `(0, 100)` and `(3, 80)`
 * with the provider's tax positions for each amount. For a plan with just this
 * component, final tax of 8 and a fee of 5, the provider payable is 93.
 *
 * @beta
 * @experimental
 */
export type CatalogueMoneyV2Tax =
  | Readonly<{ kind: "inclusive"; components: readonly Readonly<{
      ref: CatalogueMoneyV2ComponentRef; rateBps: number;
    }>[] }>
  | Readonly<{ kind: "local"; components: readonly Readonly<{
      ref: CatalogueMoneyV2ComponentRef;
      rates: readonly Readonly<{ positionRef: string; jurisdictionRef: string; rateDecimal: string }>[];
    }>[] }>
  | Readonly<{ kind: "provider"; payableMinor: number; components: readonly Readonly<{
      ref: CatalogueMoneyV2ComponentRef;
      states: readonly Readonly<{
        afterSequence: number; amountMinor: number; taxPositions: readonly CatalogueMoneyV2Position[];
      }>[];
    }>[] }>;

/** @beta @experimental */
export type CatalogueMoneyV2State = Readonly<{
  amountMinor: number; netMinor: number; taxMinor: number; totalMinor: number;
  taxPositions: readonly CatalogueMoneyV2Position[];
}>;
/** @beta @experimental */
export type CatalogueMoneyV2Result = Readonly<{
  amountBasis: CatalogueMoneyV2Basis;
  components: readonly Readonly<{
    ref: CatalogueMoneyV2ComponentRef; initial: CatalogueMoneyV2State;
    allocations: readonly Readonly<CatalogueMoneyV2Allocation & {
      before: CatalogueMoneyV2State; after: CatalogueMoneyV2State;
      netReductionMinor: number; taxReductionMinor: number;
    }>[];
    final: CatalogueMoneyV2State;
  }>[];
  fees: CatalogueMoneyV2Input["fees"];
  netTotal: number; taxTotal: number; feeTotal: number; payableMinor: number;
}>;
/** @beta @experimental */
export type CatalogueMoneyV2ErrorCode =
  | "money_input_invalid" | "money_amount_out_of_range" | "money_amount_basis_mixed"
  | "money_source_ordinal_duplicate" | "money_discount_exceeds_balance" | "shipping_tax_basis_empty"
  | "money_rate_invalid" | "money_tax_evidence_mismatch" | "money_payable_mismatch";
/** @beta @experimental */
export class CatalogueMoneyV2Error extends Error {
  constructor(readonly code: CatalogueMoneyV2ErrorCode, readonly field: string, readonly remedy: string) {
    super(`${code} at ${field}. ${remedy}`);
    this.name = "CatalogueMoneyV2Error";
  }
}

const remedies: Record<CatalogueMoneyV2ErrorCode, string> = {
  money_input_invalid: "Supply the declared shape and limits, unique scoped keys, and existing targets in recorded sequence.",
  money_amount_out_of_range: "Supply safe integers and reduce the operands of an overflowing field.",
  money_amount_basis_mixed: "Submit one basis and its matching tax mode.",
  money_source_ordinal_duplicate: "Supply a distinct positive ordinal for each source.",
  money_discount_exceeds_balance: "Reduce the adjustment or correct its eligibility.",
  shipping_tax_basis_empty: "Supply positive eligible product basis or a zero shipping charge.",
  money_rate_invalid: "Supply a decimal percent string from 0 to 9007199254.740991 with up to six fractional digits and no extra leading zeros.",
  money_tax_evidence_mismatch: "This tax component ref does not match a required plan component. Use the matching component ref from the plan or remove the extra row.",
  money_payable_mismatch: "Provider payable does not match the final net, tax and fees. Re-obtain the provider payable for the same plan, including fees.",
};

function refuse(code: CatalogueMoneyV2ErrorCode, field: string, remedy = remedies[code]): never {
  throw new CatalogueMoneyV2Error(code, field, remedy);
}

function shape(value: unknown, field: string, keys: readonly string[]): void {
  if (typeof value !== "object" || value === null ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).some(key => {
      const property = Object.getOwnPropertyDescriptor(value, key);
      return typeof key !== "string" || !keys.includes(key) || !property?.enumerable || !("value" in property);
    })) {
    refuse("money_input_invalid", field);
  }
}

function list<T>(value: readonly T[], field: string, max = 256): readonly T[] {
  if (!Array.isArray(value)) refuse("money_input_invalid", field);
  if (value.length > max) refuse("money_input_invalid", field, `Supply at most ${max} entries.`);
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) refuse("money_input_invalid", `${field}[${index}]`);
  }
  return value;
}

function reference(value: string, field: string): void {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) {
    refuse("money_input_invalid", field, "Supply a reference string of 1 to 128 UTF-16 code units.");
  }
}
function integer(value: number, field: string, min = 0): bigint {
  if (!Number.isSafeInteger(value) || value < min) {
    refuse("money_amount_out_of_range", field, `Supply a safe integer of at least ${min}.`);
  }
  return BigInt(value);
}

const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
function minor(value: bigint, field: string): number {
  if (value < 0n || value > maxSafe) refuse("money_amount_out_of_range", field);
  return Number(value);
}

function unique<T>(keys: Set<T>, key: T, field: string, code: CatalogueMoneyV2ErrorCode = "money_input_invalid"): void {
  if (keys.has(key)) refuse(code, field);
  keys.add(key);
}

// Callers supply quotas in tie order and keep their output order.
function apportion(quotas: readonly bigint[], denominator: bigint, total: bigint): bigint[] {
  const shares = quotas.map(quota => quota / denominator);
  let remaining = total - shares.reduce((sum, share) => sum + share, 0n);
  const order = quotas.map((quota, index) => ({ remainder: quota % denominator, index }))
    .sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1);
  for (const { index } of order) {
    if (remaining === 0n) break;
    shares[index] += 1n;
    remaining -= 1n;
  }
  return shares;
}

type WorkingComponent<Ref = CatalogueMoneyV2ComponentRef> = { ref: Ref; preDiscountMinor: number; effectiveMinor: number;
  allocations: CatalogueMoneyV2Allocation[] };
type Adjustment = CatalogueMoneyV2Input["adjustments"][number];
function component<Ref extends CatalogueMoneyV2ComponentRef>(ref: Ref, amount: number): WorkingComponent<Ref> {
  return { ref, preDiscountMinor: amount, effectiveMinor: amount, allocations: [] };
}
function discount(components: readonly WorkingComponent[], adjustment: Adjustment, field: string): void {
  const amount = BigInt(adjustment.amountMinor);
  const weights = components.map(item => BigInt(item.effectiveMinor));
  const total = weights.reduce((sum, weight) => sum + weight, 0n);
  if (amount > total) refuse("money_discount_exceeds_balance", field);
  if (amount === 0n) return;
  apportion(weights.map(weight => weight * amount), total, amount).forEach((share, index) => {
    if (share === 0n) return;
    const item = components[index];
    const beforeMinor = item.effectiveMinor;
    item.effectiveMinor = minor(weights[index] - share, field);
    item.allocations.push({ adjustmentRef: adjustment.adjustmentRef, sequence: adjustment.sequence,
      basisReductionMinor: minor(share, field), beforeMinor, afterMinor: item.effectiveMinor });
  });
}

/**
 * Plan the exact bases and nonzero adjustments for each component. Use the plan
 * to request provider states as described in {@link CatalogueMoneyV2Tax}.
 * @beta
 * @experimental
 */
export function planCatalogueMoneyV2(input: CatalogueMoneyV2Input): CatalogueMoneyV2Plan {
  shape(input, "input", ["amountBasis", "sources", "delivery", "adjustments", "fees"]);
  const { amountBasis } = input;
  if (amountBasis !== "inclusive" && amountBasis !== "exclusive") refuse("money_input_invalid", "amountBasis");
  const lines = new Set<string>();
  const ordinals = new Set<number>();
  const merchandise = list(input.sources, "sources").map((source, index) => {
    const field = `sources[${index}]`;
    shape(source, field, ["lineKey", "sourceOrdinal", "quantity", "unitBasisMinor"]);
    const { lineKey, sourceOrdinal } = source;
    reference(lineKey, `${field}.lineKey`);
    unique(lines, lineKey, `${field}.lineKey`);
    integer(sourceOrdinal, `${field}.sourceOrdinal`, 1);
    unique(ordinals, sourceOrdinal, `${field}.sourceOrdinal`, "money_source_ordinal_duplicate");
    const extended = integer(source.unitBasisMinor, `${field}.unitBasisMinor`) * integer(source.quantity, `${field}.quantity`, 1);
    return component({ kind: "merchandise", lineKey, sourceOrdinal }, minor(extended, `${field}.preDiscountMinor`));
  }).sort((a, b) => a.ref.sourceOrdinal - b.ref.sourceOrdinal);
  const buckets = new Map<string, WorkingComponent[]>();
  let shipping: { bucketKey: string; field: string; amount: bigint } | undefined;
  list(input.delivery, "delivery").forEach((delivery, index) => {
    const field = `delivery[${index}]`;
    shape(delivery, field, ["bucketKey", "deliveryKind", "amountMinor"]);
    const { bucketKey, deliveryKind, amountMinor } = delivery;
    reference(bucketKey, `${field}.bucketKey`);
    if (buckets.has(bucketKey)) refuse("money_input_invalid", `${field}.bucketKey`);
    if (deliveryKind !== "shipping" && deliveryKind !== "handling") refuse("money_input_invalid", `${field}.deliveryKind`);
    const amount = integer(amountMinor, `${field}.amountMinor`);
    if (amountBasis === "inclusive" && deliveryKind === "shipping") {
      if (shipping) {
        refuse("money_input_invalid", `${field}.deliveryKind`,
          "Use at most one shipping bucket for inclusive amounts. Combine shipping charges into that bucket.");
      }
      shipping = { bucketKey, field: `${field}.amountMinor`, amount };
    }
    buckets.set(bucketKey, [component({ kind: "delivery", bucketKey }, amountMinor)]);
  });

  const deliveryAdjustments: { bucketKey: string; adjustment: Adjustment; field: string }[] = [];
  let previousSequence = 0;
  list(input.adjustments, "adjustments").forEach((adjustment, index) => {
    const field = `adjustments[${index}]`;
    shape(adjustment, field, ["adjustmentRef", "sequence", "amountMinor", "target"]);
    reference(adjustment.adjustmentRef, `${field}.adjustmentRef`);
    integer(adjustment.sequence, `${field}.sequence`, 1);
    if (adjustment.sequence <= previousSequence) refuse("money_input_invalid", `${field}.sequence`);
    previousSequence = adjustment.sequence;
    const amountField = `${field}.amountMinor`;
    integer(adjustment.amountMinor, amountField);
    const { target } = adjustment;
    shape(target, `${field}.target`, ["lineKeys", "bucketKey"]);
    if ("lineKeys" in target) {
      if ("bucketKey" in target) refuse("money_input_invalid", `${field}.target`);
      const keys = new Set<string>();
      list(target.lineKeys, `${field}.target.lineKeys`).forEach((key, targetIndex) => {
        const keyField = `${field}.target.lineKeys[${targetIndex}]`;
        reference(key, keyField);
        if (!lines.has(key)) refuse("money_input_invalid", keyField);
        unique(keys, key, keyField);
      });
      discount(merchandise.filter(item => keys.has(item.ref.lineKey)), adjustment, amountField);
    } else {
      reference(target.bucketKey, `${field}.target.bucketKey`);
      if (!buckets.has(target.bucketKey)) refuse("money_input_invalid", `${field}.target.bucketKey`);
      deliveryAdjustments.push({ bucketKey: target.bucketKey, adjustment, field: amountField });
    }
  });

  // Delivery targets are disjoint from merchandise, whose final balances set the shipping weights.
  if (shipping && shipping.amount > 0n) {
    const { bucketKey, field, amount } = shipping;
    const eligible = merchandise.filter(item => item.effectiveMinor > 0);
    const weights = eligible.map(item => BigInt(item.effectiveMinor));
    const total = weights.reduce((sum, weight) => sum + weight, 0n);
    if (total === 0n) refuse("shipping_tax_basis_empty", field);
    const shares = apportion(weights.map(weight => weight * amount), total, amount);
    buckets.set(bucketKey, eligible.map((item, index) =>
      component({ kind: "delivery", bucketKey, sourceOrdinal: item.ref.sourceOrdinal }, minor(shares[index], field))));
  }
  for (const { bucketKey, adjustment, field } of deliveryAdjustments) discount(buckets.get(bucketKey)!, adjustment, field);

  const feeKeys = new Set<string>();
  const fees = list(input.fees, "fees").map((fee, index) => {
    const field = `fees[${index}]`;
    shape(fee, field, ["feeKey", "amountMinor"]);
    reference(fee.feeKey, `${field}.feeKey`);
    unique(feeKeys, fee.feeKey, `${field}.feeKey`);
    integer(fee.amountMinor, `${field}.amountMinor`);
    return { ...fee };
  });
  return { amountBasis, components: [...merchandise, ...Array.from(buckets.values()).flat()], fees };
}

function componentKey(ref: CatalogueMoneyV2ComponentRef): string {
  return JSON.stringify(ref.kind === "merchandise"
    ? [ref.kind, ref.lineKey, ref.sourceOrdinal] : [ref.kind, ref.bucketKey, ref.sourceOrdinal]);
}
function validateComponentRef(ref: CatalogueMoneyV2ComponentRef, field: string): void {
  shape(ref, field, ["kind", "lineKey", "bucketKey", "sourceOrdinal"]);
  if (ref.kind === "merchandise" && !("bucketKey" in ref)) {
    reference(ref.lineKey, `${field}.lineKey`);
    integer(ref.sourceOrdinal, `${field}.sourceOrdinal`, 1);
  } else if (ref.kind === "delivery" && !("lineKey" in ref)) {
    reference(ref.bucketKey, `${field}.bucketKey`);
    if (ref.sourceOrdinal !== undefined) integer(ref.sourceOrdinal, `${field}.sourceOrdinal`, 1);
  } else {
    refuse("money_input_invalid", field);
  }
}

function parseRate(value: unknown): bigint | undefined {
  const match = typeof value === "string" && /^(0|[1-9][0-9]{0,9})(?:\.([0-9]{1,6}))?$/.exec(value);
  if (!match || match[0] !== value) return undefined;
  const scaled = BigInt(match[1] + (match[2] ?? "").padEnd(6, "0"));
  return scaled <= maxSafe ? scaled : undefined;
}

/** @beta @experimental */
export function isCatalogueMoneyV2RateDecimal(value: unknown): value is string {
  return parseRate(value) !== undefined;
}

function scaledRate(value: string, field: string): bigint {
  return parseRate(value) ?? refuse("money_rate_invalid", field);
}

function exclusiveState(amountMinor: number, taxPositions: CatalogueMoneyV2Position[], field: string): CatalogueMoneyV2State {
  const tax = taxPositions.reduce((sum, position) => sum + BigInt(position.taxMinor), 0n);
  return { amountMinor, netMinor: amountMinor, taxMinor: minor(tax, `${field}.taxMinor`),
    totalMinor: minor(BigInt(amountMinor) + tax, `${field}.totalMinor`), taxPositions };
}

type PlanComponent = CatalogueMoneyV2Plan["components"][number];
type ReadState = (amount: number, sequence: number, index: number) => CatalogueMoneyV2State;
function stateReader(tax: CatalogueMoneyV2Tax, item: PlanComponent, row: number): ReadState {
  const field = `tax.components[${row}]`;
  if (tax.kind === "inclusive") {
    const rate = row === -1 ? 0 : tax.components[row].rateBps;
    if (!Number.isInteger(rate) || rate < 0 || rate > 10_000) {
      refuse("money_rate_invalid", `${field}.rateBps`, "Supply an integer from 0 to 10000 basis points.");
    }
    return amountMinor => {
      const netMinor = cataloguePositionNetFromGross(amountMinor, rate);
      return { amountMinor, netMinor, taxMinor: amountMinor - netMinor, totalMinor: amountMinor, taxPositions: [] };
    };
  }

  const positionRefs = new Set<string>();
  if (tax.kind === "local") {
    const rates = list(tax.components[row].rates, `${field}.rates`, 32).map((rate, index) => {
      const path = `${field}.rates[${index}]`;
      shape(rate, path, ["positionRef", "jurisdictionRef", "rateDecimal"]);
      reference(rate.positionRef, `${path}.positionRef`);
      unique(positionRefs, rate.positionRef, `${path}.positionRef`);
      reference(rate.jurisdictionRef, `${path}.jurisdictionRef`);
      return { rate, scaled: scaledRate(rate.rateDecimal, `${path}.rateDecimal`) };
    }).sort((a, b) => a.rate.positionRef < b.rate.positionRef ? -1 : 1);
    return amountMinor => {
      const quotas = rates.map(({ scaled }) => BigInt(amountMinor) * scaled);
      const denominator = 100_000_000n;
      const totalTax = (quotas.reduce((sum, quota) => sum + quota, 0n) + denominator / 2n) / denominator;
      minor(totalTax, `${field}.taxMinor`);
      const shares = apportion(quotas, denominator, totalTax);
      return exclusiveState(amountMinor, rates.map(({ rate }, index) => ({
        ...rate, taxableMinor: amountMinor, taxMinor: minor(shares[index], `${field}.taxMinor`),
      })), field);
    };
  }

  const states = list(tax.components[row].states, `${field}.states`, 257);
  const expectedStates = item.allocations.length + 1;
  if (states.length !== expectedStates) {
    const condition = states.length < expectedStates ? "missing states" : "extra states";
    refuse("money_tax_evidence_mismatch", `${field}.states`,
      `Provider evidence has ${condition}. Supply ${expectedStates} states with an initial state and one per nonzero allocation.`);
  }
  return (amountMinor, sequence, index) => {
    const path = `${field}.states[${index}]`;
    const state = states[index];
    shape(state, path, ["afterSequence", "amountMinor", "taxPositions"]);
    integer(state.afterSequence, `${path}.afterSequence`);
    integer(state.amountMinor, `${path}.amountMinor`);
    if (state.afterSequence !== sequence) {
      refuse("money_tax_evidence_mismatch", `${path}.afterSequence`,
        `Provider state sequence does not match the plan. Supply states in plan order with afterSequence ${sequence} at this step.`);
    }
    if (state.amountMinor !== amountMinor) {
      refuse("money_tax_evidence_mismatch", `${path}.amountMinor`,
        `Provider state amount does not match the plan. Re-obtain the provider state for amountMinor ${amountMinor} at this step.`);
    }
    positionRefs.clear();
    const positions = list(state.taxPositions, `${path}.taxPositions`, 32).map((position, positionIndex) => {
      const positionPath = `${path}.taxPositions[${positionIndex}]`;
      shape(position, positionPath, ["positionRef", "jurisdictionRef", "rateDecimal", "taxableMinor", "taxMinor"]);
      reference(position.positionRef, `${positionPath}.positionRef`);
      unique(positionRefs, position.positionRef, `${positionPath}.positionRef`);
      reference(position.jurisdictionRef, `${positionPath}.jurisdictionRef`);
      if (position.rateDecimal !== undefined) scaledRate(position.rateDecimal, `${positionPath}.rateDecimal`);
      integer(position.taxableMinor, `${positionPath}.taxableMinor`);
      integer(position.taxMinor, `${positionPath}.taxMinor`);
      return { ...position };
    });
    return exclusiveState(amountMinor, positions, path);
  };
}

/**
 * Calculate rounded states and reconcile the payable. See {@link CatalogueMoneyV2Tax}
 * for local rounding and the required provider states.
 * @beta
 * @experimental
 */
export function calculateCatalogueMoneyV2(input: CatalogueMoneyV2Input, tax: CatalogueMoneyV2Tax): CatalogueMoneyV2Result {
  const plan = planCatalogueMoneyV2(input);
  shape(tax, "tax", ["kind", "components", "payableMinor"]);
  if (tax.kind !== "inclusive" && tax.kind !== "local" && tax.kind !== "provider") refuse("money_input_invalid", "tax.kind");
  if (tax.kind !== "provider" && "payableMinor" in tax) refuse("money_input_invalid", "tax.payableMinor");
  if ((plan.amountBasis === "inclusive") !== (tax.kind === "inclusive")) refuse("money_amount_basis_mixed", "tax.kind");
  if (tax.kind === "provider") integer(tax.payableMinor, "tax.payableMinor");

  const shippingKey = tax.kind === "inclusive" ? input.delivery.find(item => item.deliveryKind === "shipping")?.bucketKey : undefined;
  const shipping = (ref: CatalogueMoneyV2ComponentRef) => ref.kind === "delivery" && ref.bucketKey === shippingKey;
  const expected = new Set(plan.components.filter(item => !shipping(item.ref)).map(item => componentKey(item.ref)));
  const rows = new Map<string, number>();
  const dataKey = tax.kind === "inclusive" ? "rateBps" : tax.kind === "local" ? "rates" : "states";
  list<CatalogueMoneyV2Tax["components"][number]>(tax.components, "tax.components", 512).forEach((entry, index) => {
    const field = `tax.components[${index}]`;
    shape(entry, field, ["ref", dataKey]);
    validateComponentRef(entry.ref, `${field}.ref`);
    const key = componentKey(entry.ref);
    if (!expected.delete(key)) {
      const remedy = rows.has(key)
        ? "This tax component ref duplicates an earlier row. Supply one row for each required component ref."
        : remedies.money_tax_evidence_mismatch;
      refuse("money_tax_evidence_mismatch", `${field}.ref`, remedy);
    }
    rows.set(key, index);
  });
  if (expected.size > 0) {
    refuse("money_tax_evidence_mismatch", "tax.components",
      "Tax evidence is missing a component row. Supply evidence for each missing component ref from the plan.");
  }
  const merchandiseRows = new Map<number, number>();
  const components = plan.components.map(item => {
    const { ref } = item;
    const row = shipping(ref) ? merchandiseRows.get(ref.sourceOrdinal ?? 0) ?? -1 : rows.get(componentKey(ref))!;
    if (ref.kind === "merchandise") merchandiseRows.set(ref.sourceOrdinal, row);
    const readState = stateReader(tax, item, row);
    const initial = readState(item.preDiscountMinor, 0, 0);
    let previous = initial;
    const allocations = item.allocations.map((allocation, index) => {
      const before = previous;
      const after = readState(allocation.afterMinor, allocation.sequence, index + 1);
      const taxReductionMinor = before.taxMinor - after.taxMinor;
      if (taxReductionMinor < 0 && tax.kind === "provider") {
        refuse("money_tax_evidence_mismatch", `tax.components[${row}].states[${index + 1}].taxPositions`,
          "Provider tax increased on a discount step. Re-obtain tax positions for the plan amounts before and after that allocation.");
      }
      previous = after;
      return { ...allocation, before, after, netReductionMinor: before.netMinor - after.netMinor, taxReductionMinor };
    });
    return { ref, initial, allocations, final: previous };
  });
  const netTotal = minor(components.reduce((sum, item) => sum + BigInt(item.final.netMinor), 0n), "netTotal");
  const taxTotal = minor(components.reduce((sum, item) => sum + BigInt(item.final.taxMinor), 0n), "taxTotal");
  const feeTotal = minor(plan.fees.reduce((sum, fee) => sum + BigInt(fee.amountMinor), 0n), "feeTotal");
  const payableMinor = minor(BigInt(netTotal) + BigInt(taxTotal) + BigInt(feeTotal), "payableMinor");
  if (tax.kind === "provider" && tax.payableMinor !== payableMinor) refuse("money_payable_mismatch", "tax.payableMinor");
  return { amountBasis: plan.amountBasis, components, fees: plan.fees, netTotal, taxTotal, feeTotal, payableMinor };
}
