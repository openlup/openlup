import type { InvoiceCapabilities, InvoiceDocumentIdentity, InvoiceIdentity, InvoiceWriteResult, InvoiceReadbackResult, InvoiceArtifactResult, InvoiceHostPorts, InvoiceServicesOptions } from "./contracts/index.js";
import { readInvoiceCapabilities } from "./capabilities.js";

type Provider = NonNullable<InvoiceServicesOptions["provider"]>;
type Fixture<Input, Result> = { readonly input: Input; readonly expected: Result };
interface Subject {
  readonly subjectId: string;
  readonly capability: InvoiceCapabilities;
  readonly provider: Provider;
  readonly host?: InvoiceHostPorts;
  /** Adapter-owned offline fixtures; count writes across every injected transport. */
  readonly readWriteCount: () => number;
  readonly sensitiveValues: readonly string[];
  readonly fixtures: {
    readonly issue: readonly (Fixture<Parameters<Provider["issue"]>[0], InvoiceWriteResult> & { readonly replay?: boolean })[];
    readonly correction: readonly (Fixture<Parameters<Provider["correct"]>[0], InvoiceWriteResult> & { readonly replay?: boolean })[];
    readonly readback: readonly Fixture<InvoiceIdentity, InvoiceReadbackResult>[];
    readonly void: readonly Fixture<Parameters<Provider["void"]>[0], Awaited<ReturnType<Provider["void"]>>>[];
    readonly artifact?: readonly Fixture<Parameters<InvoiceHostPorts["artifacts"]["read"]>[0], InvoiceArtifactResult>[];
    readonly clearance?: readonly Fixture<Parameters<InvoiceHostPorts["clearance"]["observe"]>[0], Awaited<ReturnType<InvoiceHostPorts["clearance"]["observe"]>>>[];
    readonly settlement?: readonly Fixture<Parameters<InvoiceHostPorts["settlement"]["record"]>[0], Awaited<ReturnType<InvoiceHostPorts["settlement"]["record"]>>>[];
    readonly companyLookup?: readonly Fixture<Parameters<InvoiceHostPorts["registry"]["lookup"]>[0], Awaited<ReturnType<InvoiceHostPorts["registry"]["lookup"]>>>[];
  };
}
class ContractFailure extends Error {}
function requireFact(value: unknown, code: string): asserts value {
  if (!value) throw new ContractFailure(`INVOICE_CONFORMANCE:${code}`);
}
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = Object.keys(a), right = Object.keys(b);
  return left.length === right.length && left.every(key => Object.hasOwn(b, key) && same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}
