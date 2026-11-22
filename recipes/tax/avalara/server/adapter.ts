import { createHash } from "node:crypto";
import {
  CatalogueMoneyV2Error,
  calculateCatalogueMoneyV2,
  planCatalogueMoneyV2,
  type CatalogueMoneyV2Tax,
} from "@openlup/core/pricing";
import {
  reconcileTaxCoverage,
  verifyTaxQuoteRequest,
  verifyTaxQuoteResult,
} from "@openlup/platform/tax";
import {
  TAX_CALCULATION_CONTRACT_VERSION,
  type TaxCalculationEvidenceV1,
  type TaxCalculationPortV1,
  type TaxCalculationRefV1,
  type TaxCapabilitiesV1,
  type TaxCloseReasonV1,
  type TaxCloseResultV1,
  type TaxCommitRequestV1,
  type TaxCommitResultV1,
  type TaxCoverageInputV1,
  type TaxFiscalValidityResultV1,
  type TaxQuoteRequestV1,
  type TaxQuoteResultV1,
  type TaxRefusal,
  type TaxReverseRequestV1,
  type TaxReverseResultV1,
  type TaxScopeV1,
} from "@openlup/platform/tax/contracts";
import {
  AvalaraTransportError,
  assertSafeAvalaraPathSegment,
  type AvalaraAddress,
  type AvalaraClient,
  type AvalaraCreateTransactionPayload,
  type AvalaraTaxDetail,
  type AvalaraTransactionLineInput,
  type AvalaraTransactionResponse,
} from "./client-contract.js";
import {
  buildAvalaraCommitCode,
  buildAvalaraReversalCode,
  computeEvidenceDigest,
  computeFiscalDigest,
  computeResolutionDigest,
  fractionalRateToPercentString,
  getCurrencyExponent,
  majorToMinorAmount,
  minorToMajorAmount,
  taxTaggedDigest,
} from "./digests.js";

export const AVALARA_ADAPTER_NAME = "avalara" as const;
export const AVALARA_ADAPTER_VERSION = "1" as const;
export const DEFAULT_AVALARA_CALCULATION_LIFETIME_MS = 86_400_000;

const MAX_RETAINED_RECORDS = 2048;

export interface AvalaraStaticTaxCapabilities {
  readonly adapter: typeof AVALARA_ADAPTER_NAME;
  readonly adapterVersion: typeof AVALARA_ADAPTER_VERSION;
  readonly markets: readonly string[];
  readonly currencies: readonly string[];
  readonly bases: readonly ["exclusive"];
  readonly sourcing: readonly ("destination" | "ship_from")[];
  readonly evidence: Readonly<{ lines: boolean; delivery: boolean; fees: boolean }>;
  readonly registrations: "effective_intervals";
  readonly validity: "probe_by_recalculation";
  readonly calculationLifetimeMs: number;
  readonly posting: "provider";
  readonly reversals: readonly ("full" | "lines")[];
  readonly recovery: readonly ("commit" | "reverse")[];
}

export const avalaraStaticTaxCapabilities: Readonly<AvalaraStaticTaxCapabilities> = Object.freeze({
  adapter: AVALARA_ADAPTER_NAME,
  adapterVersion: AVALARA_ADAPTER_VERSION,
  markets: Object.freeze([]),
  currencies: Object.freeze([]),
  bases: Object.freeze(["exclusive"] as const),
  sourcing: Object.freeze(["destination", "ship_from"] as const),
  evidence: Object.freeze({ lines: true, delivery: true, fees: true }),
  registrations: "effective_intervals",
  validity: "probe_by_recalculation",
  calculationLifetimeMs: DEFAULT_AVALARA_CALCULATION_LIFETIME_MS,
  posting: "provider",
  reversals: Object.freeze(["full", "lines"] as const),
  recovery: Object.freeze(["commit", "reverse"] as const),
});

export function projectAvalaraTaxStaticCapabilities(): AvalaraStaticTaxCapabilities {
  return JSON.parse(JSON.stringify(avalaraStaticTaxCapabilities)) as AvalaraStaticTaxCapabilities;
}

export interface AvalaraJurisdictionBinding {
  readonly jurisdiction: string;
  readonly level: string;
  readonly taxKind: string;
  readonly sourcing: "destination" | "ship_from";
  readonly country: string;
  readonly region?: string;
  readonly jurisType?: string;
  readonly taxType?: string;
  readonly taxSubTypeId?: string;
}

export interface AvalaraRegistrationRecord {
  readonly jurisdiction: string;
  readonly taxKind: string;
  readonly state: "active" | "inactive";
  readonly effective: Readonly<{ from: string; until?: string }>;
  readonly evidenceRef: string;
}

export interface AvalaraFeeBinding {
  readonly jurisdiction: string;
  readonly taxKind: string;
  readonly feeKey: string;
  readonly feeKind: string;
  readonly refundRule: Readonly<{ ref: string; revision: string }>;
  readonly taxType: string;
  readonly taxSubTypeId?: string;
}

export interface AvalaraMarketPack {
  readonly markets: readonly string[];
  readonly currencies: readonly string[];
  readonly taxCodes: Readonly<Record<string, string>>;
  readonly shipFromOrigins: Readonly<Record<string, AvalaraAddress>>;
  readonly jurisdictions: readonly AvalaraJurisdictionBinding[];
  readonly registrations: readonly AvalaraRegistrationRecord[];
  readonly feeBindings?: readonly AvalaraFeeBinding[];
}

export interface CreateAvalaraTaxAdapterOptions {
  readonly client: AvalaraClient;
  readonly companyCode: string;
  readonly scope: TaxScopeV1;
  readonly marketPack: AvalaraMarketPack;
  readonly clock: () => string;
  readonly calculationLifetimeMs?: number;
  /** Optional host capture-reservation guard invoked before sending a SalesInvoice commit. */
  readonly hasCommitReservation?: (request: TaxCommitRequestV1) => boolean;
}

type FinalQuote = Extract<TaxQuoteResultV1, { kind: "final" }>;
type ProviderTax = Extract<CatalogueMoneyV2Tax, { kind: "provider" }>;
type ProviderComponent = ProviderTax["components"][number];
type ProviderComponentState = ProviderComponent["states"][number];
type CoverageCell = TaxCoverageInputV1["required"][number];
type CoverageObservation = TaxCoverageInputV1["observations"][number];

interface StoredQuote {
  readonly request: TaxQuoteRequestV1;
  readonly result: FinalQuote;
  readonly shipFrom: AvalaraAddress;
  readonly shipTo: AvalaraAddress;
  readonly customerCode: string;
  readonly finalLines: readonly AvalaraTransactionLineInput[];
  readonly originalPositionRefs: readonly string[];
}

interface StoredCommit {
  readonly bindingDigest: string;
  readonly result: Extract<TaxCommitResultV1, { kind: "committed" }>;
  readonly providerCode: string;
  readonly quote: StoredQuote;
  readonly payableMinor: number;
  refundedMinor: number;
}

interface StoredReversal {
  readonly bindingDigest: string;
  readonly result: Extract<TaxReverseResultV1, { kind: "reversed" }>;
}

