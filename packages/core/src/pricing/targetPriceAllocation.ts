/**
 * Bundle target-price allocation — the pure kernel that turns ONE operator-set
 * price for a composed bundle into exact per-component money.
 *
 * An operator prices a bundle as a whole; every downstream surface (order lines,
 * invoices, refunds, tax) needs a per-unit figure that reconciles back to that one
 * number to the last minor unit. This module derives those figures and nothing else:
 * integer arithmetic in BigInt, no clock, no randomness, no I/O.
 *
 * The split is largest-remainder (Hamilton), weighted by each component's own
 * reference subtotal (quantity x unit price), with a deterministic tie-break on the
 * component code so the same input always yields byte-identical output. Two rules
 * bound the result:
 *
 *   floor:    a component never allocates below its minimum payable per unit, and a
 *             component whose own reference unit price sits below that minimum is
 *             held to its reference price instead — the reference price is a ceiling,
 *             so no floor may lift a component above what it is worth.
 *   ceiling:  a component never allocates above its reference unit price, which is
 *             what makes the emitted per-line adjustment a discount rather than a
 *             hidden surcharge.
 *
 * Invariant, asserted by the suite over a generated matrix:
 *   sum(lines[].lineSubtotalMinor) === targetPriceMinor, exactly, always.
 *
 * A quantity whose allocated subtotal does not divide evenly emits TWO lines rather
 * than a rounded unit price, because every consumer of a quote line refines
 * `unitPrice x quantity === lineSubtotal` and a rounded unit price cannot satisfy it.
 *
 * Malformed input throws a RangeError (the idiom this package's other pure engines
 * use for a caller contract breach); a well-formed request that cannot be priced
 * returns a discriminated failure with a stable code, because those three cases are
 * operator decisions rather than programming errors.
 */

/** @beta */
export interface BundleComponentInput {
  sku: string;
  unitPriceMinor: number;
  quantity: number;
}

/** @beta */
export interface AllocateBundleTargetPriceInput {
  components: ReadonlyArray<BundleComponentInput>;
  targetPriceMinor: number;
  minimumUnitPayableMinor?: number;
}

/** @beta */
export const BUNDLE_ALLOCATION_FAILURE_CODES = [
  "REFERENCE_TOTAL_ZERO",
  "TARGET_ABOVE_COMPONENT_SUM",
  "TARGET_BELOW_FLOOR",
] as const;
/** @beta */
export type BundleAllocationFailureCode = (typeof BUNDLE_ALLOCATION_FAILURE_CODES)[number];

/** @beta */
export const DEFAULT_MINIMUM_UNIT_PAYABLE_MINOR = 1;

/** @beta */
export interface BundleAllocationFailure {
  ok: false;
  code: BundleAllocationFailureCode;
}

/** @beta */
export interface BundleAllocatedLine {
  sku: string;
  quantity: number;
  effectiveUnitPriceMinor: number;
  lineSubtotalMinor: number;
}

/** @beta */
export interface BundleComponentAllocation {
  sku: string;
  quantity: number;
  referenceUnitPriceMinor: number;
  referenceSubtotalMinor: number;
  targetSubtotalMinor: number;
  discountAllocatedMinor: number;
  discountBps: number;
  hasSplitPricing: boolean;
}

/** @beta */
export interface BundleAllocationResult {
  ok: true;
  referenceTotalMinor: number;
  targetPriceMinor: number;
  discountTotalMinor: number;
  discountBps: number;
  components: BundleComponentAllocation[];
  lines: BundleAllocatedLine[];
  floorApplied: boolean;
}

/**
 * Derive per-component money for a bundle sold at one target price.
 *
 * Returns a failure when the composition cannot carry the price: nothing to weigh
 * against (`REFERENCE_TOTAL_ZERO`), a target above the sum of the parts
 * (`TARGET_ABOVE_COMPONENT_SUM` — a bundle is never priced above its parts, and the
 * decision lives here as one comparison so relaxing it stays a one-line change), or
 * a target that cannot cover every component's minimum payable (`TARGET_BELOW_FLOOR`).
 */
/** @beta */
export function allocateBundleTargetPrice(
  input: AllocateBundleTargetPriceInput,
): BundleAllocationResult | BundleAllocationFailure {
  const components = validateInput(input);
  const minimumUnitPayableMinor = input.minimumUnitPayableMinor ?? DEFAULT_MINIMUM_UNIT_PAYABLE_MINOR;
  const target = BigInt(input.targetPriceMinor);
  const references = components.map((item) => BigInt(item.quantity) * BigInt(item.unitPriceMinor));
  const referenceTotal = references.reduce(add, 0n);
  assertSafe("referenceTotalMinor", referenceTotal);

  if (referenceTotal === 0n) return { ok: false, code: "REFERENCE_TOTAL_ZERO" };
  if (target > referenceTotal) return { ok: false, code: "TARGET_ABOVE_COMPONENT_SUM" };

  const floors = components.map(
    (item) => BigInt(item.quantity) * BigInt(Math.min(minimumUnitPayableMinor, item.unitPriceMinor)),
  );
  if (target < floors.reduce(add, 0n)) return { ok: false, code: "TARGET_BELOW_FLOOR" };

  const codes = components.map((item) => item.sku);
  const { subtotals, floorApplied } = splitAgainstFloors(target, references, floors, codes);
  const allocations = components.map((item, index) => describe(item, references[index], subtotals[index]));

  return {
    ok: true,
    referenceTotalMinor: Number(referenceTotal),
    targetPriceMinor: input.targetPriceMinor,
    discountTotalMinor: Number(referenceTotal - target),
    discountBps: roundedBps(referenceTotal - target, referenceTotal),
    components: allocations.map(({ allocation }) => allocation),
    lines: allocations.flatMap(({ lines }) => lines),
    floorApplied,
  };
}

