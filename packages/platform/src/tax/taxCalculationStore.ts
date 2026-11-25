import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalCatalogDraftJson, CATALOG_DRAFT_MAX_BYTES } from "../catalog/contracts/index.js";
import { verifyTaxQuoteRequest, verifyTaxQuoteResult } from "./digest.js";
import type { TaxQuoteRequestV1, TaxQuoteResultV1, TaxRefusal } from "./contracts/types.js";
import { currency, digest, exclusiveComposition, fiscalComposition, fiscalSuccessEvidence, instant, uuid,
  type CheckoutComposition, type FiscalCheckoutComposition, type FiscalSuccessEvidence } from "./taxCalculationComposition.js";

const text = z.string().refine(value => value.length > 0 && value.length <= 256);
const bytes = (max: number) => z.string().refine(value => value.length > 0 && Buffer.byteLength(value) <= max);
const destination = z.strictObject({ snapshotRef: uuid, destinationDigest: digest, schemaVersion: z.literal(2),
  policyRevision: bytes(720).refine(value => !/\p{Cc}/u.test(value) && /[^ ]/u.test(value)) });
const arm = z.enum(["fiscal_profile", "tax_calculation"]);
const scope = z.strictObject({ installationRef: text.and(bytes(200)), clientId: uuid, principalRef: uuid, scopeRef: uuid, evaluationKey: text });
const selectors = bytes(240).refine(value => value.trim() === value);
const purpose = z.enum(["estimate", "final"]);
const invocation = z.strictObject({ purpose, mode: z.enum(["one_time", "subscription"]),
  cadence: z.strictObject({ schemaVersion: z.literal(1), kind: z.literal("fixed_days"), days: z.number().int().min(1).max(3660) }).optional(),
  lines: z.array(z.strictObject({ sku: selectors, quantity: z.number().int().min(1).max(99) })).min(1).max(50),
  deliverySelector: selectors, paymentSelector: selectors });
const common = { identity: scope, invocation };
const coverage = z.strictObject({ accountRef: text, revision: text, digest });
const fiscalRequest = z.strictObject({ basis: z.literal("inclusive"), taxDate: z.iso.datetime({ precision: 3 }) });
const pinFields = { destination, request: z.unknown(), coverage: coverage.nullable(), validUntil: instant, recovery: digest.nullable() };
const pin = z.discriminatedUnion("kind", [
  z.strictObject({ ...pinFields, kind: z.literal("fiscal_profile"), composition: fiscalComposition.optional() }),
  z.strictObject({ ...pinFields, kind: z.literal("tax_calculation"), composition: exclusiveComposition.optional() }),
]);
const begin = z.discriminatedUnion("operation", [z.strictObject({ ...common, operation: z.literal("lookup") }),
  z.strictObject({ ...common, operation: z.literal("claim"), pin: pin.optional(), recovery: digest.nullable() })]);
const outcomes = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("indeterminate") }),
  z.strictObject({ kind: z.literal("unavailable"), code: z.enum(["tax_coverage_evidence_unavailable", "tax_adapter_unavailable"]) }),
  z.strictObject({ kind: z.literal("refused"), code: z.string().min(1).max(64), // SQL verifies the permitted refusal tuple.
    field: z.string().max(256), remedy: z.string().min(1).max(512) }),
  z.strictObject({ kind: z.literal("final"), quote: z.unknown() }),
  z.strictObject({ kind: z.literal("estimate"), quote: z.unknown() }),
]);
const complete = z.strictObject({ ...common, calculationId: uuid, claimToken: uuid, generation: z.number().int().min(1).max(2147483647),
  seal: z.strictObject({ destination, kind: arm, requestDigest: digest, validUntil: instant, contradiction: z.boolean(),
    outcome: outcomes, evidence: z.unknown(), compositionDigest: digest.optional() }),
  adapter: z.strictObject({ request: z.unknown(), result: z.unknown() }).optional() });