function boundedSet<K, V>(map: Map<K, V>, key: K, value: V, maxEntries: number): void {
  if (map.has(key)) {
    map.delete(key);
  } else if (map.size >= maxEntries) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

function refuse(
  code: TaxRefusal["code"],
  field: string,
  remedy: string,
  extra?: Readonly<{ jurisdiction?: string; taxKind?: string }>,
): TaxRefusal {
  return {
    kind: "refused",
    code,
    field,
    remedy,
    ...(extra?.jurisdiction ? { jurisdiction: extra.jurisdiction } : {}),
    ...(extra?.taxKind ? { taxKind: extra.taxKind } : {}),
  };
}

function sameScope(a: TaxScopeV1, b: TaxScopeV1): boolean {
  return (
    a.adapter === b.adapter &&
    a.adapterVersion === b.adapterVersion &&
    a.accountRef === b.accountRef &&
    a.mode === b.mode
  );
}

function includesInstant(interval: Readonly<{ from: string; until?: string }>, instantIso: string): boolean {
  return interval.from <= instantIso && (interval.until === undefined || instantIso < interval.until);
}

function toCanonicalUtcInstant(value: string): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new Error("avalara_invalid_clock_instant");
  }
  return new Date(ms).toISOString();
}

function pointEffectiveInterval(taxDateIso: string): Readonly<{ from: string; until: string }> {
  const ms = Date.parse(taxDateIso);
  return {
    from: new Date(ms).toISOString(),
    until: new Date(ms + 1).toISOString(),
  };
}

function toAvalaraShipTo(address: TaxQuoteRequestV1["input"]["destination"]["address"]): AvalaraAddress {
  return {
    line1: address.line1,
    ...(address.line2 ? { line2: address.line2 } : {}),
    city: address.city,
    ...(address.subdivisionCode ? { region: address.subdivisionCode } : {}),
    postalCode: address.postalCode,
    country: address.countryCode,
  };
}

function buildOpaqueCustomerCode(destinationSnapshotRef: string): string {
  const hash = createHash("sha256").update(destinationSnapshotRef, "utf8").digest("hex");
  return `ol-cust-${hash.slice(0, 24)}`;
}

function cellIdentityKey(cell: CoverageCell): string {
  return JSON.stringify([
    cell.target.kind,
    cell.target.key,
    cell.target.kind === "fee" ? (cell.target.deliveryKey ?? "") : "",
    cell.jurisdiction,
    cell.level,
    cell.taxKind,
    cell.sourcing,
  ]);
}

function detailMatchesBinding(detail: AvalaraTaxDetail, binding: AvalaraJurisdictionBinding): boolean {
  if (binding.country.toUpperCase() !== detail.country.toUpperCase()) return false;
  if (binding.region !== undefined && (detail.region ?? "").toUpperCase() !== binding.region.toUpperCase()) {
    return false;
  }
  if (binding.jurisType !== undefined && detail.jurisType.toUpperCase() !== binding.jurisType.toUpperCase()) {
    return false;
  }
  if (binding.taxType !== undefined && detail.taxType.toUpperCase() !== binding.taxType.toUpperCase()) {
    return false;
  }
  if (
    binding.taxSubTypeId !== undefined &&
    (detail.taxSubTypeId ?? "").toUpperCase() !== binding.taxSubTypeId.toUpperCase()
  ) {
    return false;
  }
  return true;
}

function detailMatchesFeeBinding(detail: AvalaraTaxDetail, binding: AvalaraFeeBinding): boolean {
  if (detail.taxType.toUpperCase() !== binding.taxType.toUpperCase()) return false;
  if (
    binding.taxSubTypeId !== undefined &&
    (detail.taxSubTypeId ?? "").toUpperCase() !== binding.taxSubTypeId.toUpperCase()
  ) {
    return false;
  }
  return true;
}

function isMissingTaxClassField(field: string): boolean {
  return /^\/input\/(?:lines|delivery|required)\/\d+\/(?:target\/)?taxClass$/u.test(field);
}

/**
 * Create a zero-SDK Avalara AvaTax REST v2 `TaxCalculationPortV1` adapter implementing
 * exclusive tax calculation, multi-step discount snapshots, retail delivery fees,
 * recalculation-based renewal probing, effect-free local close, idempotent `SalesInvoice`
 * commit, `ReturnInvoice` partial/remainder reversals, and `DocVoided` full voids.
 */
