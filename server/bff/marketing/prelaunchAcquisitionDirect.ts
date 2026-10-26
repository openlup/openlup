import { PRELAUNCH_ACQUISITION_VIEW, prelaunchAcquisitionDetailRequestSchema } from "@openlup/platform/marketing";
import { createPrelaunchAcquisitionListHandler as createList, createPrelaunchAcquisitionDetailHandler as createDetail } from "@openlup/platform/marketing/server";
import { bffResponder } from "../../_lib/bff/response.js";
import type * as HttpTypes from "../../_lib/types/vercel.js";
import { getBundleDescriptor, resolveBundleId } from "../../domains/platform-runtime/platformKernel.js";
import { authorizeAcquisitionCaseAdmin } from "../clients/acquisitionCaseDirect.js";
import {
  resolveAcquisitionCaseRuntimeBinding,
  type AcquisitionCaseRuntimeBinding,
} from "../../runtime/clients/acquisitionCaseBinding.js";

type Env = Record<string, string | undefined>;
type HttpRequest = HttpTypes.VercelRequest;
type HttpResponse = HttpTypes.VercelResponse;
type BindingResolver = () => Promise<AcquisitionCaseRuntimeBinding | null>;
type Authorize = (req: HttpRequest, res: HttpResponse) => Promise<string | null>;

interface Options {
  env?: Env;
  resolveBinding?: BindingResolver;
  authorize?: Authorize;
}

export function isDirectPrelaunchAcquisitionBundle(env: Env = process.env): boolean {
  return getBundleDescriptor(resolveBundleId(env)).capabilities.data === "postgres";
}

export function isPrelaunchAcquisitionListView(req: HttpRequest): boolean {
  return first(req.query.view) === PRELAUNCH_ACQUISITION_VIEW;
}

export function isPrelaunchAcquisitionSourceRef(req: HttpRequest): boolean {
  return prelaunchAcquisitionDetailRequestSchema.safeParse({ sourceRef: first(req.query.sourceRef) }).success;
}

function dependencies(options: Options) {
  const env = options.env ?? process.env;
  return {
    respond: bffResponder,
    authorize: (req: HttpRequest, res: HttpResponse) => {
      const override = options.authorize;
      return override ? override(req, res) : authorizeAcquisitionCaseAdmin(req, res, env);
    },
    resolveBinding: () => (options.resolveBinding ?? (() => resolveAcquisitionCaseRuntimeBinding(env)))(),
  };
}
export function createPrelaunchAcquisitionListHandler(options: Options = {}) { return createList(dependencies(options)); }
export function createPrelaunchAcquisitionDetailHandler(options: Options = {}) { return createDetail(dependencies(options)); }
function first(value: string | string[] | undefined): string | undefined { return Array.isArray(value) ? value[0] : value; }
