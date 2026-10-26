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