export function createAvalaraTaxAdapter(options: CreateAvalaraTaxAdapterOptions): TaxCalculationPortV1 {
  const companyCode = assertSafeAvalaraPathSegment(options.companyCode, "company_code");
  const calculationLifetimeMs = options.calculationLifetimeMs ?? DEFAULT_AVALARA_CALCULATION_LIFETIME_MS;
  if (!Number.isSafeInteger(calculationLifetimeMs) || calculationLifetimeMs <= 0) {
    throw new Error("avalara_invalid_calculation_lifetime_ms");
  }
  if (options.scope.adapter !== AVALARA_ADAPTER_NAME || options.scope.adapterVersion !== AVALARA_ADAPTER_VERSION) {
    throw new Error("avalara_invalid_scope_adapter");
  }

  const markets = [...options.marketPack.markets];
  const currencies = [...options.marketPack.currencies];
  const feeBindings = options.marketPack.feeBindings ?? [];

  const quotesByRef = new Map<string, StoredQuote>();
  const closedByRef = new Map<string, { readonly ref: TaxCalculationRefV1; readonly key: string }>();
  const commitsByTxRef = new Map<string, StoredCommit>();
  const commitsByProviderCode = new Map<string, StoredCommit>();
  const reversalsByRef = new Map<string, StoredReversal>();

  const capabilities: TaxCapabilitiesV1 = Object.freeze({
    scope: Object.freeze({ ...options.scope }),
    markets: Object.freeze([...markets]),
    currencies: Object.freeze([...currencies]),
    bases: Object.freeze(["exclusive"] as const),
    sourcing: Object.freeze(["destination", "ship_from"] as const),
    evidence: Object.freeze({ lines: true, delivery: true, fees: true }),
    registrations: "effective_intervals",
    validity: "probe_by_recalculation",
    calculationLifetimeMs,
    posting: "provider",
    reversals: Object.freeze(["full", "lines"] as const),
    recovery: Object.freeze(["commit", "reverse"] as const),
  });

  function findRegistration(jurisdiction: string, taxKind: string, taxDate: string) {
    return options.marketPack.registrations.find(
      (reg) =>
        reg.jurisdiction === jurisdiction &&
        reg.taxKind === taxKind &&
        includesInstant(reg.effective, taxDate),
    );
  }

  function findFeeBinding(jurisdiction: string, taxKind: string): AvalaraFeeBinding | undefined {
    return feeBindings.find((b) => b.jurisdiction === jurisdiction && b.taxKind === taxKind);
  }

  function findJurisdictionBinding(cell: CoverageCell): AvalaraJurisdictionBinding | undefined {
    return options.marketPack.jurisdictions.find(
      (b) =>
        b.jurisdiction === cell.jurisdiction &&
        b.level === cell.level &&
        b.taxKind === cell.taxKind &&
        b.sourcing === cell.sourcing,
    );
  }

  return {
    contractVersion: TAX_CALCULATION_CONTRACT_VERSION,

    capabilities(): TaxCapabilitiesV1 {
      return capabilities;
    },

    async quote(request: TaxQuoteRequestV1): Promise<TaxQuoteResultV1> {
      // 1. Validate canonical request before any I/O.
      const requestError = verifyTaxQuoteRequest(request);
      if (requestError) {
        if (requestError.code === "tax_invalid_input" && isMissingTaxClassField(requestError.field)) {
          return refuse(
            "tax_class_missing",
            requestError.field,
            "Assign a configured taxClass to every line, delivery bucket, and fee cell.",
          );
        }
        return requestError;
      }

      const { input } = request;

      // 2. Scope, market, currency, and exclusive basis checks (0 I/O).
      if (!sameScope(input.scope, options.scope)) {
        return refuse("tax_scope_mismatch", "/input/scope", "Match the configured Avalara tax scope.");
      }
      if (!markets.includes(input.market)) {
        return refuse("tax_scope_mismatch", "/input/market", "Use a market configured on this Avalara tax adapter.");
      }
      const exponent = getCurrencyExponent(input.currency);
      if (!currencies.includes(input.currency) || exponent === null) {
        return refuse(
          "tax_scope_mismatch",
          "/input/currency",
          "Use an ISO-4217 currency configured on this Avalara tax adapter.",
        );
      }
      if (input.money.amountBasis !== "exclusive") {
        return refuse(
          "tax_scope_mismatch",
          "/input/money/amountBasis",
          "Use exclusive amountBasis for tax calculation v1.",
        );
      }

      // 3. Tax class -> Avalara taxCode validation (0 I/O).
      const lineByKey = new Map(input.lines.map((line) => [line.lineKey, line]));
      for (let i = 0; i < input.lines.length; i += 1) {
        const line = input.lines[i]!;
        if (!Object.hasOwn(options.marketPack.taxCodes, line.taxClass)) {
          return refuse(
            "tax_class_missing",
            `/input/lines/${i}/taxClass`,
            "Map every merchandise taxClass to an Avalara taxCode in marketPack.taxCodes.",
          );
        }
      }
      const deliveryByKey = new Map(input.delivery.map((d) => [d.bucketKey, d]));
      for (let i = 0; i < input.delivery.length; i += 1) {
        const del = input.delivery[i]!;
        if (!Object.hasOwn(options.marketPack.taxCodes, del.taxClass)) {
          return refuse(
            "tax_class_missing",
            `/input/delivery/${i}/taxClass`,
            "Map every delivery taxClass to an Avalara taxCode in marketPack.taxCodes.",
          );
        }
      }
      for (let i = 0; i < input.required.length; i += 1) {
        const cell = input.required[i]!;
        if (cell.target.kind === "fee" && !Object.hasOwn(options.marketPack.taxCodes, cell.target.taxClass)) {
          return refuse(
            "tax_class_missing",
            `/input/required/${i}/target/taxClass`,
            "Map every fee taxClass in marketPack.taxCodes.",
          );
        }
      }

      // 4. Ship-from origin & jurisdiction/fee rule presence checks (0 I/O).
      const shipFrom = Object.hasOwn(options.marketPack.shipFromOrigins, input.shipFromRef)
        ? options.marketPack.shipFromOrigins[input.shipFromRef]
        : undefined;
      if (!shipFrom) {
        return refuse(
          "tax_rule_missing",
          "/input/shipFromRef",
          "Configure the shipFromRef origin address in marketPack.shipFromOrigins.",
        );
      }
      for (let i = 0; i < input.required.length; i += 1) {
        const cell = input.required[i]!;
        if (cell.target.kind === "fee") {
          if (!findFeeBinding(cell.jurisdiction, cell.taxKind)) {
            return refuse(
              "tax_rule_missing",
              `/input/required/${i}`,
              "Configure an explicit feeBinding for every required fee cell.",
              { jurisdiction: cell.jurisdiction, taxKind: cell.taxKind },
            );
          }
        } else if (!findJurisdictionBinding(cell)) {
          return refuse(
            "tax_rule_missing",
            `/input/required/${i}`,
            "Configure a jurisdiction binding for every required tax cell.",
            { jurisdiction: cell.jurisdiction, taxKind: cell.taxKind },
          );
        }
      }

      // 5. Plan CatalogueMoneyV2 discount sequences (0 I/O).
      let plan;
      try {
        plan = planCatalogueMoneyV2(input.money);
      } catch (error) {
        if (error instanceof CatalogueMoneyV2Error) {
          return refuse(
            error.code === "money_amount_out_of_range" ? "tax_amount_out_of_range" : "tax_invalid_input",
            `/input/money/${error.field.replace(/\[(\d+)\]/gu, ".$1").replaceAll(".", "/")}`,
            error.remedy,
          );
        }
        throw error;
      }

      // 6. Inspect coverage declarations & registrations to see if any cell needs live Avalara assessment.
      const declByCoord = new Map<string, TaxQuoteRequestV1["input"]["coverage"]["declarations"][number]>();
      for (const decl of input.coverage.declarations) {
        if (includesInstant(decl.effective, input.taxDate)) {
          declByCoord.set(`${decl.jurisdiction}\0${decl.taxKind}`, decl);
        }
      }

      let hasAnyRegisteredCell = false;
      let hasUndeclaredOrInactiveConflict = false;
      for (const cell of input.required) {
        const decl = declByCoord.get(`${cell.jurisdiction}\0${cell.taxKind}`);
        const reg = findRegistration(cell.jurisdiction, cell.taxKind, input.taxDate);
        if (!decl) {
          hasUndeclaredOrInactiveConflict = true;
        } else if (decl.status === "registered") {
          if (reg?.state === "active") {
            hasAnyRegisteredCell = true;
          } else {
            hasUndeclaredOrInactiveConflict = true;
          }
        }
      }

      const shipTo = toAvalaraShipTo(input.destination.address);
      const customerCode = buildOpaqueCustomerCode(input.destination.snapshotRef);

      // Build stage sequence list: [0, ...distinct positive allocation sequences across all components]
      const distinctSequences = [
        ...new Set(
          plan.components.flatMap((c) =>
            c.allocations.filter((a) => a.basisReductionMinor > 0).map((a) => a.sequence),
          ),
        ),
      ].sort((a, b) => a - b);
      const sequences = [0, ...distinctSequences];

      // Pre-compute component identity and exact amountMinor at any discount sequence
      const componentKeys = plan.components.map((c) => ({
        planComp: c,
        ref: c.ref,
        lineNumber: c.ref.kind === "merchandise" ? `ol-m-${c.ref.lineKey}` : `ol-d-${c.ref.bucketKey}`,
        preDiscountMinor: c.preDiscountMinor,
      }));

      const amountAtSequence = (
        comp: (typeof componentKeys)[number],
        seq: number,
      ): number => {
        if (seq === 0) return comp.preDiscountMinor;
        let current = comp.preDiscountMinor;
        for (const alloc of comp.planComp.allocations) {
          if (alloc.sequence <= seq && alloc.basisReductionMinor > 0) {
            current = alloc.afterMinor;
          }
        }
        return current;
      };

      const buildStageLines = (seq: number): AvalaraTransactionLineInput[] => {
        const resultLines: AvalaraTransactionLineInput[] = [];
        for (const comp of componentKeys) {
          const stageNetMinor = amountAtSequence(comp, seq);
          if (comp.ref.kind === "merchandise") {
            const lineMeta = lineByKey.get(comp.ref.lineKey)!;
            resultLines.push({
              number: comp.lineNumber,
              quantity: 1,
              amount: minorToMajorAmount(stageNetMinor, exponent),
              taxCode: options.marketPack.taxCodes[lineMeta.taxClass],
              itemCode: lineMeta.sku,
              taxIncluded: false,
            });
          } else {
            const delMeta = deliveryByKey.get(comp.ref.bucketKey)!;
            resultLines.push({
              number: comp.lineNumber,
              quantity: 1,
              amount: minorToMajorAmount(stageNetMinor, exponent),
              taxCode: options.marketPack.taxCodes[delMeta.taxClass],
              itemCode: `delivery:${delMeta.bucketKey}`,
              taxIncluded: false,
            });
          }
        }
        return resultLines;
      };

      // 7. Short-circuit preflight coverage refusal or pure out-of-scope at 0 HTTP calls.
      if (!hasAnyRegisteredCell || hasUndeclaredOrInactiveConflict) {
        const preObservations: CoverageObservation[] = input.required.map((cell) => {
          const decl = declByCoord.get(`${cell.jurisdiction}\0${cell.taxKind}`);
          const reg = findRegistration(cell.jurisdiction, cell.taxKind, input.taxDate);
          return {
            cell,
            ...(reg ? { registration: { state: reg.state, effective: reg.effective, evidenceRef: reg.evidenceRef } } : {}),
            ...(decl?.status === "not_registered_acknowledged"
              ? { treatment: { kind: "not_applicable" as const, reason: "not_registered", ruleRef: `avalara:not_reg:${cell.jurisdiction}:${cell.taxKind}` } }
              : {}),
            assessedMinor: 0,
          };
        });
        const preCoverage = reconcileTaxCoverage({
          scope: input.scope,
          taxDate: input.taxDate,
          coverage: input.coverage,
          required: input.required,
          observations: preObservations,
        });
        if (preCoverage.kind === "refused") {
          return {
            kind: "refused",
            code: preCoverage.code,
            field: preCoverage.field,
            remedy: preCoverage.remedy,
            ...(preCoverage.jurisdiction ? { jurisdiction: preCoverage.jurisdiction } : {}),
            ...(preCoverage.taxKind ? { taxKind: preCoverage.taxKind } : {}),
            coverage: { vector: preCoverage.vector, digest: preCoverage.digest },
          };
        }
        if (preCoverage.kind === "unavailable") {
          return {
            kind: "unavailable",
            code: preCoverage.code,
            effect: preCoverage.effect,
            coverage: { vector: preCoverage.vector, digest: preCoverage.digest },
          };
        }
        if (preCoverage.posting === "skip") {
          // Pure out-of-scope: zero assessments, zero fees, zero HTTP calls.
          const emptyComponents: ProviderComponent[] = componentKeys.map((c) => {
            const compStates: ProviderComponentState[] = [
              { afterSequence: 0, amountMinor: c.preDiscountMinor, taxPositions: [] },
              ...c.planComp.allocations
                .filter((a) => a.basisReductionMinor > 0)
                .map((a) => ({ afterSequence: a.sequence, amountMinor: a.afterMinor, taxPositions: [] })),
            ];
            return { ref: c.ref, states: compStates };
          });
          const totalNet = componentKeys.reduce((sum, c) => sum + c.planComp.effectiveMinor, 0);
          const money = calculateCatalogueMoneyV2(
            { ...input.money, fees: [] },
            {
              kind: "provider",
              payableMinor: totalNet,
              components: emptyComponents,
            },
          );
          const calculatedAt = toCanonicalUtcInstant(options.clock());
          const expiresAt = new Date(Date.parse(calculatedAt) + calculationLifetimeMs).toISOString();
          const fiscalDigest = computeFiscalDigest({
            scope: input.scope,
            destinationDigest: input.destination.digest,
            shipFromRef: input.shipFromRef,
            policyRevision: input.policyRevision,
            classMapRevision: input.classMapRevision,
            coverage: preCoverage.vector,
            tax: [],
            fees: [],
          });
          const calcRef = `avalara-oos-${taxTaggedDigest("avalara.calc.v1", [request.key, request.inputDigest, fiscalDigest]).slice(0, 24)}`;
          const providerLines = input.lines.map((line) => ({
            lineKey: line.lineKey,
            providerLineRef: `ol-m-${line.lineKey}`,
          }));
          const evidence: TaxCalculationEvidenceV1 = {
            requestKey: request.key,
            scope: input.scope,
            calculationRef: calcRef,
            status: input.purpose,
            calculatedAt,
            expiresAt,
            taxDate: input.taxDate,
            destinationDigest: input.destination.digest,
            shipFromRef: input.shipFromRef,
            inputDigest: request.inputDigest,
            policyRevision: input.policyRevision,
            classMapRevision: input.classMapRevision,
            coverage: { vector: preCoverage.vector, digest: preCoverage.digest },
            fiscalDigest,
            providerLines,
            positions: { tax: [], fees: [] },
          };
          const evidenceDigest = computeEvidenceDigest(evidence);
          const success = {
            kind: input.purpose,
            money,
            evidence,
            evidenceDigest,
          } as TaxQuoteResultV1;
          const verifiedErr = verifyTaxQuoteResult(request, success);
          if (verifiedErr) return verifiedErr;
          if (success.kind === "final") {
            boundedSet(
              quotesByRef,
              calcRef,
              {
                request,
                result: success,
                shipFrom,
                shipTo,
                customerCode,
                finalLines: buildStageLines(sequences[sequences.length - 1]!),
                originalPositionRefs: [],
              },
              MAX_RETAINED_RECORDS,
            );
          }
          return success;
        }
      }

      // 8. Execute SalesOrder quote calls against Avalara (one per discount sequence).
      const stageResponses: { readonly sequence: number; readonly lines: readonly AvalaraTransactionLineInput[]; readonly response: AvalaraTransactionResponse }[] = [];
      for (const seq of sequences) {
        const stageLines = buildStageLines(seq);
        const payload: AvalaraCreateTransactionPayload = {
          companyCode,
          type: "SalesOrder",
          commit: false,
          date: input.taxDate.slice(0, 10),
          customerCode,
          currencyCode: input.currency,
          addresses: {
            shipFrom,
            shipTo,
          },
          lines: stageLines,
        };
        let response: AvalaraTransactionResponse;
        try {
          response = await options.client.createTransaction(payload);
        } catch (error) {
          if (error instanceof AvalaraTransportError) {
            return {
              kind: "unavailable",
              code: "tax_adapter_unavailable",
              effect: "none",
            };
          }
          return {
            kind: "unavailable",
            code: "tax_adapter_unavailable",
            effect: "none",
          };
        }

        // Strict echo verification on Avalara SalesOrder response
        if (response.currencyCode !== input.currency) {
          return refuse(
            "tax_breakdown_incomplete",
            "/input/currency",
            "Avalara response currencyCode did not match requested currency.",
          );
        }
        const sentLineNumbers = new Set(stageLines.map((l) => l.number));
        const seenResponseLines = new Set<string>();
        for (const respLine of response.lines) {
          if (respLine.taxIncluded === true) {
            return refuse(
              "tax_scope_mismatch",
              "/input/money/amountBasis",
              "Avalara returned taxIncluded=true for an exclusive tax request.",
            );
          }
          if (!sentLineNumbers.has(respLine.lineNumber) || seenResponseLines.has(respLine.lineNumber)) {
            return refuse(
              "tax_breakdown_incomplete",
              "/input/lines",
              "Avalara response lines did not match sent transaction lines 1:1.",
            );
          }
          seenResponseLines.add(respLine.lineNumber);
        }
        if (seenResponseLines.size !== sentLineNumbers.size) {
          return refuse(
            "tax_breakdown_incomplete",
            "/input/lines",
            "Avalara response omitted one or more requested lines.",
          );
        }

        stageResponses.push({ sequence: seq, lines: stageLines, response });
      }

      // 9. Project final stage response into coverage observations, money positions, fees, and evidence.
      const finalStage = stageResponses[stageResponses.length - 1]!;
      const finalRespLineByNumber = new Map(finalStage.response.lines.map((l) => [l.lineNumber, l]));
      const effectiveInterval = pointEffectiveInterval(input.taxDate);

      // Build observations for reconcileTaxCoverage from final stage Avalara details
      const observations: CoverageObservation[] = [];
      const feeFinalEntries: {
        readonly cell: CoverageCell;
        readonly binding: AvalaraFeeBinding;
        readonly amountMinor: number;
        readonly detail: AvalaraTaxDetail;
      }[] = [];

      const taxCellBindings = new Map<string, { readonly cell: CoverageCell; readonly binding: AvalaraJurisdictionBinding }>();

      for (const cell of input.required) {
        const reg = findRegistration(cell.jurisdiction, cell.taxKind, input.taxDate);
        const decl = declByCoord.get(`${cell.jurisdiction}\0${cell.taxKind}`);
        const registration = reg
          ? { state: reg.state, effective: reg.effective, evidenceRef: reg.evidenceRef }
          : undefined;

        if (cell.target.kind === "fee") {
          const feeBinding = findFeeBinding(cell.jurisdiction, cell.taxKind)!;
          const targetLineNumber =
            cell.target.deliveryKey !== undefined ? `ol-d-${cell.target.deliveryKey}` : null;
          const candidateLines = targetLineNumber
            ? [finalRespLineByNumber.get(targetLineNumber)].filter(
                (l): l is NonNullable<typeof l> => Boolean(l),
              )
            : finalStage.response.lines;
          const matchedFeeDetails: AvalaraTaxDetail[] = [];
          for (const respLine of candidateLines) {
            for (const detail of respLine.details) {
              if (detailMatchesFeeBinding(detail, feeBinding)) {
                matchedFeeDetails.push(detail);
              }
            }
          }
          const feeMinor = matchedFeeDetails.reduce(
            (sum, d) => sum + majorToMinorAmount(d.tax, exponent),
            0,
          );
          if (decl?.status === "not_registered_acknowledged") {
            observations.push({
              cell,
              ...(registration ? { registration } : {}),
              treatment: {
                kind: "not_applicable",
                reason: "not_registered",
                ruleRef: `avalara:not_reg:${cell.jurisdiction}:${cell.taxKind}`,
              },
              assessedMinor: feeMinor,
            });
          } else if (feeMinor > 0 && matchedFeeDetails.length > 0) {
            const firstDetail = matchedFeeDetails[0]!;
            observations.push({
              cell,
              ...(registration ? { registration } : {}),
              treatment: {
                kind: "taxable",
                reason: "fee_assessed",
                ruleRef: `avalara:fee:${feeBinding.feeKey}`,
              },
              assessedMinor: feeMinor,
            });
            feeFinalEntries.push({
              cell,
              binding: feeBinding,
              amountMinor: feeMinor,
              detail: firstDetail,
            });
          } else {
            observations.push({
              cell,
              ...(registration ? { registration } : {}),
              treatment: {
                kind: "not_applicable",
                reason: "fee_not_applicable",
                ruleRef: `avalara:fee:${feeBinding.feeKey}`,
              },
              assessedMinor: 0,
            });
          }
          continue;
        }

        const binding = findJurisdictionBinding(cell)!;
        taxCellBindings.set(cellIdentityKey(cell), { cell, binding });
        const lineNumber =
          cell.target.kind === "line" ? `ol-m-${cell.target.key}` : `ol-d-${cell.target.key}`;
        const respLine = finalRespLineByNumber.get(lineNumber);
        const matchingDetails = (respLine?.details ?? []).filter(
          (d) =>
            detailMatchesBinding(d, binding) &&
            !feeBindings.some((fb) => detailMatchesFeeBinding(d, fb)),
        );

        const assessedMinor = matchingDetails.reduce(
          (sum, d) => sum + majorToMinorAmount(d.tax, exponent),
          0,
        );
        const exemptMinor = matchingDetails.reduce(
          (sum, d) => sum + majorToMinorAmount(d.exemptAmount ?? 0, exponent),
          0,
        );
        const nonTaxableMinor = matchingDetails.reduce(
          (sum, d) => sum + majorToMinorAmount(d.nonTaxableAmount ?? 0, exponent),
          0,
        );

        if (decl?.status === "not_registered_acknowledged") {
          observations.push({
            cell,
            ...(registration ? { registration } : {}),
            treatment: {
              kind: "not_applicable",
              reason: "not_registered",
              ruleRef: `avalara:not_reg:${cell.jurisdiction}:${cell.taxKind}`,
            },
            assessedMinor,
          });
        } else if (assessedMinor === 0 && (exemptMinor > 0 || nonTaxableMinor > 0)) {
          const ruleId = matchingDetails[0]?.nonTaxableRuleId ?? matchingDetails[0]?.rateRuleId ?? 0;
          observations.push({
            cell,
            ...(registration ? { registration } : {}),
            treatment: {
              kind: "exempt",
              reason: "exempt_product_or_entity",
              ruleRef: `avalara:exempt:${cell.jurisdiction}:${ruleId}`,
            },
            assessedMinor: 0,
          });
        } else {
          const ruleId = matchingDetails[0]?.rateRuleId ?? 0;
          observations.push({
            cell,
            ...(registration ? { registration } : {}),
            treatment: {
              kind: "taxable",
              reason: "taxable",
              ruleRef: `avalara:rule:${cell.jurisdiction}:${cell.taxKind}:${ruleId}`,
            },
            assessedMinor,
          });
        }
      }

      const coverage = reconcileTaxCoverage({
        scope: input.scope,
        taxDate: input.taxDate,
        coverage: input.coverage,
        required: input.required,
        observations,
      });
      if (coverage.kind === "refused") {
        return {
          kind: "refused",
          code: coverage.code,
          field: coverage.field,
          remedy: coverage.remedy,
          ...(coverage.jurisdiction ? { jurisdiction: coverage.jurisdiction } : {}),
          ...(coverage.taxKind ? { taxKind: coverage.taxKind } : {}),
          coverage: { vector: coverage.vector, digest: coverage.digest },
        };
      }
      if (coverage.kind === "unavailable") {
        return {
          kind: "unavailable",
          code: coverage.code,
          effect: coverage.effect,
          coverage: { vector: coverage.vector, digest: coverage.digest },
        };
      }

      const coverageRowByCellKey = new Map(
        coverage.vector.map((row) => [cellIdentityKey(row.cell), row]),
      );

      // Build per-component CatalogueMoneyV2 provider states and final evidence positions
      const evidenceTaxRows: TaxCalculationEvidenceV1["positions"]["tax"][number][] = [];
      const seenPositionRefs = new Set<string>();
      const stageBySequence = new Map(stageResponses.map((s) => [s.sequence, s]));
      let finalTaxTotal = 0;

      const providerComponents: ProviderComponent[] = [];
      for (const comp of componentKeys) {
        const componentSeqs = [
          { afterSequence: 0, amountMinor: comp.preDiscountMinor },
          ...comp.planComp.allocations
            .filter((a) => a.basisReductionMinor > 0)
            .map((a) => ({ afterSequence: a.sequence, amountMinor: a.afterMinor })),
        ];
        const finalCompSeq = componentSeqs[componentSeqs.length - 1]!.afterSequence;
        const compStates: ProviderComponentState[] = [];

        for (const stateSpec of componentSeqs) {
          const isFinalForComp = stateSpec.afterSequence === finalCompSeq;
          const stage = stageBySequence.get(stateSpec.afterSequence)!;
          const respLine = stage.response.lines.find((l) => l.lineNumber === comp.lineNumber);
          const taxPositions: ProviderComponentState["taxPositions"][number][] = [];

          for (const cell of input.required) {
            if (cell.target.kind === "fee") continue;
            const matchesComp =
              (comp.ref.kind === "merchandise" &&
                cell.target.kind === "line" &&
                cell.target.key === comp.ref.lineKey) ||
              (comp.ref.kind === "delivery" &&
                cell.target.kind === "delivery" &&
                cell.target.key === comp.ref.bucketKey);
            if (!matchesComp) continue;

            const covRow = coverageRowByCellKey.get(cellIdentityKey(cell));
            if (!covRow || covRow.decision !== "in_scope_taxed") continue;

            const bindingInfo = taxCellBindings.get(cellIdentityKey(cell))!;
            const matchingDetails = (respLine?.details ?? []).filter(
              (d) =>
                detailMatchesBinding(d, bindingInfo.binding) &&
                !feeBindings.some((fb) => detailMatchesFeeBinding(d, fb)),
            );

            const taxMinor = matchingDetails.reduce(
              (sum, d) => sum + majorToMinorAmount(d.tax, exponent),
              0,
            );
            const firstDetail = matchingDetails[0];
            const rateDecimal = firstDetail ? fractionalRateToPercentString(firstDetail.rate) : "0";
            const positionRef = `${comp.lineNumber}:${cell.jurisdiction}:${cell.level}:${cell.taxKind}`;

            taxPositions.push({
              positionRef,
              jurisdictionRef: cell.jurisdiction,
              rateDecimal,
              taxableMinor: stateSpec.amountMinor,
              taxMinor,
            });

            if (isFinalForComp) {
              finalTaxTotal += taxMinor;
              if (!seenPositionRefs.has(positionRef)) {
                seenPositionRefs.add(positionRef);
                const assignmentRef =
                  comp.ref.kind === "merchandise"
                    ? lineByKey.get(comp.ref.lineKey)!.assignmentRef
                    : deliveryByKey.get(comp.ref.bucketKey)!.assignmentRef;
                const resolution = {
                  assignmentRef,
                  policyRevision: input.policyRevision,
                  sourceRef: `avalara:${finalStage.response.code}:${comp.lineNumber}`,
                  effective: effectiveInterval,
                };
                const ruleRef =
                  covRow.treatment?.ruleRef ?? `avalara:rule:${cell.jurisdiction}:${cell.taxKind}:0`;
                evidenceTaxRows.push({
                  positionRef,
                  cell,
                  ratePercent: rateDecimal,
                  taxabilityReason: covRow.treatment?.reason ?? "taxable",
                  ruleRef,
                  resolution,
                  resolutionDigest: computeResolutionDigest(resolution),
                  ...(comp.ref.kind === "merchandise" ? { providerLineRef: comp.lineNumber } : {}),
                });
              }
            }
          }

          compStates.push({
            afterSequence: stateSpec.afterSequence,
            amountMinor: stateSpec.amountMinor,
            taxPositions,
          });
        }

        providerComponents.push({
          ref: comp.ref,
          states: compStates,
        });
      }

      // Build in-scope fee entries (never emit fees for out_of_scope cells)
      const providerFees: { readonly feeKey: string; readonly amountMinor: number }[] = [];
      const evidenceFees: TaxCalculationEvidenceV1["positions"]["fees"][number][] = [];
      let totalFeeMinor = 0;
      for (const entry of feeFinalEntries) {
        const covRow = coverageRowByCellKey.get(cellIdentityKey(entry.cell));
        if (!covRow || covRow.decision !== "in_scope_taxed") continue;
        const target = entry.cell.target;
        if (target.kind !== "fee") continue;
        const scope =
          target.deliveryKey !== undefined
            ? ({ kind: "delivery" as const, key: target.deliveryKey } as const)
            : ({ kind: "order" as const } as const);
        providerFees.push({
          feeKey: entry.binding.feeKey,
          amountMinor: entry.amountMinor,
        });
        totalFeeMinor += entry.amountMinor;
        evidenceFees.push({
          feeKey: entry.binding.feeKey,
          jurisdiction: entry.binding.jurisdiction,
          feeKind: entry.binding.feeKind,
          scope,
          refundRule: { ...entry.binding.refundRule },
          ...(entry.detail.id !== undefined ? { providerPositionRef: `avalara-fee-${entry.detail.id}` } : {}),
        });
      }

      const finalNetTotal = componentKeys.reduce((sum, c) => sum + c.planComp.effectiveMinor, 0);
      const payableMinor = finalNetTotal + finalTaxTotal + totalFeeMinor;

      let money;
      try {
        money = calculateCatalogueMoneyV2(
          { ...input.money, fees: providerFees },
          {
            kind: "provider",
            payableMinor,
            components: providerComponents,
          },
        );
      } catch (error) {
        if (error instanceof CatalogueMoneyV2Error) {
          return refuse(
            error.code === "money_amount_out_of_range" ? "tax_amount_out_of_range" : "tax_breakdown_incomplete",
            `/input/money/${error.field.replace(/\[(\d+)\]/gu, ".$1").replaceAll(".", "/")}`,
            error.remedy,
          );
        }
        throw error;
      }

      const calculatedAt = toCanonicalUtcInstant(options.clock());
      const expiresAt = new Date(Date.parse(calculatedAt) + calculationLifetimeMs).toISOString();
      const fiscalDigest = computeFiscalDigest({
        scope: input.scope,
        destinationDigest: input.destination.digest,
        shipFromRef: input.shipFromRef,
        policyRevision: input.policyRevision,
        classMapRevision: input.classMapRevision,
        coverage: coverage.vector,
        tax: evidenceTaxRows,
        fees: evidenceFees,
      });
      const calcRef = `avalara-${finalStage.response.code}-${taxTaggedDigest("avalara.calc.v1", [request.key, request.inputDigest, fiscalDigest]).slice(0, 16)}`;

      const providerLines = input.lines.map((line) => ({
        lineKey: line.lineKey,
        providerLineRef: `ol-m-${line.lineKey}`,
      }));

      const evidence: TaxCalculationEvidenceV1 = {
        requestKey: request.key,
        scope: input.scope,
        calculationRef: calcRef,
        status: input.purpose,
        calculatedAt,
        expiresAt,
        taxDate: input.taxDate,
        destinationDigest: input.destination.digest,
        shipFromRef: input.shipFromRef,
        inputDigest: request.inputDigest,
        policyRevision: input.policyRevision,
        classMapRevision: input.classMapRevision,
        coverage: { vector: coverage.vector, digest: coverage.digest },
        fiscalDigest,
        providerLines,
        positions: {
          tax: evidenceTaxRows,
          fees: evidenceFees,
        },
      };
      const evidenceDigest = computeEvidenceDigest(evidence);
      const quoteSuccess = {
        kind: input.purpose,
        money,
        evidence,
        evidenceDigest,
      } as TaxQuoteResultV1;

      const verifyErr = verifyTaxQuoteResult(request, quoteSuccess);
      if (verifyErr) {
        return verifyErr;
      }

      if (quoteSuccess.kind === "final") {
        boundedSet(
          quotesByRef,
          calcRef,
          {
            request,
            result: quoteSuccess,
            shipFrom,
            shipTo,
            customerCode,
            finalLines: finalStage.lines,
            originalPositionRefs: evidenceTaxRows.map((row) => row.providerLineRef ?? row.positionRef),
          },
          MAX_RETAINED_RECORDS,
        );
      }

      return quoteSuccess;
    },

    async readFiscalValidity(): Promise<TaxFiscalValidityResultV1> {
      // validity: "probe_by_recalculation" leaves readFiscalValidity effect-free and zero-I/O.
      return {
        kind: "unavailable",
        code: "tax_fiscal_validity_unavailable",
        effect: "none",
      };
    },

    async closeCalculation(
      ref: TaxCalculationRefV1,
      _reason: TaxCloseReasonV1,
      key: string,
    ): Promise<TaxCloseResultV1> {
      if (!sameScope(ref.scope, options.scope)) {
        return refuse("tax_scope_mismatch", "/ref/scope", "Match the configured Avalara tax scope.");
      }
      if (!ref.ref.trim() || !key.trim()) {
        return refuse("tax_invalid_input", "/key", "Provide non-empty calculation ref and idempotency key.");
      }
      const existing = closedByRef.get(ref.ref);
      if (existing) {
        if (existing.key === key && existing.ref.evidenceDigest === ref.evidenceDigest) {
          return { kind: "closed", ref: { ...existing.ref }, key: existing.key };
        }
        return refuse(
          "tax_reference_conflict",
          "/key",
          "Reuse the original close key and evidence digest for an already-closed calculation.",
        );
      }
      const storedQuote = quotesByRef.get(ref.ref);
      if (storedQuote && storedQuote.result.evidenceDigest !== ref.evidenceDigest) {
        return refuse(
          "tax_reference_conflict",
          "/ref/evidenceDigest",
          "Supply the exact evidenceDigest returned for this calculationRef.",
        );
      }
      const record = { ref: { scope: { ...ref.scope }, ref: ref.ref, evidenceDigest: ref.evidenceDigest }, key };
      boundedSet(closedByRef, ref.ref, record, MAX_RETAINED_RECORDS);
      return { kind: "closed", ref: { ...record.ref }, key };
    },

    async commit(request: TaxCommitRequestV1): Promise<TaxCommitResultV1> {
      if (!sameScope(request.calculationRef.scope, options.scope)) {
        return refuse("tax_scope_mismatch", "/calculationRef/scope", "Match the configured Avalara tax scope.");
      }

      const bindingDigest = taxTaggedDigest("avalara.commit.binding.v1", {
        calculationRef: request.calculationRef,
        transactionRef: request.transactionRef,
        postedAt: request.postedAt,
        capturedAt: request.capturedAt,
        captureEvidenceRef: request.captureEvidenceRef,
      });

      const existing = commitsByTxRef.get(request.transactionRef);
      if (existing) {
        if (existing.bindingDigest === bindingDigest) {
          return JSON.parse(JSON.stringify(existing.result)) as Extract<TaxCommitResultV1, { kind: "committed" }>;
        }
        return refuse(
          "tax_reference_conflict",
          "/transactionRef",
          "Do not reuse a transactionRef with different calculation or capture evidence.",
        );
      }

      if (options.hasCommitReservation && !options.hasCommitReservation(request)) {
        return refuse(
          "tax_calculation_unusable",
          "/captureEvidenceRef",
          "Reserve a verified payment capture before committing a tax transaction.",
        );
      }

      if (closedByRef.has(request.calculationRef.ref)) {
        return refuse(
          "tax_calculation_closed",
          "/calculationRef/ref",
          "Create a fresh quote instead of committing a locally closed calculation.",
        );
      }

      const stored = quotesByRef.get(request.calculationRef.ref);
      if (!stored || stored.result.evidenceDigest !== request.calculationRef.evidenceDigest) {
        return refuse(
          "tax_calculation_unusable",
          "/calculationRef",
          "Commit only a verified final quote produced by this adapter.",
        );
      }

      if (request.postedAt >= stored.result.evidence.expiresAt) {
        return refuse(
          "tax_calculation_expired",
          "/postedAt",
          "Recalculate a fresh quote before committing after calculation expiry.",
        );
      }

      const invoiceCode = buildAvalaraCommitCode(companyCode, options.scope, request.transactionRef);
      const payload: AvalaraCreateTransactionPayload = {
        companyCode,
        type: "SalesInvoice",
        code: invoiceCode,
        commit: true,
        date: stored.result.evidence.taxDate.slice(0, 10),
        customerCode: stored.customerCode,
        currencyCode: stored.request.input.currency,
        addresses: {
          shipFrom: stored.shipFrom,
          shipTo: stored.shipTo,
        },
        lines: stored.finalLines,
      };

      let response: AvalaraTransactionResponse;
      try {
        response = await options.client.createTransaction(payload);
      } catch (error) {
        const effect = error instanceof AvalaraTransportError ? error.effect : "unknown";
        return {
          kind: "unavailable",
          code: "tax_adapter_unavailable",
          effect,
        };
      }

      const postedPositions = stored.originalPositionRefs.map((originalPositionRef, index) => ({
        originalPositionRef,
        postedPositionRef: `${response.code}:line:${index + 1}`,
      }));

      const committed: Extract<TaxCommitResultV1, { kind: "committed" }> = {
        kind: "committed",
        providerTransactionRef: response.code,
        positions: postedPositions,
      };

      const record: StoredCommit = {
        bindingDigest,
        result: committed,
        providerCode: response.code,
        quote: stored,
        payableMinor: stored.result.money.payableMinor,
        refundedMinor: 0,
      };
      boundedSet(commitsByTxRef, request.transactionRef, record, MAX_RETAINED_RECORDS);
      boundedSet(commitsByProviderCode, response.code, record, MAX_RETAINED_RECORDS);

      return JSON.parse(JSON.stringify(committed)) as Extract<TaxCommitResultV1, { kind: "committed" }>;
    },

    async reverse(request: TaxReverseRequestV1): Promise<TaxReverseResultV1> {
      if (!sameScope(request.scope, options.scope)) {
        return refuse("tax_scope_mismatch", "/scope", "Match the configured Avalara tax scope.");
      }
      if (request.mode === "amount") {
        return refuse(
          "tax_operation_unsupported",
          "/mode",
          "Use full or lines reversal mode with this Avalara tax adapter.",
        );
      }

      const bindingDigest = taxTaggedDigest("avalara.reverse.binding.v1", {
        scope: request.scope,
        originalRef: request.originalRef,
        reversalRef: request.reversalRef,
        refundEvidenceRef: request.refundEvidenceRef,
        currency: request.currency,
        fromMinor: request.fromMinor,
        toMinor: request.toMinor,
        mode: request.mode,
        positions: request.positions,
        ...(request.feeEvidenceRef ? { feeEvidenceRef: request.feeEvidenceRef } : {}),
      });

      const existingReversal = reversalsByRef.get(request.reversalRef);
      if (existingReversal) {
        if (existingReversal.bindingDigest === bindingDigest) {
          return JSON.parse(JSON.stringify(existingReversal.result)) as Extract<
            TaxReverseResultV1,
            { kind: "reversed" }
          >;
        }
        return refuse(
          "tax_reference_conflict",
          "/reversalRef",
          "Do not reuse a reversalRef with different refund evidence or deltas.",
        );
      }

      const committed = commitsByProviderCode.get(request.originalRef);
      if (!committed) {
        return refuse(
          "tax_reversal_unsubstantiated",
          "/originalRef",
          "Reverse only a committed Avalara transaction reference.",
        );
      }
      if (request.currency !== committed.quote.request.input.currency) {
        return refuse("tax_scope_mismatch", "/currency", "Match the original committed transaction currency.");
      }
      if (
        request.fromMinor < 0 ||
        request.toMinor <= request.fromMinor ||
        request.toMinor > committed.payableMinor ||
        request.fromMinor !== committed.refundedMinor
      ) {
        return refuse(
          "tax_reversal_unsubstantiated",
          "/toMinor",
          "Reversal cumulative range must advance contiguously within the remaining committed balance.",
        );
      }

      const expectedDeltaTotal = request.fromMinor - request.toMinor; // negative integer
      const actualDeltaTotal = request.positions.reduce(
        (sum, p) => sum + p.netDeltaMinor + p.taxDeltaMinor + p.feeDeltaMinor,
        0,
      );
      if (actualDeltaTotal !== expectedDeltaTotal) {
        return refuse(
          "tax_reversal_unsubstantiated",
          "/positions",
          "Sum of position deltas must equal fromMinor - toMinor.",
        );
      }

      const exponent = getCurrencyExponent(request.currency);
      if (exponent === null) {
        return refuse("tax_scope_mismatch", "/currency", "Unsupported currency exponent.");
      }

      let providerReversalRef: string;
      if (request.mode === "full" && request.fromMinor === 0) {
        // Clean full reversal -> DocVoided via POST /api/v2/transactions/{companyCode}/{transactionCode}/void
        try {
          const voided = await options.client.voidTransaction(companyCode, committed.providerCode, {
            code: "DocVoided",
          });
          if (voided.code !== committed.providerCode || voided.status !== "Cancelled") {
            return {
              kind: "unavailable",
              code: "tax_adapter_unavailable",
              effect: "unknown",
            };
          }
          providerReversalRef = `void:${voided.code}`;
        } catch (error) {
          const effect = error instanceof AvalaraTransportError ? error.effect : "unknown";
          return {
            kind: "unavailable",
            code: "tax_adapter_unavailable",
            effect,
          };
        }
      } else {
        // Partial reversal ("lines") or remainder full reversal (fromMinor > 0) -> ReturnInvoice
        const reversalCode = buildAvalaraReversalCode(companyCode, options.scope, request.reversalRef);
        const returnLines: AvalaraTransactionLineInput[] = request.positions.map((pos, idx) => ({
          number: `ol-ret-${idx + 1}`,
          quantity: 1,
          amount: minorToMajorAmount(pos.netDeltaMinor, exponent),
          taxIncluded: false,
        }));
        const returnPayload: AvalaraCreateTransactionPayload = {
          companyCode,
          type: "ReturnInvoice",
          code: reversalCode,
          commit: true,
          date: toCanonicalUtcInstant(options.clock()).slice(0, 10),
          customerCode: committed.quote.customerCode,
          currencyCode: request.currency,
          referenceCode: committed.providerCode,
          taxOverride: {
            type: "TaxDate",
            taxDate: committed.quote.result.evidence.taxDate.slice(0, 10),
            reason: "Customer return",
          },
          addresses: {
            shipFrom: committed.quote.shipFrom,
            shipTo: committed.quote.shipTo,
          },
          lines: returnLines,
        };
        try {
          const returned = await options.client.createTransaction(returnPayload);
          providerReversalRef = returned.code;
        } catch (error) {
          const effect = error instanceof AvalaraTransportError ? error.effect : "unknown";
          return {
            kind: "unavailable",
            code: "tax_adapter_unavailable",
            effect,
          };
        }
      }

      committed.refundedMinor = request.toMinor;
      const reversed: Extract<TaxReverseResultV1, { kind: "reversed" }> = {
        kind: "reversed",
        providerReversalRef,
        positions: request.positions.map((p) => ({ ...p })),
      };
      boundedSet(
        reversalsByRef,
        request.reversalRef,
        { bindingDigest, result: reversed },
        MAX_RETAINED_RECORDS,
      );
      return JSON.parse(JSON.stringify(reversed)) as Extract<TaxReverseResultV1, { kind: "reversed" }>;
    },
  };
}
