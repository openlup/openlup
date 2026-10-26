import { expect, it } from "vitest";
import ts from "typescript";
import { fileURLToPath } from "node:url";
import type { z } from "zod";
import type * as Runtime from "../../src/marketing/index.js";
import * as Contracts from "../../src/marketing/contracts/index.js";
import type * as Core from "@openlup/core/marketing/research";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
  ? ((<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2) ? true : false) : false;
type Assert<T extends true> = T;
export type MarketingContractEquality = [
  Assert<Equal<Contracts.AnalyticsCheckoutItem, Runtime.AnalyticsCheckoutItem>>,
  Assert<Equal<Contracts.AnalyticsPurchaseItem, Runtime.AnalyticsPurchaseItem>>,
  Assert<Equal<Contracts.AnalyticsCheckoutMode, Runtime.AnalyticsCheckoutMode>>,
  Assert<Equal<Contracts.AnalyticsPaymentWaitOutcome, Runtime.AnalyticsPaymentWaitOutcome>>,
  Assert<Equal<Contracts.AnalyticsEventMap, Runtime.AnalyticsEventMap>>,
  Assert<Equal<Contracts.AnalyticsEventName, Runtime.AnalyticsEventName>>,
  Assert<Equal<Contracts.AnalyticsSinkAttemptMask, Runtime.AnalyticsSinkAttemptMask>>,
  Assert<Equal<Contracts.AnalyticsSinkAdmission, Runtime.AnalyticsSinkAdmission>>,
  Assert<Equal<Contracts.AnalyticsCookieConsent, Runtime.AnalyticsCookieConsent>>,
  Assert<Equal<Contracts.AnalyticsBrowserWindow, Runtime.AnalyticsBrowserWindow>>,
  Assert<Equal<Contracts.AnalyticsDataLayerOptions, Runtime.AnalyticsDataLayerOptions>>,
  Assert<Equal<Contracts.AnalyticsRoutePolicyInput, Runtime.AnalyticsRoutePolicyInput>>,
  Assert<Equal<Contracts.PurchaseOrder, Runtime.PurchaseOrder>>,
  Assert<Equal<Contracts.PurchaseSuppressionReason, Runtime.PurchaseSuppressionReason>>,
  Assert<Equal<Contracts.MarketingHistoricalConsentCommand, Runtime.MarketingHistoricalConsentCommand>>,
  Assert<Equal<Contracts.MarketingHistoricalConsentState, Runtime.MarketingHistoricalConsentState>>,
  Assert<Equal<Contracts.MarketingHistoricalConsentResult, Runtime.MarketingHistoricalConsentResult>>,
  Assert<Equal<Contracts.AnalyticsStepName<"choose" | "confirm">, "choose" | "confirm">>,
  Assert<Equal<Runtime.AnalyticsEventMap<"choose" | "confirm">["configurator_step_view"]["step_name"], "choose" | "confirm">>,
  Assert<Equal<Contracts.PrelaunchAcquisitionListRequest, z.infer<typeof Runtime.prelaunchAcquisitionListRequestSchema>>>,
  Assert<Equal<Contracts.PrelaunchAcquisitionDetailRequest, z.infer<typeof Runtime.prelaunchAcquisitionDetailRequestSchema>>>,
  Assert<Equal<Contracts.PrelaunchAcquisitionLead, z.infer<typeof Runtime.prelaunchAcquisitionLeadSchema>>>,
  Assert<Equal<Contracts.PrelaunchAcquisitionListResponse, z.infer<typeof Runtime.prelaunchAcquisitionListResponseSchema>>>,
  Assert<Equal<Contracts.PrelaunchAcquisitionDetailResponse, z.infer<typeof Runtime.prelaunchAcquisitionDetailResponseSchema>>>,

  Assert<Equal<Contracts.AcquisitionOpaqueReference, z.infer<typeof Runtime.acquisitionOpaqueReferenceSchema>>>,
  Assert<Equal<Contracts.AcquisitionAddressReference, z.infer<typeof Runtime.acquisitionAddressReferenceSchema>>>,
  Assert<Equal<Contracts.AcquisitionCaseState, z.infer<typeof Runtime.acquisitionCaseStateSchema>>>,
  Assert<Equal<Contracts.AcquisitionCaseProjection, z.infer<typeof Runtime.acquisitionCaseProjectionSchema>>>,
  Assert<Equal<Contracts.AcquisitionCaseListRequest, z.infer<typeof Runtime.acquisitionCaseListRequestSchema>>>,
  Assert<Equal<Contracts.AcquisitionCaseListResponse, z.infer<typeof Runtime.acquisitionCaseListResponseSchema>>>,
  Assert<Equal<Contracts.AcquisitionCaseActiveCountResponse, z.infer<typeof Runtime.acquisitionCaseActiveCountResponseSchema>>>,
  Assert<Equal<Contracts.AcquisitionIdempotencyKey, z.infer<typeof Runtime.acquisitionIdempotencyKeySchema>>>,
  Assert<Equal<Contracts.AcquisitionSurveySubmit, z.infer<typeof Runtime.acquisitionSurveySubmitSchema>>>,
  Assert<Equal<Contracts.AcquisitionSurveyEvidence, z.infer<typeof Runtime.acquisitionSurveyEvidenceSchema>>>,
  Assert<Equal<Contracts.AcquisitionSurveySubmitResponse, z.infer<typeof Runtime.acquisitionSurveySubmitResponseSchema>>>,
  Assert<Equal<Contracts.AcquisitionSurveyListQuery, z.infer<typeof Runtime.acquisitionSurveyListQuerySchema>>>,
  Assert<Equal<Contracts.AcquisitionSurveyListResponse, z.infer<typeof Runtime.acquisitionSurveyListResponseSchema>>>,
  Assert<Equal<Contracts.AcquisitionNewsletterConsentEvent, z.infer<typeof Runtime.acquisitionNewsletterConsentEventSchema>>>,
  Assert<Equal<Contracts.AcquisitionNewsletterConsentResponse, z.infer<typeof Runtime.acquisitionNewsletterConsentResponseSchema>>>,
  Assert<Equal<Contracts.AcquisitionCaseFailureKind, "conflict" | "invalid" | "not_found" | "rate_limited" | "unavailable">>,
  Assert<Equal<Contracts.AcquisitionCaseResult<number>, { ok: true; value: number; replayed?: boolean } | { ok: false; error: { kind: Contracts.AcquisitionCaseFailureKind } }>>,
  Assert<Equal<Contracts.AcquisitionCaseListQuery, { actorRef: string; scope: "public_tester_application"; cursor?: string; limit: number }>>,
  Assert<Equal<Contracts.AcquisitionCaseGetQuery, { actorRef: string; scope: "public_tester_application"; caseRef: string }>>,
  Assert<Equal<Contracts.AcquisitionCasePort, ExpectedCasePort>>,
  Assert<Equal<Contracts.AcquisitionEvidenceFailure, "invalid" | "not_found" | "conflict" | "unavailable">>,
  Assert<Equal<Contracts.AcquisitionEvidenceResult<number>, { ok: true; value: number } | { ok: false; error: { kind: Contracts.AcquisitionEvidenceFailure } }>>,
  Assert<Equal<Contracts.AcquisitionEvidencePort, ExpectedEvidencePort>>,
  Assert<Equal<keyof Contracts.AcquisitionCasePort, "list" | "get" | "activeCount" | "close">>,
  Assert<Equal<Runtime.AcquisitionCasePort, Contracts.AcquisitionCasePort>>,
  Assert<Equal<Runtime.AcquisitionEvidencePort, Contracts.AcquisitionEvidencePort>>,
  Assert<Equal<Contracts.MarketingResearchJson, Core.MarketingResearchJson>>,
  Assert<Equal<Contracts.ResearchSurveyType, Core.ResearchSurveyType>>,
  Assert<Equal<Contracts.AdminSurveyResponsesRequest, Core.AdminSurveyResponsesRequest>>,
  Assert<Equal<Contracts.AdminSurveyResponseRow, Core.AdminSurveyResponseRow>>,
  Assert<Equal<Contracts.AdminSurveyResponsesResponse, Core.AdminSurveyResponsesResponse>>,
  Assert<Equal<Contracts.ResearchSurveySubmitRequest, Core.ResearchSurveySubmitRequest>>,
  Assert<Equal<Contracts.ResearchSurveySubmitResponse, Core.ResearchSurveySubmitResponse>>,
  Assert<Equal<Contracts.MarketingResearchSurveyResponsesReadPort, Core.MarketingResearchSurveyResponsesReadPort>>,
  Assert<Equal<Contracts.MarketingResearchSurveyRequestHeaders, Core.MarketingResearchSurveyRequestHeaders>>,
  Assert<Equal<Contracts.MarketingResearchSurveySubmitPort, Core.MarketingResearchSurveySubmitPort>>,
];

