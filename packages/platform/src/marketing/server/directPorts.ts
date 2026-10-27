import type { HttpRequest, HttpResponse } from "../../http/index.js";
import type { BffResponder } from "../../bff/index.js";
import type { AcquisitionCaseHandlers } from "./acquisitionCaseHandlers.js";
import type { AcquisitionEvidencePort } from "../contracts/index.js";

export interface AcquisitionCaseReadBinding {
  handlers: Pick<AcquisitionCaseHandlers, "list" | "get" | "activeCount">;
}
export type AcquisitionCaseBindingResolver = () => Promise<AcquisitionCaseReadBinding | null>;
export type AcquisitionEvidenceBindingResolver = () => Promise<AcquisitionEvidencePort | null>;
export type AcquisitionAuthorize = (req: HttpRequest, res: HttpResponse) => Promise<string | null>;
export interface AcquisitionCaseDirectDeps {
  respond: BffResponder;
  authorize: AcquisitionAuthorize;
  resolveBinding: AcquisitionCaseBindingResolver;
  isDirect: () => boolean;
}
export interface PrelaunchAcquisitionDirectDeps {
  respond: BffResponder;
  authorize: AcquisitionAuthorize;
  resolveBinding: AcquisitionCaseBindingResolver;
}
export interface AcquisitionEvidenceDirectDeps {
  respond: BffResponder;
  authorize: AcquisitionAuthorize;
  resolveBinding: AcquisitionEvidenceBindingResolver;
}