interface TaxCalculationExecutor {
  query(statement: string, parameters?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** A restricted session that resolves only after commit acknowledgment.
 * @experimental
 */
export interface TaxCalculationTransactionLane {
  run<T>(work: (executor: TaxCalculationExecutor) => Promise<T>): Promise<T>;
}

interface EvaluationScope {
  identity: { installationRef: string; clientId: string; principalRef: string; scopeRef: string; evaluationKey: string };
  invocation: {
    purpose: "final" | "estimate";
    mode: "one_time" | "subscription";
    cadence?: { schemaVersion: 1; kind: "fixed_days"; days: number };
    lines: readonly { sku: string; quantity: number }[];
    deliverySelector: string;
    paymentSelector: string;
  };
}
interface EvaluationEvidence {
  destination: { snapshotRef: string; destinationDigest: string; schemaVersion: 2; policyRevision: string };
  kind: "fiscal_profile" | "tax_calculation";
  validUntil: string;
}
type EvaluationPin = Omit<EvaluationEvidence, "kind"> & {
  request: unknown;
  coverage: { accountRef: string; revision: string; digest: string } | null;
  recovery: string | null;
} & (
  | { kind: "fiscal_profile"; composition?: FiscalCheckoutComposition }
  | { kind: "tax_calculation"; composition?: CheckoutComposition & { fiscal?: never } }
);
type BeginTaxCalculationInput = Uint8Array | (EvaluationScope & (
  { operation: "lookup" } | { operation: "claim"; pin?: EvaluationPin; recovery: string | null }
));
type Refusal = Pick<TaxRefusal, "kind" | "field" | "remedy"> & { code: string };
type QuoteOutcome = { kind: "estimate" | "final"; quote: unknown };
type UnavailableCode = "tax_coverage_evidence_unavailable" | "tax_adapter_unavailable";
type CompletionOutcome = Refusal | QuoteOutcome | { kind: "indeterminate" } | { kind: "unavailable"; code: UnavailableCode };
type EvaluationSeal = EvaluationEvidence & { requestDigest: string; contradiction: boolean } & (
  | { evidence: unknown; outcome: CompletionOutcome; compositionDigest?: never }
  | { kind: "fiscal_profile"; evidence: FiscalSuccessEvidence; outcome: QuoteOutcome; compositionDigest: string }
  | { kind: "tax_calculation"; evidence: unknown; outcome: QuoteOutcome; compositionDigest: string }
);
type CompleteTaxCalculationInput = Uint8Array | (EvaluationScope & {
  calculationId: string;
  claimToken: string;
  generation: number;
  seal: EvaluationSeal;
  adapter?: { request: unknown; result: unknown };
});
type Terminal = { kind: "terminal"; validUntil: string; freshness: "current" | "historical";
  outcome: Refusal | QuoteOutcome | { kind: "unavailable"; code: UnavailableCode; effect: "none"; field: string; remedy: string } };
type CompleteTaxCalculationResult = Terminal | Refusal | { kind: "pending" | "missing" };
type BeginTaxCalculationResult = CompleteTaxCalculationResult | { kind: "claimed"; calculationId: string; generation: number;
  claimToken: string; dispatchDeadlineMs: number; cutoffDeadlineMs: number;
  pin: EvaluationPin & { requestDigest: string; invocationDigest: string; documentDigest: string } };

/** Computes a canonical digest for the native evaluation store.
 * @experimental
 */
export const evaluationDigest = (tag: string, body: unknown): string => createHash("sha256")
  .update(canonicalCatalogDraftJson(["platform.tax." + tag + ".v1", body]), "utf8").digest("hex");

const remedies: Record<string, string> = {
  tax_invalid_input: "Supply the documented input.",
  tax_reference_conflict: "Replay the original invocation and evidence.",
  tax_scope_mismatch: "Re-obtain evidence in the authorized scope.",
  tax_claim_pending: "Read the original evaluation outcome.",
  tax_claim_stale: "Read the original evaluation outcome.",
  tax_claim_generation_exhausted: "Reconcile the original evaluation with its owner.",
  tax_adapter_unavailable: "Recover the original evidence through the adapter owner.",
  tax_evaluation_integrity_invalid: "Recover the original evaluation from its authoritative owner.",
  commerce_destination_owner_mismatch: "Re-obtain evidence through the authenticated owner.",
  destination_evidence_erased: "Review the privacy disposition through authorized support.",
  destination_digest_mismatch: "Replay the original document and its digest.",
  destination_version_changed: "Select the destination again and obtain a fresh quote.",
  tax_calculation_expired: "Select the destination again and obtain a fresh quote.",
  destination_binding_invalid: "Recover the original binding.",
  destination_dialect_invalid: "Use the snapshot entry.",
  destination_isolation_unsupported: "Use READ COMMITTED.",
  address_invalid_input: "Correct caller-authored input or re-obtain authoritative evidence as applicable.",
};
const definitiveRemedy = "Request a new quote when the tax service is available.";
const historyRemedy = "Recover the verified original history through its owner.";
const invalidClaimComposition = new Error("Invalid stored quote composition");
const refusal = (code: string, field: string, remedy = remedies[code]!): Refusal => ({ kind: "refused", code, field, remedy });
function fromDatabase(error: unknown): Refusal | undefined {
  if (!(error instanceof Error) || !("code" in error) || !["22023", "55000"].includes(String(error.code))
    || !Object.hasOwn(remedies, error.message) || !("detail" in error) || typeof error.detail !== "string") return;
  if (error.message === "tax_reference_conflict" && error.detail === "/coverage") return refusal(error.message, error.detail, historyRemedy);
  if (error.message === "tax_invalid_input" && error.detail === "/pin/destination/policyRevision")
    return refusal(error.message, error.detail, "Obtain a supported revision from the destination owner.");
  if (error.message === "tax_invalid_input" && "hint" in error && error.hint === "tax_coverage_declaration_invalid")
    return refusal(error.message, error.detail, "Have the coverage owner correct the authoritative declaration.");
  const field = { destinationDigest: "/destination/destinationDigest", documentDigest: "/destination/destinationDigest",
    destination: "/destination", "destination.snapshotRef": "/destination/snapshotRef", "destination.policyRevision": "/destination/policyRevision" };
  return refusal(error.message, field[error.detail as keyof typeof field] ?? error.detail);
}
const unavailable = (cause: unknown, field: string) => Object.assign(new Error("commerce_quote_v2_unavailable", { cause }), {
  code: "commerce_quote_v2_unavailable", field,
  remedy: "Check the native app binding, driver setup, database connection and TLS, operation-role privileges, and installed migrations. Then retry the same operation.",
});
function prepare<T extends z.ZodType>(schema: T, input: unknown): z.output<T> | Refusal {
  try {
    if (input instanceof Uint8Array) {
      if (input.byteLength > CATALOG_DRAFT_MAX_BYTES) return refusal("tax_invalid_input", "/");
      input = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input));
    }
    const parsed = schema.safeParse(JSON.parse(canonicalCatalogDraftJson(input)));
    if (parsed.success) return parsed.data;
    return refusal("tax_invalid_input", "/" + (parsed.error.issues[0]?.path ?? []).join("/"));
  } catch { return refusal("tax_invalid_input", "/"); }
}