it("executes exact type equality with the TypeScript checker and exposes no runtime contracts", () => {
  expect(Object.keys(Contracts)).toEqual([]);
  const file = fileURLToPath(import.meta.url);
  const program = ts.createProgram([file], { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true, skipLibCheck: true, noEmit: true,
    esModuleInterop: true, allowImportingTsExtensions: true, types: ["node"] });
  expect(ts.formatDiagnosticsWithColorAndContext(ts.getPreEmitDiagnostics(program), {
    getCanonicalFileName: path => path, getCurrentDirectory: () => process.cwd(), getNewLine: () => "\n",
  })).toBe("");
}, 30_000);

interface ExpectedCasePort {
  list(query: Contracts.AcquisitionCaseListQuery): Promise<Contracts.AcquisitionCaseResult<Contracts.AcquisitionCaseListResponse>>;
  get(query: Contracts.AcquisitionCaseGetQuery): Promise<Contracts.AcquisitionCaseResult<Contracts.AcquisitionCaseProjection>>;
  activeCount(scope: "public_tester_application"): Promise<Contracts.AcquisitionCaseResult<number>>;
  close(): Promise<void>;
}
interface ExpectedEvidencePort {
  submitSurvey(input: Contracts.AcquisitionSurveySubmit & { idempotencyKey: string }): Promise<Contracts.AcquisitionEvidenceResult<Contracts.AcquisitionSurveySubmitResponse>>;
  listSurveys(input: Contracts.AcquisitionSurveyListQuery & { actorReference: string }): Promise<Contracts.AcquisitionEvidenceResult<Contracts.AcquisitionSurveyListResponse>>;
  applyNewsletterConsent(input: Contracts.AcquisitionNewsletterConsentEvent): Promise<Contracts.AcquisitionEvidenceResult<Contracts.AcquisitionNewsletterConsentResponse>>;
  close(): Promise<void>;
}

// New seam 7: literal host vocabulary survives both contracts and the emitter.
function hostStepWitness(analytics: ReturnType<typeof import("../../src/marketing/index.js").createAnalyticsDataLayer<"choose" | "confirm">>) {
  analytics.pushAnalyticsEvent("configurator_step_view", { step_number: 1, step_name: "choose" });
  // @ts-expect-error host steps stay closed to the supplied literal union
  analytics.pushAnalyticsEvent("configurator_step_view", { step_number: 1, step_name: "other" });
}
export type HostStepWitness = typeof hostStepWitness;