function keys(value: object, allowed: readonly string[]): void {
  requireFact(Object.keys(value).every(key => allowed.includes(key)), "unexpected_field");
}
function proof(value: { evidenceRef: string; fingerprint: string; observedAt: string }, extra: readonly string[] = []): void {
  keys(value, ["evidenceRef", "fingerprint", "observedAt", ...extra]);
  requireFact([value.evidenceRef, value.fingerprint, value.observedAt].every(v => typeof v === "string" && v.trim().length > 0), "proof_required");
}
function identity(value: InvoiceIdentity | InvoiceDocumentIdentity, expected: InvoiceIdentity | InvoiceDocumentIdentity): void {
  keys(value, "documentRef" in expected ? ["providerRef", "documentRef", "providerDocumentRef", "orderRef", "invoiceRef", "parentProviderDocumentRef"] : ["providerRef", "requestKey", "providerCreateIdentity", "factRevision", "orderRef", "invoiceRef", "operation", "correctionRef", "parentProviderDocumentRef"]);
  requireFact(same(value, expected), "identity_scope");
}
function safe(result: unknown, subject: Subject): void {
  const serialized = JSON.stringify(result);
  requireFact(subject.sensitiveValues.every(value => value.length > 0 && !serialized.includes(value) && !serialized.includes(encodeURIComponent(value))), "sensitive_result");
}
function documentResult(result: InvoiceWriteResult | InvoiceReadbackResult | Awaited<ReturnType<Provider["void"]>>, expected: InvoiceIdentity, operation: "write" | "read" | "void"): void {
  requireFact(operation === "void" ? result.kind === "unsupported" : operation === "read" ? ["found", "absent", "unknown", "unsupported"].includes(result.kind) : ["issued", "refused", "unknown", "unsupported"].includes(result.kind), "document_result_kind");
  if (result.kind === "unsupported") {
    keys(result, ["kind", "code", "retryable", "effectMayHaveSucceeded"]);
    requireFact(result.retryable === false && result.effectMayHaveSucceeded === false && ["unsupported", "host_binding_required"].includes(result.code), "unsupported_before_write");
    return;
  }
  identity(result.identity, expected);
  if (result.kind === "issued" || result.kind === "found") {
    keys(result, result.kind === "found" ? ["kind", "identity", "providerDocumentRef", "providerDocumentNumber", "proof"] : ["kind", "identity", "providerDocumentRef", "providerDocumentNumber", "proof", "replayed"]);
    proof(result.proof);
    if (result.kind === "issued") requireFact(typeof result.replayed === "boolean", "issued_replay");
    requireFact(result.providerDocumentRef.trim().length > 0 && (result.providerDocumentNumber === null || typeof result.providerDocumentNumber === "string"), "issued_identity");
  } else if (result.kind === "absent") {
    keys(result, ["kind", "identity", "evidence"]); proof(result.evidence, ["exact", "complete", "scope"]);
    requireFact(result.evidence.exact === true && result.evidence.complete === true, "exact_complete_absence");
    identity(result.evidence.scope, expected);
  } else if (result.kind === "unknown") {
    keys(result, ["kind", "identity", "code", "effectMayHaveSucceeded"]);
    requireFact(result.code === "unknown" && (operation === "write" ? "effectMayHaveSucceeded" in result && result.effectMayHaveSucceeded === true : !("effectMayHaveSucceeded" in result)), "unknown_not_absent");
  } else {
    keys(result, ["kind", "identity", "code", "retryable", "effectMayHaveSucceeded"]);
    requireFact(result.kind === "refused" && result.effectMayHaveSucceeded === false && typeof result.retryable === "boolean" && ["blocked", "retryable", "missing_facts", "identity_mismatch", "parent_mismatch", "money_mismatch"].includes(result.code), "refusal_before_write");
  }
}
function hostResult(operation: "artifact" | "clearance" | "settlement" | "companyLookup", input: unknown, value: unknown): void {
  const result = value as Record<string, unknown>;
  if (result.kind === "unsupported") {
    keys(result, ["kind", "code", "retryable", "effectMayHaveSucceeded"]);
    requireFact(result.retryable === false && result.effectMayHaveSucceeded === false && (result.code === "unsupported" || result.code === "host_binding_required"), "host_unsupported"); return;
  }
  if (operation === "artifact") {
    const artifact = value as InvoiceArtifactResult, request = input as Parameters<InvoiceHostPorts["artifacts"]["read"]>[0];
    requireFact(artifact.kind !== "unsupported", "artifact_result"); identity(artifact.identity, request.identity);
    if (artifact.kind === "found") {
      keys(artifact, ["kind", "identity", "artifact"]); keys(artifact.artifact, ["kind", "ref", "owner", "mediaType", "proof"]);
      requireFact(artifact.artifact.kind === request.kind && artifact.artifact.ref.length > 0 && artifact.artifact.mediaType.length > 0 && ["provider", "host_storage"].includes(artifact.artifact.owner), "artifact_reference"); proof(artifact.artifact.proof);
    } else if (artifact.kind === "absent") {
      keys(artifact, ["kind", "identity", "evidence"]); proof(artifact.evidence, ["exact", "complete", "scope"]);
      keys(artifact.evidence.scope, ["identity", "kind", "artifactRef"]);
      requireFact(artifact.evidence.exact === true && artifact.evidence.complete === true && artifact.evidence.scope.kind === request.kind && artifact.evidence.scope.artifactRef === null, "artifact_absence"); identity(artifact.evidence.scope.identity, request.identity);
    } else { keys(artifact, ["kind", "identity", "code"]); requireFact(artifact.kind === "unknown" && artifact.code === "unknown", "artifact_unknown"); }
  } else if (operation === "clearance") {
    const observation = value as Awaited<ReturnType<InvoiceHostPorts["clearance"]["observe"]>>;
    if (observation.kind === "observed") {
      keys(observation, ["kind", "observation"]);
      const observed = observation.observation;
      keys(observed, ["state", "reference", "proof"]); proof(observed.proof);
      requireFact(["not_submitted", "pending", "rejected", "accepted", "not_required", "unsupported"].includes(observed.state), "clearance_state");
      requireFact(observed.state === "accepted" ? typeof observed.reference === "string" && observed.reference.trim().length > 0 : observed.reference === null || typeof observed.reference === "string", "clearance_reference");
    } else { keys(observation, ["kind", "code"]); requireFact(observation.kind === "unknown" && observation.code === "unknown", "clearance_unknown"); }
  } else if (operation === "settlement") {
    const item = input as Parameters<InvoiceHostPorts["settlement"]["record"]>[0];
    requireFact([item.grossMinor, item.feeMinor, item.netMinor].every(Number.isSafeInteger) && item.grossMinor - item.feeMinor === item.netMinor, "settlement_money");
    keys(result, ["kind", "itemRef", "settlementItemRef", "replayed", "code"]); requireFact(result.itemRef === item.itemRef, "settlement_item_identity");
    requireFact(["recorded", "conflict", "unknown"].includes(String(result.kind)), "settlement_result");
    if (result.kind === "recorded") requireFact(typeof result.replayed === "boolean" && typeof result.settlementItemRef === "string" && result.settlementItemRef.length > 0, "settlement_receipt");
    if (result.kind === "conflict") requireFact(result.code === "identity_mismatch" || result.code === "money_mismatch", "settlement_conflict");
    if (result.kind === "unknown") requireFact(result.code === "unknown", "settlement_unknown");
  } else {
    const company = value as Awaited<ReturnType<InvoiceHostPorts["registry"]["lookup"]>>;
    keys(result, ["kind", "identifier", "legalName", "registrationIds", "address", "taxRegistrations", "sourceRef", "proof", "code"]);
    const request = input as Parameters<InvoiceHostPorts["registry"]["lookup"]>[0];
    requireFact(company.kind !== "unsupported", "company_result");
    requireFact(company.sourceRef === request.sourceRef, "company_source");
    if (company.kind !== "unknown") requireFact(same(company.identifier, request.identifier), "company_identity");
    if (company.kind === "found" || company.kind === "partial") {
      proof(company.proof);
      for (const registration of company.taxRegistrations) { keys(registration, ["scheme", "status"]); requireFact(["active", "exempt", "not_registered", "unknown"].includes(registration.status), "company_tax_status"); }
    } else if (company.kind === "not_found") proof(company.proof);
    else requireFact(company.kind === "unknown" && company.code === "unknown", "company_unknown");
  }
}
/** @consumer Offline provider bridge tests and installed cold consumer. Runner-
 * agnostic contract evidence only; adapters own fixtures, transport and I/O counts.
 * Throws closed failure codes. It neither certifies live fiscal readiness nor logs
 * provider results, secrets, buyer facts or raw adapter errors.
 */