async function execute(lane: TaxCalculationTransactionLane, input: EvaluationScope & { operation: "lookup" | "claim" | "complete" }): Promise<BeginTaxCalculationResult> {
  const statement = `SELECT public.tax_calculation_${input.operation === "complete" ? "complete" : "begin"}_v1($1::jsonb) AS result`;
  let wire: string;
  try { wire = canonicalCatalogDraftJson(input); }
  catch { return refusal("tax_invalid_input", "/"); }
  let awaitingCommit = false;
  try {
    const { reply: result, sampledAtMs, sentAt } = await lane.run(async db => {
      await db.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
      const sentAt = performance.now();
      const { sampledAtMs, ...reply } = ((await db.query(statement, [wire])).rows[0]?.result ?? {}) as BeginTaxCalculationResult & { sampledAtMs?: number };
      if (!reply?.kind) throw new Error("Missing evaluation result");
      if (reply.kind === "claimed" && Object.hasOwn(reply.pin, "composition")) {
        const schema = reply.pin.kind === "fiscal_profile" ? fiscalComposition : exclusiveComposition;
        if (!schema.safeParse(reply.pin.composition).success) throw invalidClaimComposition;
      }
      awaitingCommit = true;
      return { reply, sampledAtMs, sentAt };
    });
    if (result.kind === "claimed") {
      const cutoff = typeof sampledAtMs === "number" ? sentAt + (Date.parse(result.pin.validUntil) - sampledAtMs) : Number.NaN;
      if (!(performance.now() < cutoff)) return refusal("tax_calculation_expired", "/taxEvidence/expiresAt");
      // Dispatch also needs a live lease. The lease begins no earlier than the query send.
      return { ...result, cutoffDeadlineMs: cutoff, dispatchDeadlineMs: Math.min(cutoff, sentAt + 300_000) };
    }
    return result.kind === "terminal" ? { ...result, freshness: new Date().toISOString() >= result.validUntil ? "historical" : "current" } : result;
  } catch (error) {
    if (error === invalidClaimComposition) return refusal("tax_evaluation_integrity_invalid", "/taxEvidence");
    if (awaitingCommit && input.operation !== "lookup") return execute(lane, { operation: "lookup", identity: input.identity, invocation: input.invocation });
    const known = awaitingCommit ? undefined : fromDatabase(error);
    if (known) return known;
    throw unavailable(error, "/" + (input.operation === "complete" ? "completion" : input.operation));
  }
}

/** Looks up an evaluation or returns a claim after the transaction commits.
 * @experimental
 */