/**
 * Split `target` over the open components, pin every component whose share landed
 * under its floor, and re-split the rest until no further component is pinned.
 * Terminates: each round either pins at least one component or is the last one, and
 * at least one component always survives, because a round where every open share
 * fell under its floor would mean the shares sum below a floor total the caller
 * already proved the target covers.
 */
function splitAgainstFloors(
  target: bigint,
  references: readonly bigint[],
  floors: readonly bigint[],
  codes: readonly string[],
): { subtotals: bigint[]; floorApplied: boolean } {
  const subtotals = references.map(() => 0n);
  const pinned = references.map(() => false);
  let floorApplied = false;

  for (;;) {
    const open = references.map((_, index) => index).filter((index) => !pinned[index]);
    const pinnedTotal = references.reduce(
      (total, _, index) => (pinned[index] ? total + floors[index] : total),
      0n,
    );
    const shares = largestRemainder(
      target - pinnedTotal,
      open.map((index) => references[index]),
      open.map((index) => codes[index]),
    );
    const underFloor = open.filter((index, slot) => shares[slot] < floors[index]);
    if (underFloor.length > 0) {
      for (const index of underFloor) pinned[index] = true;
      floorApplied = true;
      continue;
    }
    open.forEach((index, slot) => { subtotals[index] = shares[slot]; });
    pinned.forEach((isPinned, index) => { if (isPinned) subtotals[index] = floors[index]; });
    return { subtotals, floorApplied };
  }
}

/**
 * Hamilton split: proportional floor first, then hand the rounding deficit to the
 * largest remainders, ties broken by ascending component code so the outcome never
 * depends on input order or host collation.
 */
function largestRemainder(amount: bigint, weights: readonly bigint[], codes: readonly string[]): bigint[] {
  const total = weights.reduce(add, 0n);
  const shares = weights.map((weight) => (amount * weight) / total);
  const remainders = weights.map((weight) => (amount * weight) % total);
  const order = weights
    .map((_, index) => index)
    .sort((left, right) => (remainders[left] === remainders[right]
      ? compareCodeUnits(codes[left], codes[right])
      : (remainders[left] > remainders[right] ? -1 : 1)));

  let deficit = amount - shares.reduce(add, 0n);
  for (const index of order) {
    if (deficit === 0n) break;
    shares[index] += 1n;
    deficit -= 1n;
  }
  return shares;
}

function describe(
  item: BundleComponentInput,
  reference: bigint,
  subtotal: bigint,
): { allocation: BundleComponentAllocation; lines: BundleAllocatedLine[] } {
  const quantity = BigInt(item.quantity);
  const unit = subtotal / quantity;
  const remainder = subtotal - unit * quantity;
  const lines = remainder === 0n
    ? [line(item.sku, quantity, unit)]
    : [line(item.sku, remainder, unit + 1n), line(item.sku, quantity - remainder, unit)];

  return {
    allocation: {
      sku: item.sku,
      quantity: item.quantity,
      referenceUnitPriceMinor: item.unitPriceMinor,
      referenceSubtotalMinor: Number(reference),
      targetSubtotalMinor: Number(subtotal),
      discountAllocatedMinor: Number(reference - subtotal),
      discountBps: roundedBps(reference - subtotal, reference),
      hasSplitPricing: remainder !== 0n,
    },
    lines,
  };
}

function line(sku: string, quantity: bigint, unit: bigint): BundleAllocatedLine {
  return {
    sku,
    quantity: Number(quantity),
    effectiveUnitPriceMinor: Number(unit),
    lineSubtotalMinor: Number(quantity * unit),
  };
}

function validateInput(input: AllocateBundleTargetPriceInput): BundleComponentInput[] {
  if (!Array.isArray(input.components) || input.components.length === 0) {
    throw new RangeError("components must be a non-empty array");
  }
  assertMinor("targetPriceMinor", input.targetPriceMinor, 0);
  assertMinor(
    "minimumUnitPayableMinor",
    input.minimumUnitPayableMinor ?? DEFAULT_MINIMUM_UNIT_PAYABLE_MINOR,
    0,
  );

  const seen = new Set<string>();
  for (const item of input.components) {
    if (typeof item.sku !== "string" || !item.sku.trim()) {
      throw new RangeError("every component requires a code");
    }
    if (seen.has(item.sku)) throw new RangeError(`duplicate component code ${item.sku}`);
    seen.add(item.sku);
    assertMinor("quantity", item.quantity, 1);
    assertMinor("unitPriceMinor", item.unitPriceMinor, 0);
  }
  return [...input.components];
}

function assertMinor(name: string, value: number, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${name} must be a safe integer >= ${minimum}`);
  }
}

function assertSafe(name: string, value: bigint): void {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${name} must stay inside the safe integer range`);
  }
}

function roundedBps(amount: bigint, reference: bigint): number {
  if (reference === 0n) return 0;
  return Number((amount * 20_000n + reference) / (reference * 2n));
}

function add(total: bigint, value: bigint): bigint {
  return total + value;
}

// Component codes are unique by validation, so an equal pair never reaches the sort.
function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : 1;
}