export async function runInvoiceAdapterConformance(subjects: readonly Subject[]): Promise<{ readonly subjects: readonly { readonly subjectId: string; readonly providerRef: string; readonly cases: readonly string[] }[] }> {
  const evidence: { subjectId: string; providerRef: string; cases: string[] }[] = [];
  try {
    requireFact(subjects.length > 0, "subject_required");
    for (const subject of subjects) {
      const { capability: caps, provider, fixtures } = subject;
      const cases: string[] = [];
      requireFact(caps.defaultOff === true, "default_off");
      requireFact(caps.version === "invoicing.capabilities.v1" && caps.numberingOwner === "provider"
        && [caps.providerRef, caps.fiscalScope.scopeRef, caps.fiscalScope.version, ...Object.values(caps.policies)].every(value => value.trim().length > 0), "capability_scope");
      requireFact(readInvoiceCapabilities({ selection: { providerRef: caps.providerRef }, capability: caps }).kind === "refused", "default_off");
      requireFact(readInvoiceCapabilities({ enabled: true, selection: null, capability: caps }).kind === "refused", "explicit_selection");
      cases.push("default_off", "explicit_selection");
      for (const operation of ["issue", "correction"] as const) {
        const rows = fixtures[operation]; requireFact(rows.length > 0, "write_fixture_required");
        if (caps.operations[operation].supported) requireFact(rows.some(row => row.expected.kind === "issued"), "issued_fixture_required");
        if (caps.operations[operation].supported && caps.operations.recovery.supported) requireFact(rows.some(row => row.replay), "recovery_fixture_required");
        for (const row of rows) {
          requireFact(row.input.identity.providerRef === caps.providerRef, "selected_provider");
          const before = subject.readWriteCount();
          const invoke = operation === "issue" ? () => provider.issue(row.input as Parameters<Provider["issue"]>[0]) : () => provider.correct(row.input as Parameters<Provider["correct"]>[0]);
          const result = await invoke(); documentResult(result, row.input.identity, "write"); safe(result, subject);
          requireFact(same(result, row.expected), "write_fixture");
          if (!caps.operations[operation].supported) requireFact(result.kind === "unsupported", "declared_unsupported");
          if (operation === "correction" && caps.operations.correction.supported) {
            const request = row.input as Parameters<Provider["correct"]>[0];
            requireFact(request.identity.correctionRef.length > 0 && request.identity.parentProviderDocumentRef.length > 0
              && request.before.totalGrossMinor > 0 && Object.values(request.after).every(value => value === 0), "correction_before_after");
            const parent = fixtures.correction.find(fixture => fixture.expected.kind === "issued" && fixture.input.identity.correctionRef === request.identity.correctionRef);
            if (parent && parent.input.identity.parentProviderDocumentRef !== request.identity.parentProviderDocumentRef) requireFact((result.kind === "refused" || result.kind === "unknown") && subject.readWriteCount() === before, "parent_mismatch_no_write");
          }
          if (result.kind === "unsupported" || result.kind === "refused") requireFact(subject.readWriteCount() === before, "refused_write");
          if (row.replay) {
            requireFact(caps.operations.recovery.supported && result.kind === "issued", "replay_requires_issued");
            const count = subject.readWriteCount();
            const recovered = operation === "issue" ? await provider.issue({ ...row.input as Parameters<Provider["issue"]>[0], recoveryLookupRequired: true }) : await provider.correct({ ...row.input as Parameters<Provider["correct"]>[0], recoveryLookupRequired: true });
            documentResult(recovered, row.input.identity, "write"); safe(recovered, subject);
            requireFact(recovered.kind === "issued" && recovered.replayed === true && recovered.providerDocumentRef === result.providerDocumentRef && recovered.providerDocumentNumber === result.providerDocumentNumber, "recovery_identity");
            requireFact(subject.readWriteCount() === count, "recovery_no_second_write");
          }
          cases.push(operation + ":" + result.kind + (row.replay ? ":recovery" : ""));
        }
      }
      if (caps.operations.correction.supported) {
        const issued = fixtures.correction.find(row => row.expected.kind === "issued");
        requireFact(issued && fixtures.correction.some(row => row.input.recoveryLookupRequired
          && row.input.identity.correctionRef === issued.input.identity.correctionRef
          && row.input.identity.providerCreateIdentity === issued.input.identity.providerCreateIdentity
          && row.input.identity.parentProviderDocumentRef !== issued.input.identity.parentProviderDocumentRef
          && (row.expected.kind === "refused" || row.expected.kind === "unknown")), "correction_parent_fixture_required");
      }
      requireFact(fixtures.readback.length > 0 && fixtures.void.length > 0, "read_void_fixture_required");
      if (caps.operations.readback.supported) requireFact(fixtures.readback.some(row => row.expected.kind === "unknown") && fixtures.readback.some(row => row.expected.kind === "found"), "found_unknown_fixtures_required");
      if (caps.operations.exactAbsence.supported) requireFact(fixtures.readback.some(row => row.expected.kind === "absent"), "absence_fixture_required");
      for (const row of fixtures.readback) {
        const before = subject.readWriteCount(), result = await provider.read(row.input);
        documentResult(result, row.input, "read"); safe(result, subject); requireFact(same(result, row.expected), "read_fixture");
        requireFact(subject.readWriteCount() === before, "read_no_write");
        if (!caps.operations.readback.supported) requireFact(result.kind === "unsupported", "declared_unsupported");
        if (result.kind === "absent") requireFact(caps.operations.exactAbsence.supported, "absence_capability");
        cases.push("read:" + result.kind);
      }
      requireFact(caps.operations.remoteVoid.supported === false && caps.operations.remoteVoid.reason === "not_implemented", "remote_void_cut");
      for (const row of fixtures.void) {
        const before = subject.readWriteCount(), result = await provider.void(row.input);
        documentResult(result, row.input, "void"); safe(result, subject); requireFact(same(result, row.expected), "void_fixture");
        requireFact(subject.readWriteCount() === before, "void_refused_write");
        if (!caps.operations.remoteVoid.supported) requireFact(result.kind === "unsupported" && subject.readWriteCount() === before, "void_unsupported_before_write");
        cases.push("void:" + result.kind);
      }
      const settlementReceipts = new Map<string, string>();
      // Optional host-owned capabilities require their own fixtures when declared.
      for (const operation of ["artifact", "clearance", "settlement", "companyLookup"] as const) {
        const rows = fixtures[operation] ?? [];
        if (caps.operations[operation].supported) requireFact(subject.host && rows.some(row => ["found", "partial", "recorded", "observed"].includes(row.expected.kind) && !("observation" in row.expected && row.expected.observation.state === "unsupported")), "host_fixture_required");
        for (const row of rows) {
          requireFact(subject.host, "host_required"); const before = subject.readWriteCount();
          const result = operation === "artifact" ? await subject.host.artifacts.read(row.input as Parameters<InvoiceHostPorts["artifacts"]["read"]>[0])
            : operation === "clearance" ? await subject.host.clearance.observe(row.input as Parameters<InvoiceHostPorts["clearance"]["observe"]>[0])
              : operation === "settlement" ? await subject.host.settlement.record(row.input as Parameters<InvoiceHostPorts["settlement"]["record"]>[0])
                : await subject.host.registry.lookup(row.input as Parameters<InvoiceHostPorts["registry"]["lookup"]>[0]);
          hostResult(operation, row.input, result);
          safe(result, subject); requireFact(same(result, row.expected), "host_fixture");
          if (result.kind === "unsupported") requireFact(subject.readWriteCount() === before, "host_unsupported_write");
          if (operation !== "settlement") requireFact(subject.readWriteCount() === before, "host_read_no_write");
          if (operation === "settlement" && "kind" in result && result.kind === "recorded") {
            const input = row.input as Parameters<InvoiceHostPorts["settlement"]["record"]>[0];
            const item = JSON.stringify([input.providerRef, input.batchRef, input.itemRef]);
            requireFact(!settlementReceipts.has(result.settlementItemRef) || settlementReceipts.get(result.settlementItemRef) === item, "distinct_payout_items");
            settlementReceipts.set(result.settlementItemRef, item);
          }
          if (!caps.operations[operation].supported) requireFact((result.kind === "unsupported" || ("observation" in result && result.observation.state === "unsupported")) && subject.readWriteCount() === before, "host_unsupported_before_write");
          cases.push(operation);
        }
      }
      const row = { subjectId: subject.subjectId, providerRef: caps.providerRef, cases };
      safe(row, subject); evidence.push(row);
    }
    return { subjects: evidence };
  } catch (error) {
    if (error instanceof ContractFailure) throw error;
    throw new ContractFailure("INVOICE_CONFORMANCE:adapter_threw");
  }
}