export async function beginTaxCalculation(lane: TaxCalculationTransactionLane, input: BeginTaxCalculationInput): Promise<BeginTaxCalculationResult> {
  const parsed = prepare(begin, input);
  if ("kind" in parsed) return parsed;
  if (parsed.operation !== "claim" || !parsed.pin) return execute(lane, parsed);
  const pin = parsed.pin;
  if ([...pin.destination.policyRevision].length > 256)
    return refusal("tax_invalid_input", "/pin/destination/policyRevision", "Obtain a supported revision from the destination owner.");
  try {
    const requestDigest = evaluationDigest("evaluation-request", pin.request);
    if (pin.kind === "tax_calculation") {
      const request = pin.request as TaxQuoteRequestV1;
      const invalid = verifyTaxQuoteRequest(request);
      if (invalid) return invalid;
      if (!currency.safeParse(request.input.currency).success) return refusal("tax_invalid_input", "/input/currency");
      if (request.input.purpose !== parsed.invocation.purpose || !pin.coverage) return refusal("tax_scope_mismatch", "/pin");
      const { address: _address, ...destination } = request.input.destination;
      pin.request = { ...request, input: { ...request.input, destination } };
    } else if (pin.coverage !== null || pin.recovery !== null) return refusal("tax_invalid_input", "/pin");
    else {
      const fiscal = fiscalRequest.safeParse(pin.request);
      if (!fiscal.success) return refusal("tax_invalid_input", "/pin/request");
      if (pin.composition && !instant.safeParse(fiscal.data.taxDate).success)
        return refusal("tax_invalid_input", "/pin/request/taxDate");
    }
    Object.assign(pin, { requestDigest });
  } catch { return refusal("tax_invalid_input", "/pin/request"); }
  return execute(lane, parsed);
}

/** Seals an owned evaluation or verifies an exact replay.
 * @experimental
 */
export async function completeTaxCalculation(lane: TaxCalculationTransactionLane, input: CompleteTaxCalculationInput): Promise<CompleteTaxCalculationResult> {
  const parsed = prepare(complete, input);
  if ("kind" in parsed) return parsed;
  const { seal: { compositionDigest, ...seal }, adapter, invocation } = parsed;
  const success = "quote" in seal.outcome;
  if (compositionDigest !== undefined && !success) return refusal("tax_invalid_input", "/seal");
  let evidence = seal.evidence, disposition: string = seal.outcome.kind;
  try {
    if (success) {
      if (seal.outcome.kind !== invocation.purpose) return refusal("tax_reference_conflict", "/taxEvidence");
      if (seal.kind === "tax_calculation") {
        const request = adapter?.request as TaxQuoteRequestV1, result = adapter?.result as TaxQuoteResultV1;
        if (result?.kind !== seal.outcome.kind || evaluationDigest("evaluation-request", request) !== seal.requestDigest) return refusal("tax_reference_conflict", "/taxEvidence");
        const invalid = verifyTaxQuoteResult(request, result);
        if (invalid) return invalid;
        evidence = { adapterEvidence: result.evidence, adapterDigest: result.evidenceDigest,
          ...(compositionDigest !== undefined ? { compositionDigest } : {}) };
        disposition = result.evidence.coverage.vector.every(row => row.decision === "out_of_scope") ? "skip" : "required";
        if (seal.validUntil > result.evidence.expiresAt) return refusal("tax_reference_conflict", "/taxEvidence/expiresAt");
      } else {
        disposition = "no_provider_posting";
        if (compositionDigest !== undefined) {
          const fiscal = fiscalSuccessEvidence.safeParse(evidence);
          if (!fiscal.success) return refusal("tax_invalid_input", "/seal");
          evidence = { ...fiscal.data, compositionDigest };
        } else if (evidence !== null && typeof evidence === "object" && Object.hasOwn(evidence, "compositionDigest")) {
          return refusal("tax_invalid_input", "/seal");
        }
      }
    } else evidence = null;
    const outcome = seal.outcome.kind === "unavailable" ? { ...seal.outcome, field: "/taxEvidence", effect: "none",
      remedy: definitiveRemedy } : seal.outcome;
    const { adapter: _adapter, ...rest } = parsed;
    const wire = { ...rest, operation: "complete" as const, seal: { ...seal, outcome, evidence, disposition } };
    return await execute(lane, wire) as CompleteTaxCalculationResult;
  } catch (error) {
    if (error instanceof Error && error.message === "commerce_quote_v2_unavailable") throw error;
    return refusal("tax_invalid_input", "/seal");
  }
}
