import type { BffResponder } from "../../bff/index.js";
import type { HttpRequest } from "../../http/index.js";
import type { RiskAdminReadPort, RiskAdminWritePort } from "../../risk/contracts/index.js";
import type { OrderPaidRiskAssessmentPort } from "./orderPaidRiskPort.js";
import {
  createAdminRiskCasesListHandler,
  createAdminRiskCaseDetailHandler,
  createAdminRiskCaseDecisionHandler,
  type RiskAdminAuthorization,
} from "./riskAdminCasesHandler.js";

/** Bind existing callables only. The commerce registry owns the paid executor. */
export function createRiskBindings(input: {
  respond: BffResponder;
  authorizeAdmin(req: HttpRequest): Promise<RiskAdminAuthorization>;
  adminPort: RiskAdminReadPort & RiskAdminWritePort;
  assessmentPort: OrderPaidRiskAssessmentPort;
  mutationsEnabled(): boolean;
}) {
  const admin = { respond: input.respond, authorizeAdmin: input.authorizeAdmin, riskPort: input.adminPort };
  return {
    list: createAdminRiskCasesListHandler(admin),
    detail: createAdminRiskCaseDetailHandler(admin),
    decision: createAdminRiskCaseDecisionHandler({ ...admin, mutationsEnabled: input.mutationsEnabled }),
    outboxRisk: { riskPort: input.assessmentPort, riskEnabled: true },
  };
}
